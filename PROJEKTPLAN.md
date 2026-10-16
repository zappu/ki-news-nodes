# Projektplan KI News Nodes

Stand: 16.10.2026, Ergebnis der Grilling-Session (Runden 1 bis 3). Begriffe stehen in `GLOSSAR.md`, Entscheidungen mit Abwägung in `docs/entscheidungen/`, die technischen Grundlagen aus KNP in `docs/uebergabe/`.

## Ziel

KI News Nodes baut die Pipeline des WordPress-Plugins KI News Publisher (KNP) 1.12.1 für Thomas' Node-Seiten nach: Meldungen aus RSS und aus der Brave-Themensuche finden, Volltext laden oder recherchieren, per KI prüfen und neu schreiben, Teaserbild erzeugen und als fertigen Beitrag mit SEO-Daten im Blog der Seite veröffentlichen. Logik, Prompts, Grenzwerte und Erfahrungen kommen aus KNP; ersetzt wird alles, was dort WordPress liefert.

## Erfolgskriterien nach drei Monaten Pilotbetrieb

- An mindestens 80 % der Tage erscheinen 2 bis 3 News-Artikel auf der Pilotseite.
- Kein Lauf hängt länger als einen Durchgang; eine Sperre bleibt nie liegen.
- Weniger als 10 % der Queue-Einträge werden nach drei Fehlversuchen aussortiert.
- Die Freigabe kostet höchstens 10 Minuten am Tag.
- News-Artikel bringen messbar Besucher (eigene Webstatistik der Seite).

## Zielgruppe

Betreiber und Redaktion der Zielseiten (Freigabe, Pflege der Profile) und die Leser dieser Seiten, die aktuelle, verständlich erklärte Neuigkeiten zum Thema der Seite bekommen.

## Umfang Version 1

- Paket `ki-news-nodes` (TypeScript) mit Pipeline-Kern, Ziel-Adapter für die Node-Seiten aus der SSR-Vorlage, Admin-Router und Admin-Seiten, CLI-Skript für Plesk-Cron.
- Alle Pipeline-Schritte aus `docs/uebergabe/02`: Fehlerwiederholung, Veröffentlichung, RSS-Import mit Duplikatprüfung, Brave-Themensuche mit KI-Auswahl, Zeitplan-Slots und Wortvergleich, Crawl und Recherche, KI-Klassifikation und Rewrite in einem Aufruf, Tags, Längenstufen, Teaserbilder.
- Mehrere Profile je Zielseite (siehe Struktur).
- Redaktions-Queue mit Freigabe, Aussortieren, Erneut versuchen, Löschen, jeweils einzeln und als Sammel-Aktion, Filter nach Status und Profil.
- Sperre, Laufstatus und Protokoll je Lauf in einer Tabelle, Zeitbudget, Idempotenz beim Veröffentlichen.
- Neu gegenüber KNP: tägliche Mail bei wartenden Artikeln, Ablauf nicht freigegebener Artikel nach 14 Tagen, Tageslimit für KI-Aufrufe und Bilder je Seite, Dashboard-Kachel.
- Nach dem ersten Livegang, noch in Version 1: Schreibstile mit Ableiten aus Beispieltext und Probetext.

## Nicht-Ziele

- Kein zentraler Dienst und kein Angebot für Kunden (Weg 2). Der Kern bleibt aber so geschnitten, dass er später als Dienst laufen kann.
- Kein Adapter für WordPress-REST in Version 1.
- Keine Änderungen am Plugin KNP; es bekommt im alten Repo nur noch Fehlerbehebungen.
- Kein Zeitplaner im laufenden Node-Prozess, keine Verlagsfeeds als Quellen, keine automatische Anlage neuer Kategorien.
- Nicht übernommen: Einstellungsimport aus „KI News Autopilot“, Update-Mechanismus über `update.json`, Rank Math und Yoast, der direkte DB-Insert aus KNP 1.9.0.

## Struktur

### Zielseiten

1. Pilot: smartwatch-fitnesstracker.de.
2. Danach die übrigen Seiten aus der SSR-Vorlage (Küchen-Helfer, Kaffeeröster, ig-lifestyle.com).
3. ralflist.de (älterer Stand ohne SSR) zuletzt oder gar nicht.

### Profile

Jede Zielseite hat beliebig viele Profile. Je Profil: Name, aktiv an/aus, Themenprofil, RSS-Feeds, Brave-Suchbegriffe samt Auswahl-Prompt und Gliederung, Längenstufen für RSS und Brave, Schreibstil, Artikelziel pro Tag, optional eine feste Kategorie. Für die ganze Seite gelten: KI-Kette, Bildmodell, Freigabe an/aus, Zielstatus, Autor, Laufintervall, Tageslimit für Kosten, Duplikatprüfung über alle Profile. Ein Lauf arbeitet die aktiven Profile reihum ab.

