# livegps

Eigenständiger Node.js-Worker für alle vom VMI-Dienst gelieferten Fahrzeugobjekte. Benötigt Node.js ab 20.18.1, Redis und ClickHouse. Kennungen bleiben Strings und werden unabhängig von PULS archiviert.

## Start

Vom Repository-Verzeichnis:

```powershell
npm --prefix livegps ci
Copy-Item livegps/.env.example livegps/.env
# Zugangsdaten und Datenbank in livegps/.env einstellen.
# Dieselben ClickHouse-Zugangsdaten in migration/.env einstellen.
npm --prefix migration ci
npm --prefix migration run migrate
npm --prefix livegps start
```

Bei vorhandener GPS-Historie zuerst den alten `livegps`-Worker stoppen, dann Migration 005 ausführen und anschließend die aktualisierten Dienste starten. Die Migration übernimmt `livegps_observations` nach `gps_fahrten` und `gps_observations`; die alte Tabelle bleibt erhalten. [Details zu Schema, Aktualisierung und Karte](../WebService/GPS.md).

Eine Worker-Instanz ist der Standard. Ein Prozessmanager soll den Worker nach einem Watchdog-Abbruch neu starten. ENV wird beim Start geprüft, das Logging folgt `LOG_LEVEL`, `LOG_TYPE` und `LOG_COLOR`.

## Sammlung

`LIVEGPS_FETCH_MODE=all` ruft alle zehn Sekunden `getVehicles()` ohne Bounding Box, Betreiber- oder Verkehrsmittelfilter auf. Die Abdeckung lautet **alle gelieferten VMI-Objekte**; eine vollständige Europa-Abdeckung ist nicht zugesichert.

Mit `LIVEGPS_FETCH_MODE=tiles` werden die ENV-Grenzen sequenziell in Kacheln von höchstens 0,5° × 0,5° abgefragt. Standardgrenzen sind West 8,9 / Süd 47,2 / Ost 13,9 / Nord 50,6. Zwischen Abfragen liegen standardmäßig 500 ms. Scanläufe überlappen nicht. Fehler führen zu Backoff bis 60 Sekunden; hängende Abrufe beendet `WATCHDOG_TIMEOUT` (Sekunden).

Nur geänderte Quellobjekte gelangen ins Archiv. Der Vergleich berücksichtigt alle Quellfelder einschließlich Quellzeitstempel, ohne Abrufmetadaten. Fehlende oder ungültige Positionsdaten werden ebenfalls archiviert. Vollständige Quellobjekte bleiben als JSON erhalten.

## Redis-Datenvertrag

Alle Schlüssel liegen in der über `REDIS_DB` konfigurierten DB unter `LIVEGPS:VMI:`:

| Schlüssel | Inhalt |
| --- | --- |
| `OBJECT:<entityKey>` | Neuester JSON-Snapshot je Quellobjekt, 180 Sekunden TTL |
| `VEHICLE:<vehicleKey>` | Neuester JSON-Snapshot je Betreiber/Fahrzeug, 180 Sekunden TTL |
| `GEO` | GEO-Index: Member ist `vehicleKey` |
| `GEO_EXPIRY` | Sorted Set: Member ist `vehicleKey`, Score ist Ablaufzeit in Unix-Millisekunden |
| `STATE:<entityKey>` | Persistenter Vergleichshash und Quellzeit-Watermark |
| `WATERMARK:<vehicleKey>` | Persistente letzte Quellzeit und ausgewählte Objektkennung |
| `OBSERVATIONS` | Archiv-Stream, Feld `row` enthält die normalisierte Beobachtung als JSON |

`entityKey` ist ein SHA-256-Hash aus Betreiber und VMI-ID, ersatzweise Betreiber, Fahrtkennung und Betriebstag. Objekte ohne brauchbare Kennung werden über ihren Inhalt unterschieden und mit `anonymous: true` gekennzeichnet. `vehicleKey` ist der Hash aus Betreiber und Fahrzeugkennung; ohne Fahrzeugkennung lautet er `object-<entityKey>`.

Snapshots enthalten `source`, `entityKey`, `vehicleKey`, `anonymous`, `id`, `operator`, `journeyId`, `dayOfOperation`, `vehicleId`, `latitude`, `longitude`, `timestamp`, `fetchedAt`, vorherige Position/Zeit, Verspätung, Linien-/Haltestelleninformationen und `raw`. Ältere Quellzeitstempel überschreiben keine neuere Fahrzeugposition. Der GEO-Index enthält nur gültige und nach Quellzeit höchstens 180 Sekunden alte Positionen. Leser müssen zusätzlich `GEO_EXPIRY` und die gültigen aktuellen Snapshots prüfen.

Der Worker veröffentlicht Vergleichshash, aktuelle Snapshots und Archivauftrag atomar per Lua. Consumer-Gruppe `clickhouse`, Consumer `archive`, verarbeitet nach Neustart zuerst ausstehende Einträge. Erst nach beiden erfolgreichen ClickHouse-Inserts werden Einträge bestätigt und entfernt. Unbestätigte Einträge werden nicht gekürzt. Bei ClickHouse-Ausfall wird weiter gesammelt und der Rückstand protokolliert. Für dauerhafte Warteschlangen Redis-Persistenz konfigurieren; der Worker selbst konfiguriert AOF/RDB nicht.

## Metrics

Der WebService stellt unter `/api/v1/metrics` die aktuellen GPS-Kartenfahrzeuge aus
diesem Worker bereit. `LiveGPS_Vehicles` ist die Gesamtzahl;
`LiveGPS_VehiclesByProduct{product="Bus"}` liefert die Anzahl pro Verkehrsmittel.
`LiveGPS_IdentifiedVehicles` und `LiveGPS_UnidentifiedVehicles` unterscheiden
Fahrzeugkennungen von Objekt-Fallbacks; beide gibt es ebenfalls mit `ByProduct`.
Die Zählung verwendet dieselbe Ablauf- und Positionsprüfung wie der GPS-Modus der
Karte, über alle verfügbaren Fahrzeuge ohne Ausschnitts- oder Linienfilter.
Abgelaufene Positionen zählen auch bei gestopptem Worker nicht mehr.

## Prüfung

```powershell
npm --prefix livegps test
# Ein begrenzter echter API-Abruf ohne Redis-/ClickHouse-Schreibzugriffe:
npm --prefix livegps run probe
```

Lokale Integrationstests und die WebService-API sind in der [GPS-Dokumentation](../WebService/GPS.md) beschrieben.
