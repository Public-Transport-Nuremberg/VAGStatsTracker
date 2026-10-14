module.exports = {
    "LiveGPS": {
        "Vehicles": {
            "Metric": "LiveGPS_Vehicles",
            "ProductMetric": "LiveGPS_VehiclesByProduct",
            "Type": "gauge",
            "Help": "The current number of VMI vehicle markers available in GPS map mode",
        },
        "IdentifiedVehicles": {
            "Metric": "LiveGPS_IdentifiedVehicles",
            "ProductMetric": "LiveGPS_IdentifiedVehiclesByProduct",
            "Type": "gauge",
            "Help": "The current number of GPS map vehicles with a vehicle identifier",
        },
        "UnidentifiedVehicles": {
            "Metric": "LiveGPS_UnidentifiedVehicles",
            "ProductMetric": "LiveGPS_UnidentifiedVehiclesByProduct",
            "Type": "gauge",
            "Help": "The current number of GPS map objects without a vehicle identifier",
        },
    },
    "LiveMap": {
        "Trips": {
            "Metric": "LiveMap_Trips",
            "ProductMetric": "LiveMap_TripsByProduct",
            "Type": "gauge",
            "Help": "The number of trips processed by the last successful live map position refresh",
        },
        "EstimatedGPSTrips": {
            "Metric": "LiveMap_EstimatedGPSTrips",
            "ProductMetric": "LiveMap_EstimatedGPSTripsByProduct",
            "Type": "gauge",
            "Help": "The number of live map trips with an estimated GPS position",
        },
        "StopFallbackTrips": {
            "Metric": "LiveMap_StopFallbackTrips",
            "ProductMetric": "LiveMap_StopFallbackTripsByProduct",
            "Type": "gauge",
            "Help": "The number of live map trips using their current stop as a position fallback",
        },
        "MissingPositionTrips": {
            "Metric": "LiveMap_MissingPositionTrips",
            "ProductMetric": "LiveMap_MissingPositionTripsByProduct",
            "Type": "gauge",
            "Help": "The number of live map trips without a valid Redis GEO position",
        },
        "PositionsUpdated": {
            "Metric": "LiveMap_PositionsUpdated",
            "Type": "gauge",
            "Help": "The number of Redis GEO positions updated by the last successful live map refresh",
        },
        "LastRefreshTimestamp": {
            "Metric": "LiveMap_LastRefreshTimestamp",
            "Type": "gauge",
            "Help": "The Unix timestamp in seconds of the last successful live map position refresh",
        },
        "RefreshDurationMilliseconds": {
            "Metric": "LiveMap_RefreshDurationMilliseconds",
            "Type": "gauge",
            "Help": "The duration in milliseconds of the last successful live map position refresh",
        },
    },
    "Keys": {
        "allMetricKeys":{
            "Metric": "AmountAllMetricKeysx",
            "Type": "gauge",
            "Help": "The amount of all metric keys",
        },
        "allMetricListKeys":{
            "Metric": "AmountAllMetricListKeys",
            "Type": "gauge",
            "Help": "The amount of all metric list keys",
        },
        "allErrorListKeys":{
            "Metric": "AmountAllErrorListKeys",
            "Type": "gauge",
            "Help": "The amount of all error list keys",
        },
        "allTripKeys":{
            "Metric": "AmountAllTripKeys",
            "Type": "gauge",
            "Help": "The amount of all trip keys",
        }
    },
    "Metric": {
        "LiveGPS.RequestDurationMilliseconds": {
            "Metric": "LiveGPS_RequestDurationMilliseconds",
            "Type": "gauge",
            "Help": "The duration in milliseconds of the latest VMI getVehicles attempt, including errors and watchdog timeouts",
        },
        "LiveGPS.LastRequestTimestamp": {
            "Metric": "LiveGPS_LastRequestTimestamp",
            "Type": "gauge",
            "Help": "The Unix timestamp in seconds when the latest measured VMI getVehicles attempt finished",
        },
        "TotalTripsTracked.UBahn": {
            "Metric": "TotalTripsTracked_UBahn",
            "Type": "gauge",
            "Help": "The total number of UBahn trips currently tracked",
        },
        "TotalTripsTracked.Bus": {
            "Metric": "TotalTripsTracked_Bus",
            "Type": "gauge",
            "Help": "The total number of Bus trips currently tracked",
        },
        "TotalTripsTracked.Tram": {
            "Metric": "TotalTripsTracked_Tram",
            "Type": "gauge",
            "Help": "The total number of Tram trips currently tracked",
        },
        "TotalTripsActive.UBahn": {
            "Metric": "TotalTripsActive_UBahn",
            "Type": "gauge",
            "Help": "The total number of UBahn trips currently active",
        },
        "TotalTripsActive.Bus": {
            "Metric": "TotalTripsActive_Bus",
            "Type": "gauge",
            "Help": "The total number of Bus trips currently active",
        },
        "TotalTripsActive.Tram": {
            "Metric": "TotalTripsActive_Tram",
            "Type": "gauge",
            "Help": "The total number of Tram trips currently active",
        },
        "QueuedTotalTrips.Failed": {
            "Metric": "QueuedTotalTrips_Failed",
            "Type": "gauge",
            "Help": "The current number of failed trips in queue",
        },
        "QueuedTotalTrips.Active": {
            "Metric": "QueuedTotalTrips_Active",
            "Type": "gauge",
            "Help": "The current number of active trips in queue",
        },
        "QueuedTotalTrips.Delayed": {
            "Metric": "QueuedTotalTrips_Delayed",
            "Type": "gauge",
            "Help": "The current number of delayed trips in queue",
        },
        "QueuedTotalTrips.Completed": {
            "Metric": "QueuedTotalTrips_Completed",
            "Type": "gauge",
            "Help": "The current number of completed trips in queue",
        },
        "DepartureDiscovery.TripsResolved": {
            "Metric": "DepartureDiscovery_TripsResolved",
            "Type": "gauge",
            "Help": "The number of trips resolved by departure discovery",
        },
        "DepartureDiscovery.Candidates": {
            "Metric": "DepartureDiscovery_Candidates",
            "Type": "gauge",
            "Help": "The number of stops eligible for departure discovery",
        },
        "DepartureDiscovery.KnownTripStops": {
            "Metric": "DepartureDiscovery_KnownTripStops",
            "Type": "gauge",
            "Help": "The number of stops learned from the primary trips API",
        },
        "DepartureDiscovery.TripsFound": {
            "Metric": "DepartureDiscovery_TripsFound",
            "Type": "gauge",
            "Help": "The number of trips found by departure discovery",
        }
    },
    "MetricList": {
        "Trips.RequestTime": {
            "rate": {
                "Metric": "TripsRequestTimeRate",
                "Type": "gauge",
                "Help": "The rate of requests per second",
            },
            "averageResponseTime": {
                "Metric": "TripsRequestTimeAverage",
                "Type": "gauge",
                "Help": "The average response time of requests",
            }
        },
        "Trip.RequestTime": {
            "rate": {
                "Metric": "TripRequestTimeRate",
                "Type": "gauge",
                "Help": "The rate of requests per second",
            },
            "averageResponseTime": {
                "Metric": "TripRequestTimeAverage",
                "Type": "gauge",
                "Help": "The average response time of requests",
            }
        },
        "Departure.RequestTime": {
            "rate": {
                "Metric": "DepartureRequestTimeRate",
                "Type": "gauge",
                "Help": "The rate of requests per second",
            },
            "averageResponseTime": {
                "Metric": "DepartureRequestTimeAverage",
                "Type": "gauge",
                "Help": "The average response time of requests",
            }
        },
        "DepartureDiscovery.RequestTime": {
            "rate": {
                "Metric": "DepartureDiscoveryRequestTimeRate",
                "Type": "gauge",
                "Help": "The rate of departure discovery requests per second",
            },
            "averageResponseTime": {
                "Metric": "DepartureDiscoveryRequestTimeAverage",
                "Type": "gauge",
                "Help": "The average response time of departure discovery requests",
            }
        },
        "DepartureDiscovery.Trip.RequestTime": {
            "rate": {
                "Metric": "DepartureDiscoveryTripRequestTimeRate",
                "Type": "gauge",
                "Help": "The rate of trip requests made by departure discovery per second",
            },
            "averageResponseTime": {
                "Metric": "DepartureDiscoveryTripRequestTimeAverage",
                "Type": "gauge",
                "Help": "The average response time of trip requests made by departure discovery",
            }
        },
    },
    "ErrorList": {
        "Trips.Statuscode": {
            "ENOTFOUND": {
                "Metric": "TripsStatuscode_ENOTFOUND",
                "Type": "gauge",
                "Help": "The amount of times the status code was returned",
            },
            "ECONNREFUSED": {
                "Metric": "TripsStatuscode_ECONNREFUSED",
                "Type": "gauge",
                "Help": "The amount of times the status code was returned",
            },
            "ETIMEDOUT": {
                "Metric": "TripsStatuscode_ETIMEDOUT",
                "Type": "gauge",
                "Help": "The amount of times the status code was returned",
            },
            "ECONNRESET": {
                "Metric": "TripsStatuscode_ECONNRESET",
                "Type": "gauge",
                "Help": "The amount of times the status code was returned",
            },
            "EAI_AGAIN": {
                "Metric": "TripsStatuscode_EAI_AGAIN",
                "Type": "gauge",
                "Help": "The amount of times the status code was returned",
            }
        },
        "Trip.Statuscode": {
            "ENOTFOUND": {
                "Metric": "TripStatuscode_ENOTFOUND",
                "Type": "gauge",
                "Help": "The amount of times the status code was returned",
            },
            "ECONNREFUSED": {
                "Metric": "TripStatuscode_ECONNREFUSED",
                "Type": "gauge",
                "Help": "The amount of times the status code was returned",
            },
            "ETIMEDOUT": {
                "Metric": "TripStatuscode_ETIMEDOUT",
                "Type": "gauge",
                "Help": "The amount of times the status code was returned",
            },
            "ECONNRESET": {
                "Metric": "TripStatuscode_ECONNRESET",
                "Type": "gauge",
                "Help": "The amount of times the status code was returned",
            },
            "EAI_AGAIN": {
                "Metric": "TripStatuscode_EAI_AGAIN",
                "Type": "gauge",
                "Help": "The amount of times the status code was returned",
            }
        },
    },
    "RedisInfo": {
        "Clients": {
            "connected_clients": {
                "Metric": "Redis_ConnectedClients",
                "Type": "gauge",
                "Help": "The amount of connected clients",
            },
            "blocked_clients": {
                "Metric": "Redis_BlockedClients",
                "Type": "gauge",
                "Help": "The amount of blocked clients",
            }
        },
        "Memory": {
            "used_memory": {
                "Metric": "Redis_UsedMemory",
                "Type": "gauge",
                "Help": "The amount of used memory",
            },
            "used_memory_peak": {
                "Metric": "Redis_UsedMemoryPeak",
                "Type": "gauge",
                "Help": "The peak amount of used memory",
            },
            "used_memory_rss": {
                "Metric": "Redis_UsedMemoryRSS",
                "Type": "gauge",
                "Help": "The amount of used memory RSS",
            }
        },
        "Stats": {
            "instantaneous_ops_per_sec": {
                "Metric": "Redis_InstantaneousOpsPerSec",
                "Type": "gauge",
                "Help": "The amount of instantaneous ops per second",
            },
            "total_commands_processed": {
                "Metric": "Redis_TotalCommandsProcessed",
                "Type": "gauge",
                "Help": "The amount of total commands processed",
            },
            "keyspace_hits": {
                "Metric": "Redis_KeyspaceHits",
                "Type": "gauge",
                "Help": "The amount of keyspace hits",
            },
            "keyspace_misses": {
                "Metric": "Redis_KeyspaceMisses",
                "Type": "gauge",
                "Help": "The amount of keyspace misses",
            },
            "rejected_connections": {
                "Metric": "Redis_RejectedConnections",
                "Type": "gauge",
                "Help": "The amount of rejected connections",
            },
            "expired_keys": {
                "Metric": "Redis_ExpiredKeys",
                "Type": "gauge",
                "Help": "The amount of expired keys",
            },
            "evicted_keys": {
                "Metric": "Redis_EvictedKeys",
                "Type": "gauge",
                "Help": "The amount of evicted keys",
            },
        },
        "CPU": {
            "used_cpu_sys": {
                "Metric": "Redis_UsedCpuSys",
                "Type": "gauge",
                "Help": "The amount of used CPU sys",
            },
            "used_cpu_user": {
                "Metric": "Redis_UsedCpuUser",
                "Type": "gauge",
                "Help": "The amount of used CPU user",
            }
        }
    }
}
