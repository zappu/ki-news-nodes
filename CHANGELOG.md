# Changelog

Alle Änderungen am Paket `ki-news-nodes`. Versionen nach SemVer; die Version steht nur in `package.json`.

## [0.5.0] – 16.10.2026

Phase 5 laut `PROJEKTPLAN.md`: Admin-Bereich und Einbau in die Pilotseite smartwatch-fitnesstracker.de.

### Hinzugefügt

- Admin-Dienst `createNewsAdmin` (`ki-news-nodes/admin`) mit Eingabe-Schemas `newsInputs` für die Admin-Prozeduren der Seite: Übersicht, Queue mit Filtern und Detailansicht, Freigeben, Ablehnen, Wiederholen und Löschen (auch mehrere), Einstellungen, Profile anlegen, ändern und löschen, Kategorien der Seite, Laufprotokoll, „Lauf jetzt starten“, „Brave-Themen jetzt suchen“, „Feed testen“. Listen der Funktionen in `NEWS_QUERIES` und `NEWS_MUTATIONS`.
- React-Seiten `NewsAdmin` (`ki-news-nodes/admin/ui`) mit den Reitern Queue, Profile, Einstellungen und Protokoll; nur Klassen des Themes der Seite, vom Server nur Typen. `react` ist Peer-Abhängigkeit.
- Schritt Wartung am Anfang jedes Laufs, einmal am Tag ab `maintenanceHour` (Standard 8 Uhr): nicht freigegebene Einträge laufen nach `expireDays` (Standard 14) ab, liegengebliebene ebenso; bei wartenden Artikeln eine Mail über `ctx.notify` mit Link `ctx.adminUrl` (Einstellung `notifyWaiting`, Standard an).
- Tabelle `news_post_links` (Migration 3): Zuordnung Queue-Eintrag zu Beitrag direkt nach dem Anlegen, vor jedem Veröffentlichen geprüft. Ein abgebrochener Lauf legt so keinen Beitrag doppelt an, auch wenn die Seite keine Herkunftsspalte hat.
- Einbauanleitung `docs/EINBAU.md`, Entscheidung 0005 (Admin im Paket, Router in der Seite, Wartung im Lauf).

### Geändert

- `createNewsStore` setzt die Sitzungszeitzone UTC für den eigenen Pool.
- `package.json` mit `files` (nur `src`, Changelog, Einbauanleitung) und Exporten `./admin` und `./admin/ui`.

### Behoben

- Migrationen sind wiederholbar: Bricht ein Prozess zwischen einer Tabellenänderung und dem Eintrag in `news_migrations` ab, gelten „Tabelle, Spalte oder Schlüssel gibt es schon“ beim nächsten Start als erledigt, statt jede weitere Migration zu blockieren (MySQL führt DDL ohne Transaktion aus).

## [0.4.0] – 16.10.2026

Phase 4 laut `PROJEKTPLAN.md`: Teaserbilder.

### Hinzugefügt

- Schritt Teaserbilder am Ende jedes Laufs: für klassifizierte (mit Freigabe auch freigegebene) Einträge ohne Bild aus dem Bildbriefing der KI ein Bild erzeugen und über `PublishTarget.uploadImage` im Bildspeicher der Seite ablegen; Dateiname `news-teaser-{id}.{endung}`, Alt-Text = KI-Titel. Der Beitrag bekommt das Bild über `imageRef`.
- Bildanbieter fal.ai (synchron, `landscape_16_9`, Standard `fal-ai/flux/schnell`) und OpenRouter (`modalities`, Standard `google/gemini-2.5-flash-image`), Einstellung `imageProvider`; das Modell passt sich dem Anbieter an.
- Schlüssel aus der `.env` der Seite über `ctx.imageKeys` (`FAL_KEY`, `OPENROUTER_API_KEY`).
- Tageslimit für Bilder je Seite (`dailyImageLimit`, Standard 20).
- Neue Abhängigkeit sharp 0.35 (Node ab 20.9).

### Geändert

- Bildfehler zählen wie in KNP nicht als Fehlversuch und blockieren nichts. Abweichend von KNP wird ein Bild höchstens zweimal versucht (`Bild:` und `Bild (2. Versuch):`), damit ein gestörter Anbieter nicht jeden Lauf Kosten erzeugt.

### Sicherheit

- Bilddaten sind fremde Eingaben: Data-URLs nur als `data:image/(jpeg|png|webp);base64,…` mit strenger Base64-Prüfung, Bild-URLs nur über den geschützten HTTP-Client (SSRF-Schutz, höchstens 3 Weiterleitungen), höchstens 8 MiB, Bildtyp aus den Bytes bestimmt, nur JPEG, PNG und WebP. PNG wird zu JPEG mit Qualität 80.

