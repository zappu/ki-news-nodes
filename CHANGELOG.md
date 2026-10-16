# Changelog

Alle Änderungen am Paket `ki-news-nodes`. Versionen nach SemVer; die Version steht nur in `package.json`.

## [0.1.0] – 16.10.2026

Phase 1 laut `PROJEKTPLAN.md`: Pipeline-Kern ohne Backend, Lauf per Befehlszeile.

### Hinzugefügt

- Paketgerüst in TypeScript (`package.json`, `tsconfig.json`, Vitest), Einstieg `src/index.ts`.
- Tabellen `news_queue`, `news_profiles`, `news_settings`, `news_styles`, `news_runs`, `news_usage`, `news_state` mit `site_id` und versionierten Migrationen (`news_migrations`, geschützt durch `GET_LOCK`).
- Datenzugriff `NewsStore`: Einstellungen und Profile (mehrere je Seite, mit zod geprüft und mit den Standardwerten aus KNP), Queue mit Duplikatprüfung über GUID und normalisierte URL, zentrale Fehlerbehandlung mit drei Versuchen, Aktionen Freigeben, Aussortieren, Erneut versuchen und Löschen auch als Sammel-Aktion.
- Zentraler HTTP-Client mit Browser-Kopfzeilen, SSRF-Schutz (Prüfung beim Verbindungsaufbau und nach jeder Weiterleitung), höchstens 3 Weiterleitungen, Zeit- und Größenlimit, Zeichensatz-Erkennung.
- RSS 2.0, Atom, RDF und JSON Feed lesen (feedsmith), Import der ersten 30 Items je Feed im Datumsfenster.
- Crawl mit der Heuristik aus KNP (article, main, body, Mindestlänge 300 Zeichen, höchstens 15 000).
- KI-Klassifikation und Rewrite in einem Aufruf mit den Prompts im Wortlaut aus `docs/uebergabe/03`, Längenstufen, Token-Limit nach Länge, robustes JSON-Auslesen, Gedankenstrich-Bereinigung, HTML-Positivliste, Tags.
- Kategorien aus der Zielseite, feste Kategorie je Profil, unbekannte Antworten gehen nach „News“ (Entscheidung 0004).
- Veröffentlichung über die Adapter-Schnittstelle `PublishTarget`, idempotent über Queue-ID sowie Titel und Textanfang, mit Protokoll je Phase.
- `runPipeline` mit der Reihenfolge Veröffentlichung, RSS-Import, Crawl, KI; `runCli` für das Cron-Skript der Seiten (`migrate`, `run`, `status`).
- Tests: Grundbausteine, HTTP und SSRF gegen einen lokalen Testserver, Store gegen MySQL/MariaDB, ganzer Lauf mit Attrappen für Feeds, Quellseiten, KI und Zielseite, Abgleich der Prompts mit dem Übergabepaket.

### Sicherheit

- Fremde URLs nur über den geschützten HTTP-Client; interne Adressen, fremde Ports, Zugangsdaten in URLs und andere Protokolle werden abgelehnt.
- KI-HTML läuft vor dem Speichern und vor der Übergabe an die Zielseite durch eine Positivliste.