Beispiel für den Pilot: „Neuheiten“ (Brave, neue Modelle und Vorstellungen) und „Updates und Funktionen“ (Hersteller-RSS und Brave zu Software-Updates, Gliederung als Anleitung).

### Quellen

Hauptquelle ist die Brave-Themensuche mit einem gemeinsamen Brave-Schlüssel für alle Seiten. RSS nur von Herstellern, die ihre Pressemitteilungen zur Übernahme bereitstellen; Verlagsfeeds (heise, Golem, Chip und ähnliche) bleiben draußen. Feed-Adressen werden vor dem Pilot einzeln geprüft.

### Kategorien

Ohne feste Kategorie im Profil wählt die KI aus den Kategorien der Zielseite, die der Adapter liefert (bei den SSR-Seiten aus `shared/pages.ts`). Unbekannte Kategorien gehen nach „News“, neue Kategorien werden nie angelegt (Entscheidung 0004).

### Beiträge

Der Adapter wandelt das KI-HTML mit turndown in Markdown um (Entscheidung 0003), hängt Quellen als Liste und den KI-Hinweis kursiv an und legt den Beitrag über `createPost` der Seite an. Damit greifen Stil-Bereinigung, eindeutige Slugs, Duplikatprüfung, Auto-Links und Produktboxen der Seite. Tags kommen aus dem KI-Aufruf, die Tag-Erzeugung der Seite startet nicht. Teaserbild landet im Bildspeicher der Seite (`storage/`, ausgeliefert unter `/media/`). Zielstatus `published` oder `draft`, Standard `published`, weil die Freigabe schon in der Queue passiert.

### Admin

Menüpunkt „News“ mit den Reitern Queue, Profile, Einstellungen, Schreibstile und Protokoll; Knöpfe „Lauf jetzt starten“ und „Brave-Themen jetzt suchen“; Kachel im Dashboard mit wartenden Artikeln als Badge und dem Ergebnis des letzten Laufs; Paketversion sichtbar.

## Technik und Betrieb

- **Sprache und Stack:** TypeScript wie die Seiten (Express, tRPC v11, drizzle mit mysql2, React 19 im Admin).
- **Einbindung:** Die Seite trägt das Paket mit festem Tag ein (`github:zappu/ki-news-nodes#vX.Y.Z`). Beim Bauen auf dem Laptop bündelt esbuild es in `dist/`, damit Plesk beim NPM install keinen Zugriff auf das private Repo braucht. Laufzeit-Abhängigkeiten des Pakets stehen in der `package.json` der Seite (Entscheidung 0001).
- **Datenbank:** Das Paket legt seine Tabellen mit Präfix `news_` in der MySQL-Datenbank der Seite selbst an, versionierte Migrationen, Spalten `site_id` und `profile_id` von Anfang an. Geplante Tabellen: `news_queue` (Spalten aus `docs/uebergabe/02`), `news_profiles`, `news_settings`, `news_styles`, `news_runs` (Status und Protokoll je Lauf), `news_usage` (Zähler für das Tageslimit).
- **Laufsteuerung:** Plesk-Cron startet alle 15 Minuten `node dist/scripts/news.js run`, jede Seite zu einer eigenen Minute, damit sich Brave-Anfragen nicht überschneiden. Das Skript prüft selbst, ob laut Intervall ein Lauf fällig ist. Sperre über MySQL `GET_LOCK`. Der Admin-Knopf startet einen Lauf im Hintergrund und kehrt sofort zurück (Entscheidung 0002).
- **KI:** Text über die vorhandene KI-Kette der Seite (`server/_core/llm.ts`, Anbieter, Modell und Reserve aus „KI-Einstellungen“), dem Kern als Funktion übergeben. Prompts wörtlich aus `docs/uebergabe/03`.
- **Bilder:** fal.ai mit `fal-ai/flux/schnell`, Modell im Admin änderbar. Prüfung und PNG-Umwandlung mit sharp.
- **Schlüssel:** `FAL_KEY` und `BRAVE_API_KEY` wie alle Geheimnisse nur in der `.env` der Seite, nie in der Datenbank, nie in einer API-Antwort.
- **Mail:** über den vorhandenen SMTP-Versand der Seite an `ADMIN_EMAILS`.
- **HTTP:** alle externen Abrufe über einen zentralen Client mit Browser-Kopfzeilen, SSRF-Schutz (auch nach Weiterleitungen), Zeit- und Größenlimits; in Tests durch Attrappen ersetzbar.
- **Versionen:** Paket nach SemVer mit deutschem `CHANGELOG.md` (Hinzugefügt, Geändert, Behoben, Sicherheit), Tags `vX.Y.Z`. Die Seiten behalten ihre Datumsversionen und vermerken „KI News X.Y.Z eingebaut“ im eigenen Changelog.
- **Tests:** Vitest, externe Dienste immer als Attrappen, MySQL-Testdatenbank für Sperre und Store. Pflichtfälle aus `docs/uebergabe/06` plus Profile reihum, Tageslimit, Ablauf nach 14 Tagen.

