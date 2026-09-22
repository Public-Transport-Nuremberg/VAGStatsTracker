use crate::{catalog::StopInfo, AppState, Loaded};
use chrono::{DateTime, Datelike, NaiveDate, TimeZone, Timelike, Utc};
use csa::Journey;
use history::{CancellationStats, DelayStats, TransferStatsKey};
use reliability::{Assessment, LookupRequest};
use serde_json::{json, Value};

fn summary(stats: Option<&DelayStats>) -> Value {
    match stats {
        None => Value::Null,
        Some(s) => json!({"samples":s.samples,"data_quality":s.data_quality,
        "mean_seconds":s.mean_seconds,"p50_seconds":s.p50_seconds,"p80_seconds":s.p80_seconds,
        "p90_seconds":s.p90_seconds,"p95_seconds":s.p95_seconds,
        "probability_over_60s":s.probability_60s,"probability_over_180s":s.probability_180s,
        "probability_over_300s":s.probability_300s,"probability_over_600s":s.probability_600s}),
    }
}
fn empty() -> Assessment {
    Assessment {
        statistics_available: false,
        arrival: None,
        departure: None,
        cancellation: None,
        data_quality: None,
        insufficient_samples: 0,
        history_rejected: false,
    }
}
fn at(timestamp: i64) -> DateTime<Utc> {
    DateTime::from_timestamp(timestamp, 0).expect("CSA timestamp validated by chrono")
}

fn service_time(loaded: &Loaded, date: NaiveDate, seconds: u32) -> Option<DateTime<chrono_tz::Tz>> {
    loaded
        .timezone
        .from_local_datetime(&date.and_hms_opt(12, 0, 0)?)
        .single()
        .map(|noon| noon - chrono::Duration::hours(12) + chrono::Duration::seconds(seconds.into()))
}

fn intermediate_stops(loaded: &Loaded, leg: &csa::Leg, trip_index: u32) -> Vec<Value> {
    let Some(service_date) = leg.service_date else {
        return Vec::new();
    };
    let connections = &loaded.trip_connections[trip_index as usize];
    let start = connections.iter().position(|index| {
        let connection = &loaded.data.connections[*index as usize];
        connection.from == leg.from
            && service_time(loaded, service_date, connection.departure)
                .is_some_and(|time| time.timestamp() == leg.departure)
    });
    let Some(start) = start else {
        return Vec::new();
    };

    let mut stops = Vec::new();
    for pair in connections[start..].windows(2) {
        let incoming = &loaded.data.connections[pair[0] as usize];
        if incoming.to == leg.to
            && service_time(loaded, service_date, incoming.arrival)
                .is_some_and(|time| time.timestamp() == leg.arrival)
        {
            break;
        }
        let outgoing = &loaded.data.connections[pair[1] as usize];
        if outgoing.from != incoming.to {
            break;
        }
        let Some(arrival) = service_time(loaded, service_date, incoming.arrival) else {
            continue;
        };
        let Some(departure) = service_time(loaded, service_date, outgoing.departure) else {
            continue;
        };
        stops.push(json!({
            "stop": StopInfo::from(&loaded.data.stops[incoming.to as usize]),
            "scheduled_arrival": arrival,
            "scheduled_departure": departure,
        }));
    }
    stops
}

struct NextService {
    departure: DateTime<chrono_tz::Tz>,
    arrival: Option<DateTime<chrono_tz::Tz>>,
    headway_seconds: u32,
    cadence_seconds: Option<u32>,
}

