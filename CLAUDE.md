# KI News Nodes

News-Pipeline für Thomas' Node-Seiten: Nachbau des WordPress-Plugins KI News Publisher (KNP) 1.12.1 als TypeScript-Paket, das jede Seite aus der SSR-Vorlage einbindet. Pilot: smartwatch-fitnesstracker.de.

## Repository

- GitHub: https://github.com/zappu/ki-news-nodes (privat), Branch `main`.
- Tags: `vX.Y.Z` nach SemVer, passend zum obersten Eintrag in `CHANGELOG.md`. Die Seiten binden das Paket über genau einen Tag ein (`github:zappu/ki-news-nodes#vX.Y.Z`).
- Nicht ins Repo: `.env` und andere Zugangsdaten, `node_modules/`, `dist/`, ZIPs, Logs, Datenbank-Dumps (siehe `.gitignore`).
- Abgleich vor und nach jeder Änderung (Skill `github-abgleich`). Commit-Nachrichten deutsch mit Präfix `Init:`, `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`.
- Lokaler Ordner auf dem Laptop: `D:\!claude_projekte\ki-news-nodes\` (Klon dieses Repos, außerhalb von `WP Plugins`).

## Stand

Version 0.3.0 (Phase 3): Pipeline-Kern mit RSS-Import, Brave-Themensuche mit Recherche, Crawl, KI-Klassifikation und Veröffentlichung über die Adapter-Schnittstelle, Sperre je Seite, Laufprotokoll in `news_runs`, Fehlerwiederholung, Zeitbudget, Profile reihum, Artikelziel pro Tag, Tageslimit für KI-Aufrufe, Lauf per `runCli` mit Intervallprüfung. Es fehlen noch Bilder (Phase 4), Adapter für die SSR-Seiten und Admin (Phase 5).

## Aufbau

- `src/index.ts`: öffentliche Schnittstelle, `VERSION` aus `package.json`.
- `src/core/`: Kern ohne Seitenbezug. `context.ts` (Kontext und Laufzustand), `time.ts` (Tagesgrenzen in der Zeitzone der Seite), `types.ts` (Queue-Eintrag, Ports `LlmFn` und `PublishTarget`), `settings.ts` (Einstellungen der Seite und der Profile mit zod und KNP-Standardwerten), `prompts.ts` (Wortlaut aus `docs/uebergabe/03`), `http.ts` (geschützter HTTP-Client), `feeds.ts`, `fetchPage.ts`, `html.ts` (Positivliste, Textextraktion), `urls.ts`, `json.ts`, `text.ts`, `lengths.ts`, `steps/` (ein Schritt je Datei, Reihenfolge in `pipeline.ts`: Wiederholung, Veröffentlichung, RSS-Import, Brave-Themensuche, Crawl und Recherche, KI), `brave.ts` (Brave-Suche, Slots, Wortvergleich), `pipeline.ts` (Sperre, Laufprotokoll, Tageslimit).
- `src/store/`: `migrations.ts` (nur neue Versionen anhängen) und `store.ts` (`NewsStore`, MySQL/MariaDB in UTC).
- `src/cli.ts`: `runCli(argv, build)` für das Cron-Skript der Seite.
- `test/`: Vitest. `helpers/fakes.ts` mit Attrappen für HTTP, KI und Zielseite, `helpers/db.ts` für die Testdatenbank.

Das Paket wird als TypeScript-Quelle ausgeliefert (`exports` zeigt auf `src/index.ts`); die Seite bündelt es beim Build.

## Befehle

- `pnpm install`, `pnpm check` (Typprüfung), `pnpm test` (Vitest).
- Tests brauchen MySQL oder MariaDB, Standard `mysql://news:newspass@127.0.0.1:3306/news_test`, änderbar über `TEST_DATABASE_URL`. Die Tests legen die `news_`-Tabellen jedes Mal neu an.

## Grundlagen

- `PROJEKTPLAN.md`: Ziel, Umfang, Nicht-Ziele, Struktur, Technik, Phasen, Risiken. Bei Änderungen am Umfang nachführen.
- `GLOSSAR.md`: verbindliche Begriffe (Pipeline-Kern, Zielseite, Profil, Ziel-Adapter, Queue-Eintrag, Lauf, Freigabe, Abgelaufen).
- `docs/entscheidungen/`: Entscheidungen mit Abwägung. Neue Nummer = höchste vorhandene plus eins.
- `docs/uebergabe/`: Verhalten, Prompts, Integrationen und Erfahrungen aus KNP. Das ist die fachliche Grundlage; nichts davon neu erfinden, Abweichungen bewusst entscheiden und begründen.
- Referenz-Code bei Detailfragen, die das Übergabepaket nicht beantwortet: Repo `zappu/ki-news-publisher` (PHP, nur lesen, dort nichts ändern).
- Pilotseite: Repo `zappu/smartwatch-fitnesstracker.de` (Blog-Tabelle `blog_posts` mit Markdown, `createPost` in `server/blog/service.ts`, KI-Kette `server/_core/llm.ts`, Bildspeicher `server/storage.ts`, Kategorien `shared/pages.ts`, Cron-Muster `scripts/cleanup.ts`).

## Regeln

- Der Pipeline-Kern bleibt unabhängig vom Admin-Backend und von der Zielseite. Alles Seitenspezifische läuft über den Ziel-Adapter; die KI-Kette und der Mailversand der Seite werden dem Kern als Funktionen übergeben.
- Prompts aus `docs/uebergabe/03` wörtlich übernehmen.
- Keine Gedankenstriche in erzeugten Artikeln; Texte deutsch nach den Regeln aus `vermenschlichen`.
- Geheimnisse (`BRAVE_API_KEY`, `FAL_KEY`, KI-Schlüssel) nur in der `.env` der Seite, nie in der Datenbank, nie in Antworten der API.
- Alle fremden URLs (Feeds, Quellseiten, Vergleichsseiten, Bild-URLs) nur über den zentralen HTTP-Client mit SSRF-Schutz.
- Tests mit Vitest, externe Dienste immer als Attrappen. Jede Version lauffähig und getestet.
- Versionen nach SemVer, `package.json` ist die einzige Quelle der Version. Changelog deutsch mit Hinzugefügt, Geändert, Behoben, Sicherheit.
- Neue Funktionen, die mehr als eine Datei betreffen, erst nach kurzer Klärung bauen.