## Vorgehen in Phasen

| Phase | Version | Inhalt | Ergebnis |
|---|---|---|---|
| 0 | | Grilling, Plan, Repo | Dieser Plan, Glossar, Entscheidungen im Repo |
| 1 | 0.1.0 | Paketgerüst, Migrationen, Store, HTTP-Client mit SSRF-Schutz, URL-Normalisierung, JSON-Auslesen, RSS-Import, Crawl, KI-Klassifikation, Veröffentlichung über die Adapter-Schnittstelle (Test-Adapter), CLI | Ein Lauf per CLI gegen die Testdatenbank macht aus gemockten Feeds fertige Beiträge |
| 2 | 0.2.0 | Sperre, `news_runs` mit Status und Protokoll, Fehlerwiederholung mit drei Versuchen, Zeitbudget, Idempotenz, Profile reihum, Tageslimit | Abgebrochene und doppelte Läufe richten keinen Schaden an, alle Fehlerpfade getestet |
| 3 | 0.3.0 | Brave-Themensuche mit Slots, Auswahl, bekannten Überschriften, Wortvergleich, Recherche | Brave-Themen entstehen nach Zeitplan und werden recherchiert |
| 4 | 0.4.0 | Teaserbilder über fal.ai, Prüfung, Umwandlung, Ablage über den Adapter | Beiträge mit Teaserbild, Bildfehler blockieren nichts |
| 5 | 0.5.0 | Adapter für die SSR-Seiten (createPost, turndown, Kategorien, Bilder), Admin-Bereich News, Dashboard-Kachel, Mail bei wartenden Artikeln, Ablauf nach 14 Tagen, Cron-Skript, Einbau in den Build von smartwatch-fitnesstracker.de | Pilotseite mit vollständigem News-Bereich auf der Testinstallation |
| 6 | 0.6.0 | Pilot live: Profile „Neuheiten“ und „Updates und Funktionen“ einrichten, Feeds prüfen, Plesk-Cron, zwei Wochen Betrieb mit Freigabe | Stabiler Livebetrieb, Korrekturen aus dem Pilot |
| 7 | 0.7.0 | Schreibstile mit Ableiten und Probetext | Stil je Profil wählbar |
| 8 | 1.0.0 | Rollout auf die übrigen SSR-Seiten, Anleitung für den Einbau | Alle vorgesehenen Seiten mit News-Bereich |

Jede Phase endet mit `pnpm check`, `pnpm test`, Changelog-Eintrag, Tag und Push.

## Offene Punkte und Risiken

- **Hersteller-Feeds:** Ob Garmin, Samsung, Apple und andere RSS-Feeds mit lesbaren Meldungen anbieten und die Übernahme erlauben, ist ungeprüft. Ohne sie lebt der Pilot fast nur von Brave.
- **Brave-Tarif:** Aktuelle Limits und Kosten des Brave-Plans vor Phase 3 prüfen; ein gemeinsamer Schlüssel für mehrere Seiten teilt sich das Anfragelimit.
- **Bündeln der Git-Abhängigkeit:** Der Build der Seiten nutzt `--packages=external`. Das Paket muss davon ausgenommen werden; Lösung in Phase 5 testen.
- **Zeitlimits der KI-Kette:** KNP gibt KI-Aufrufen 180 s und ein Token-Limit nach Länge. Prüfen, ob `callLlm` der Seiten das zulässt, sonst Erweiterung der Seite nötig.
- **Admin-Knopf unter Passenger:** Wird der App-Prozess während eines Laufs beendet, verfällt die Sperre; halb bearbeitete Einträge laufen über die Fehlerwiederholung. Im Test simulieren.
- **turndown:** Umwandlung von Listen, Überschriften und Links aus dem KI-HTML mit echten Antworten prüfen.
- **sharp auf Plesk:** Installation der vorgebauten Binärdatei beim NPM install prüfen.
- **Kosten messen:** Das Tageslimit zählt Aufrufe und Bilder, nicht Euro. Ob das reicht, zeigt der Pilot.

## Verweise

- `GLOSSAR.md`: Begriffe.
- `docs/entscheidungen/`: 0001 Paket statt Kopie je Seite, 0002 Laufsteuerung über Plesk-Cron-Skript, 0003 HTML-Prompts und Markdown im Adapter, 0004 Kategorien aus der Zielseite.
- `docs/uebergabe/`: Übergabepaket aus KNP 1.12.1 (Spezifikation, Prompts, Integrationen, Erfahrungen, Umsetzungsvorschlag).
- Referenz-Code: Repo `zappu/ki-news-publisher` (nur lesen), Pilot: Repo `zappu/smartwatch-fitnesstracker.de`.