fn next_same_service(loaded: &Loaded, leg: &csa::Leg, trip_index: u32) -> Option<NextService> {
    let service_date = leg.service_date?;
    let current_trip = &loaded.data.trips[trip_index as usize];
    let current_route = &loaded.data.routes[current_trip.route as usize];
    let current_departure = loaded.departures_by_stop[leg.from as usize]
        .iter()
        .map(|index| &loaded.data.connections[*index as usize])
        .find(|connection| {
            connection.trip == trip_index
                && service_time(loaded, service_date, connection.departure)
                    .is_some_and(|time| time.timestamp() == leg.departure)
        })?
        .departure;
    let active = loaded.data.active_services(service_date);
    let line = history::normalize(&current_route.short_name);
    let direction = history::normalize(current_trip.headsign.as_deref().unwrap_or(""));
    let mut departures: Vec<(u32, u32)> = loaded.departures_by_stop[leg.from as usize]
        .iter()
        .map(|index| (*index, &loaded.data.connections[*index as usize]))
        .filter(|(_, connection)| {
            connection.pickup_allowed
                && connection.departure > current_departure
                && connection.departure <= current_departure.saturating_add(2 * 60 * 60)
        })
        .filter(|(_, connection)| {
            let trip = &loaded.data.trips[connection.trip as usize];
            let route = &loaded.data.routes[trip.route as usize];
            active
                .get(trip.service_id as usize)
                .copied()
                .unwrap_or(false)
                && route.product == current_route.product
                && history::normalize(&route.short_name) == line
                && history::normalize(trip.headsign.as_deref().unwrap_or("")) == direction
        })
        .map(|(index, connection)| (connection.departure, index))
        .collect();
    departures.sort_unstable_by_key(|(departure, _)| *departure);
    departures.dedup_by_key(|(departure, _)| *departure);
    let (next, next_connection_index) = *departures.first()?;
    let headway = next.saturating_sub(current_departure);
    let cadence = departures.get(1).and_then(|(following, _)| {
        let next_gap = following.saturating_sub(next);
        (next_gap.abs_diff(headway) <= 2 * 60).then_some((headway + next_gap) / 2)
    });
    let next_connection = &loaded.data.connections[next_connection_index as usize];
    let arrival = loaded.trip_connections[next_connection.trip as usize]
        .iter()
        .skip_while(|index| **index != next_connection_index)
        .map(|index| &loaded.data.connections[*index as usize])
        .find(|connection| connection.to == leg.to)
        .and_then(|connection| service_time(loaded, service_date, connection.arrival));
    Some(NextService {
        departure: service_time(loaded, service_date, next)?,
        arrival,
        headway_seconds: headway,
        cadence_seconds: cadence,
    })
}

