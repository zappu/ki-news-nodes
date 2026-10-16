# 0002 Laufsteuerung über ein Plesk-Cron-Skript

Abweichend vom Vorschlag in `docs/uebergabe/06` gibt es keinen Zeitplaner im laufenden Prozess: Unter Passenger schlafen Prozesse bei Leerlauf ein und können mehrfach laufen, und ein Cron gegen eine HTTP-Route scheitert am Zeitlimit von nginx (etwa 60 s). Plesk-Cron startet alle 15 Minuten `node dist/scripts/news.js run`, jede Seite zu einer eigenen Minute; das Skript prüft selbst, ob laut eingestelltem Intervall ein Lauf fällig ist. Die Sperre läuft über MySQL `GET_LOCK` (wie KNP 1.7.3), der Knopf im Admin startet einen Lauf im Hintergrund, der Fortschritt steht in der Tabelle `news_runs`.

Stand: 16.10.2026, Grilling-Runde 1 und 2.