## [0.3.0] – 16.10.2026

Phase 3 laut `PROJEKTPLAN.md`: Brave-Themensuche mit Recherche.

### Hinzugefügt

- Brave News Search (`src/core/brave.ts`): Suchzeilen mit Sprachpräfix `de|…`, Zeitraum der letzten `braveDays` Tage, Land für de, fr, es, it, pt, nl, Entdopplung über die URL (höchstens 90 Treffer), HTML aus Titeln und Beschreibungen entfernt.
- Schritt Brave-Themensuche je Profil nach Zeitplan-Slots zwischen `braveStartHour` und `braveEndHour` in der Zeitzone der Seite; Hinweis auf den nächsten Slot; nach einer Suche ohne neues Thema eine Stunde Pause.
- Themenauswahl per KI mit dem Prompt im Wortlaut aus `docs/uebergabe/03` (Token-Limit 2000), Rückfall auf Zeilen, wenn kein JSON kommt. Bekannte Überschriften aus der Zielseite, der Queue und den Vergleichsseiten (`h1` bis `h4`).
- Duplikatprüfung neuer Themen über GUID, Wortvergleich (Jaccard ab 0,5) und URL der ersten Quelle.
- Recherche im Crawl-Schritt: Nachsuche bei weniger als zwei Quellen, soziale Netzwerke fallen weg, die ersten 4 von höchstens 8 Quellen werden gelesen (je 3500 Zeichen), mindestens 300 Zeichen Faktenbasis, Recherchetext im Format `[Quelle n]`.
- Tageslimit für Brave-Anfragen je Seite (`dailyBraveLimit`, Standard 200) und einstellbare Pause zwischen Anfragen (`braveDelayMs`, Standard 1100 ms wie im Gratis-Tarif).
- „Brave-Themen jetzt suchen“: `runPipeline(ctx, { braveOnly: true })` und Befehl `news brave`, ohne Schalter und Zeitplan.
- Brave-Schlüssel kommt aus der `.env` der Seite über `ctx.braveApiKey`.

### Geändert

- Reihenfolge eines Laufs: Wiederholung, Veröffentlichung, RSS-Import, Brave-Themensuche, Crawl und Recherche, KI.

## [0.2.0] – 16.10.2026

Phase 2 laut `PROJEKTPLAN.md`: Laufsteuerung und Grenzen.

### Hinzugefügt

- Lauf-Sperre je Seite über `GET_LOCK` auf einer eigenen Verbindung (verfällt beim Absturz des Prozesses), Heartbeat vor jedem Schritt; ein zweiter Lauf wird übersprungen und als `locked` gespeichert.
- Laufprotokoll in `news_runs`: Status, aktueller Schritt und Protokoll werden vor und nach jedem Schritt gespeichert, Auslöser `cron` oder `manual`. Liegengebliebene Läufe gelten beim nächsten Lauf als abgebrochen (mit letztem Schritt). Es bleiben die neuesten 500 Läufe je Seite.
- Schritt 0 Fehlerwiederholung (KNP 1.12.0): bis zu 200 Einträge mit `failed` gehen auf ihren Rücksprung-Status zurück, ohne Rücksprung entscheidet das Präfix der Meldung; ab drei Versuchen aussortiert.
- Zeitbudget der Veröffentlichung von 120 s je Lauf (KNP 1.8.1).
- Profile reihum: Crawl, KI und Veröffentlichung nehmen abwechselnd Einträge aus jedem Profil, jeder Lauf beginnt beim nächsten Profil.
- Artikelziel pro Tag je Profil (`dailyTarget`, Standard 3): ist es erreicht, warten weitere Einträge bis zum nächsten Tag. Nicht relevante Meldungen zählen nicht mit. Neue Spalte `classified_at` (Migration 2).
- Tageslimit für KI-Aufrufe je Seite (`dailyAiLimit`, Standard 60, 0 = ohne Limit), gezählt in `news_usage`. Ist es erreicht, endet der KI-Schritt regulär, ohne Fehlversuch.
- Zeitzone der Seite (`timezone`, Standard Europe/Berlin) für Tagesgrenzen, auch an Tagen mit Zeitumstellung.
- Befehlszeile: `run` startet nur, wenn laut Intervall ein Lauf fällig ist (zwei Minuten Spielraum), `run --force` sofort; `status` zeigt den letzten Lauf.

### Geändert

- `runPipeline(ctx, { trigger })` liefert zusätzlich `runId` und den Status `locked`.

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