pub fn score(
    state: &AppState,
    loaded: &Loaded,
    journey: &Journey,
    route_date: NaiveDate,
    stats: Option<&reliability::RuntimeStats>,
    history_rejected: bool,
) -> Value {
    let config = &state.reliability_config;
    let mut legs = Vec::new();
    let mut flags = Vec::new();
    let mut transfers = Vec::new();
    let mut transfer_outputs = Vec::new();
    let mut cancellations: Vec<Option<CancellationStats>> = Vec::new();
    let mut previous: Option<(usize, Assessment, LookupRequest)> = None;
    let mut physical_walk = 0u32;
    // Even later legs may not use information unavailable at the journey's start.
    let stats = stats.filter(|s| s.history_until < route_date);
    for (index, leg) in journey.legs.iter().enumerate() {
        let from = StopInfo::from(&loaded.data.stops[leg.from as usize]);
        let to = StopInfo::from(&loaded.data.stops[leg.to as usize]);
        let Some(trip_index) = leg.trip else {
            physical_walk = physical_walk.saturating_add((leg.arrival - leg.departure) as u32);
            legs.push(json!({"type":"walk","from":from,"to":to,
                "scheduled_departure":at(leg.departure).with_timezone(&loaded.timezone),
                "scheduled_arrival":at(leg.arrival).with_timezone(&loaded.timezone),
                "duration_seconds":leg.arrival-leg.departure,"distance_meters":null}));
            continue;
        };
        let trip = &loaded.data.trips[trip_index as usize];
        let route = &loaded.data.routes[trip.route as usize];
        let intermediate_stops = intermediate_stops(loaded, leg, trip_index);
        let terminal = loaded.trip_terminals[trip_index as usize]
            .map(|i| loaded.data.stops[i as usize].name.clone());
        let request = LookupRequest {
            product: route.product,
            line: route.short_name.clone(),
            stop: loaded.data.stops[leg.from as usize]
                .historical_vgn_id
                .unwrap_or(i32::MIN),
            direction: trip.headsign.clone(),
            headsign: terminal,
            scheduled: at(leg.departure),
        };
        let arrival_request = LookupRequest {
            stop: loaded.data.stops[leg.to as usize]
                .historical_vgn_id
                .unwrap_or(i32::MIN),
            scheduled: at(leg.arrival),
            ..request.clone()
        };
        // Cancellation rows are bucketed by the trip's first planned departure,
        // not by an intermediate boarding stop's later departure.
        let first_departure = leg
            .service_date
            .zip(loaded.trip_departures[trip_index as usize])
            .and_then(|(date, seconds)| {
                loaded
                    .timezone
                    .from_local_datetime(&date.and_hms_opt(12, 0, 0)?)
                    .single()
                    .map(|noon| {
                        (noon - chrono::Duration::hours(12)
                            + chrono::Duration::seconds(seconds as i64))
                        .with_timezone(&Utc)
                    })
            })
            .unwrap_or(request.scheduled);
        let cancellation_request = LookupRequest {
            scheduled: first_departure,
            ..request.clone()
        };
        let (mut departure, mut arrival, cancellation) = if let Some(s) = stats {
            (
                s.assess_leg_with_config(&request, config),
                s.assess_leg_with_config(&arrival_request, config),
                s.assess_leg_with_config(&cancellation_request, config),
            )
        } else {
            (empty(), empty(), empty())
        };
        if loaded.data.stops[leg.from as usize]
            .historical_vgn_id
            .is_none()
        {
            departure.departure = None;
        }
        if loaded.data.stops[leg.to as usize]
            .historical_vgn_id
            .is_none()
        {
            arrival.arrival = None;
        }
        let assessment = Assessment {
            statistics_available: arrival.arrival.is_some()
                || departure.departure.is_some()
                || cancellation.cancellation.is_some(),
            data_quality: arrival
                .arrival
                .as_ref()
                .map(|s| s.data_quality)
                .or_else(|| departure.departure.as_ref().map(|s| s.data_quality))
                .or_else(|| cancellation.cancellation.as_ref().map(|s| s.data_quality)),
            arrival: arrival.arrival,
            departure: departure.departure,
            cancellation: cancellation.cancellation,
            insufficient_samples: arrival
                .insufficient_samples
                .max(departure.insufficient_samples)
                .max(cancellation.insufficient_samples),
            history_rejected: arrival.history_rejected
                || departure.history_rejected
                || cancellation.history_rejected
                || history_rejected,
        };
        state.metrics.lookup.inc_by(3);
        if assessment.cancellation.is_none() {
            state.metrics.lookup_miss.inc();
        }
        if assessment.arrival.is_none() {
            state.metrics.lookup_miss.inc();
        }
        if assessment.departure.is_none() {
            state.metrics.lookup_miss.inc();
        }
        let leg_flags = reliability::leg_flags(&assessment, config);
        flags.extend(leg_flags.clone());
        if let Some((incoming_index, incoming, incoming_request)) = &previous {
            let incoming_leg = &journey.legs[*incoming_index];
            let scheduled = (leg.departure - incoming_leg.arrival).max(0) as u32;
            let required = leg.transfer_seconds.max(physical_walk);
            let local = request.scheduled.with_timezone(&loaded.timezone);
            let empirical_key = TransferStatsKey {
                stop: arrival_stop(loaded, incoming_leg.to),
                incoming_product: incoming_request.product,
                incoming_line: history::normalize(&incoming_request.line),
                incoming_direction: history::normalize(
                    incoming_request.direction.as_deref().unwrap_or(""),
                ),
                outgoing_product: request.product,
                outgoing_line: history::normalize(&request.line),
                outgoing_direction: history::normalize(request.direction.as_deref().unwrap_or("")),
                weekday: local.weekday().number_from_monday() as u8,
                time_bucket: ((local.hour() * 60 + local.minute()) / 15) as u8,
            };
            let empirical = stats.and_then(|s| s.empirical_transfer(&empirical_key, route_date));
            let transfer = reliability::transfer_with_empirical(
                incoming.arrival.as_ref(),
                assessment.departure.as_ref(),
                empirical,
                scheduled,
                required,
                config,
            );
            let transfer_flags = reliability::transfer_flags(&transfer, config);
            flags.extend(transfer_flags.clone());
            let next_service = next_same_service(loaded, leg, trip_index).map(|next_service| {
                let next_request = LookupRequest {
                    scheduled: next_service.departure.with_timezone(&Utc),
                    ..request.clone()
                };
                let next_departure_assessment = stats
                    .map(|runtime| runtime.assess_leg_with_config(&next_request, config))
                    .unwrap_or_else(empty);
                state.metrics.lookup.inc();
                if next_departure_assessment.departure.is_none() {
                    state.metrics.lookup_miss.inc();
                }
                let next_local = next_request.scheduled.with_timezone(&loaded.timezone);
                let next_empirical_key = TransferStatsKey {
                    time_bucket: ((next_local.hour() * 60 + next_local.minute()) / 15) as u8,
                    ..empirical_key.clone()
                };
                let next_empirical = stats.and_then(|runtime| {
                    runtime.empirical_transfer(&next_empirical_key, route_date)
                });
                let next_transfer = reliability::transfer_with_empirical(
                    incoming.arrival.as_ref(),
                    next_departure_assessment.departure.as_ref(),
                    next_empirical,
                    scheduled.saturating_add(next_service.headway_seconds),
                    required,
                    config,
                );
                let trailing_walk_seconds =
                    journey.legs[index + 1..]
                        .iter()
                        .try_fold(0i64, |total, suffix| {
                            suffix.trip.is_none().then_some(
                                total.saturating_add((suffix.arrival - suffix.departure).max(0)),
                            )
                        });
                let fallback_destination_arrival = trailing_walk_seconds.and_then(|seconds| {
                    next_service
                        .arrival
                        .map(|arrival| arrival + chrono::Duration::seconds(seconds))
                });
                let destination_stop = journey
                    .legs
                    .last()
                    .map(|last| StopInfo::from(&loaded.data.stops[last.to as usize]));
                json!({
                    "line": route.short_name,
                    "product": product_name(route.product),
                    "from": StopInfo::from(&loaded.data.stops[leg.from as usize]),
                    "to": StopInfo::from(&loaded.data.stops[leg.to as usize]),
                    "scheduled_departure": next_service.departure,
                    "scheduled_arrival": next_service.arrival,
                    "headway_seconds": next_service.headway_seconds,
                    "cadence_seconds": next_service.cadence_seconds,
                    "success_probability": next_transfer.success_probability,
                    "samples": next_transfer.samples,
                    "model": next_transfer.model,
                    "fallback_destination": destination_stop,
                    "fallback_destination_arrival": fallback_destination_arrival,
                })
            });
            let mut value =
                serde_json::to_value(&transfer).expect("finite validated transfer statistics");
            value["walking_seconds"] = json!(physical_walk);
            value["minimum_transfer_seconds"] = json!(required);
            value["incoming_leg"] = json!(incoming_index);
            value["outgoing_leg"] = json!(index);
            value["flags"] = json!(transfer_flags);
            value["next_service"] = next_service.unwrap_or(Value::Null);
            transfer_outputs.push(value);
            transfers.push(transfer);
        }
        let mut from = from;
        from.statistics_available = assessment.departure.is_some();
        let mut to = to;
        to.statistics_available = assessment.arrival.is_some();
        legs.push(json!({"type":"transit","trip_id":trip.gtfs_id,"route_id":route.gtfs_id,
            "line":route.short_name,"product":product_name(route.product),"from":from,"to":to,
            "scheduled_departure":at(leg.departure).with_timezone(&loaded.timezone),
            "scheduled_arrival":at(leg.arrival).with_timezone(&loaded.timezone),
            "service_date":leg.service_date,"direction":trip.headsign,
            "intermediate_stops":intermediate_stops,
            "schedule_has_interpolated_times":loaded.trip_interpolated[trip_index as usize],
            "reliability":{"statistics_available":assessment.statistics_available,"data_quality":assessment.data_quality,
                "arrival":summary(assessment.arrival.as_ref()),"departure":summary(assessment.departure.as_ref()),
                "cancellation_probability":assessment.cancellation.as_ref().map(|s|s.probability),
                "cancellation_samples":assessment.cancellation.as_ref().map(|s|s.samples),"history_rejected":assessment.history_rejected},
            "flags":leg_flags}));
        cancellations.push(assessment.cancellation.clone());
        previous = Some((index, assessment, request));
        physical_walk = 0;
    }
    json!({"scheduled_departure":at(journey.departure).with_timezone(&loaded.timezone),
        "scheduled_arrival":at(journey.arrival).with_timezone(&loaded.timezone),
        "duration_seconds":journey.arrival-journey.departure,"transfers":transfers.len(),
        "reliability":reliability::journey_reliability(&transfers,&cancellations),
        "transfer_reliability":transfer_outputs,"flags":flags,"legs":legs})
}
fn arrival_stop(loaded: &Loaded, stop: u32) -> i32 {
    loaded.data.stops[stop as usize]
        .historical_vgn_id
        .unwrap_or(i32::MIN)
}
pub fn product_name(product: u8) -> &'static str {
    match product {
        1 => "bus",
        2 => "ubahn",
        3 => "tram",
        4 => "sbahn",
        5 => "rbahn",
        _ => "unknown",
    }
}
