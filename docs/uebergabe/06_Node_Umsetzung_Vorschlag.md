# Vorschlag für die Umsetzung in Node.js

Das ist ein Ausgangspunkt für die Grilling-Session, keine Festlegung. Bibliotheken und Versionen vor dem Einsatz auf aktuellen Stand und Pflegezustand prüfen.

> Stand nach der Grilling-Session vom 16.10.2026: Verbindlich ist `PROJEKTPLAN.md`. Abweichungen von diesem Vorschlag: TypeScript statt JavaScript, Paket statt Modul je Seite (0001), Plesk-Cron-Skript statt Zeitplaner im Prozess (0002), MySQL `GET_LOCK` statt Postgres, Markdown im Adapter (0003), Kategorien aus der Zielseite (0004), mehrere Profile je Seite ab Version 1.

## Zuordnung WordPress zu Node

| Im Plugin | In Node |
|---|---|
| WP-Cron, Intervall-Auswahl | Zeitplaner im laufenden Prozess (z. B. croner oder node-cron) oder ein systemd-Timer, der einen CLI-Befehl startet |
| `GET_LOCK` Advisory-Lock | Postgres `pg_try_advisory_lock`, bei SQLite eine Lock-Zeile mit Ablaufzeit plus PID, oder Redis mit Ablaufzeit |
| Tabelle `knp_articles` über `$wpdb` | eigene Tabelle in der Datenbank der Seite bzw. des Dienstes |
| WordPress-Optionen (Einstellungen, Stile, Log, Status) | Tabellen `settings`, `styles`, `runs` |
| `fetch_feed()` (SimplePie) | RSS- und Atom-Parser, z. B. rss-parser oder feedsmith |
| Readability-Heuristik mit DOMDocument | gleiche Heuristik mit cheerio, oder besser `@mozilla/readability` mit jsdom bzw. linkedom |
| `wp_safe_remote_get()` mit SSRF-Schutz | `fetch`/undici mit eigener Prüfung: DNS auflösen, private und lokale Adressen sperren, auch nach jeder Weiterleitung; Größenlimit beim Lesen des Streams |
| `wp_kses()` | sanitize-html mit derselben Positivliste |
| Mediathek, GD | Bildordner der Seite und sharp (PNG zu JPEG, Größenvarianten, Typprüfung) |
| `wp_insert_post`, Kategorien, Tags, Beitragsbild | Ziel-Adapter (siehe unten) |
| Rank Math / Yoast | Felder `seo_title` und `seo_description` am Beitrag |
| Admin-Seiten, admin-post, AJAX | Bereich „News“ im Admin-Backend mit API-Routen |
| Update über `update.json` | Git und `package.json`-Version |

## Aufbau

Kern und Zielseite strikt trennen. Der Kern kennt keine Blog-Tabelle und kein Admin-Backend.

```
ki-news-node/
  src/
    core/
      pipeline.js        Lauf, Reihenfolge, Sperre, Status, Protokoll
      steps/
        retry.js
        importFeeds.js
        braveDiscover.js
        crawl.js         inkl. Recherche für Brave-Themen
        classify.js
        images.js
        publish.js
      ai.js              complete(), classify(), extractJson()
      prompts.js         alle Texte aus 03 an einer Stelle
      brave.js           Suche, Zeitplan-Slots, Wortvergleich
      styles.js          Längenstufen, Stil-Block, ableiten, Probetext, cleanText()
      fetchPage.js       Browser-Header, SSRF-Schutz, Limits, Readability
      urls.js            normalizeUrl(), urlHash()
      images.js          Anbieter, Prüfung, Umwandlung
    store/               Zugriff auf Queue, Einstellungen, Stile, Läufe
    targets/
      nodeBlog.js        Adapter für das Admin-Backend der Node-Seiten
      wordpressRest.js   später für Weg 2
    admin/               Routen und Ansichten für Queue, Einstellungen, Stile
    cli.js               „run“, „brave“, „status“ für Tests und systemd
  test/
```

## Ziel-Adapter

Alles, was die Pipeline über die Zielseite wissen oder dort tun muss, läuft über eine Schnittstelle. Damit lässt sich später dieselbe Pipeline auf WordPress (REST-API) oder auf mehrere Seiten richten.

```js
/**
 * @typedef {Object} PublishTarget
 * @property {(limit:number) => Promise<string[]>} recentTitles
 *   Titel der letzten Beiträge für den Brave-Abgleich (Plugin: 300).
 * @property {(queueId:number, title:string, fingerprint:string) => Promise<string|null>} findExisting
 *   Schon angelegten Beitrag zu diesem Queue-Eintrag finden (Idempotenz).
 * @property {(file:{buffer:Buffer, mime:string, filename:string, alt:string}) => Promise<{id:string, url:string}>} uploadImage
 * @property {(post:PostPayload) => Promise<{id:string, url?:string}>} createPost
 * @property {(id:string, post:Partial<PostPayload>) => Promise<void>} completePost
 *   Kategorie, Tags, Bild, SEO und Herkunft an einem vorhandenen Beitrag ergänzen.
 */

/**
 * @typedef {Object} PostPayload
 * @property {string} title
 * @property {string} slug
 * @property {string} html          bereits gefiltert, mit Quellenangabe und KI-Hinweis
 * @property {string} excerpt
 * @property {'draft'|'pending'|'publish'} status
 * @property {string} [author]
 * @property {string} [category]    Name, der Adapter legt ihn bei Bedarf an
 * @property {string[]} tags
 * @property {string} [imageId]
 * @property {string} seoTitle
 * @property {string} seoDescription
 * @property {{queueId:number, sourceUrl:string}} origin
 */
```

## Laufmodell

- Ein Lauf ist eine Funktion `runPipeline({ manual })`, die erst die Sperre holt und dann die Schritte in der Reihenfolge aus `02` abarbeitet.
- Der Zeitplaner ruft sie im Intervall auf. Der Button im Backend startet sie im Hintergrund und gibt sofort zurück; das Backend fragt den Status über eine Route ab.
- Status und Protokoll eines Laufs liegen in einer Tabelle `runs`, damit auch ältere Läufe nachvollziehbar sind (das Plugin hält nur den letzten).

## Datenbank

Die Spalten aus `02` übernehmen. Zusätzlich sinnvoll:

- `site_id` von Anfang an, falls Weg 2 kommt (bei Weg 1 einfach eine Konstante).
- `image_ref` statt `image_attachment_id`, `post_ref` statt `post_id`, weil die Zielseite eigene ID-Formate haben kann.
- Migrationen versioniert (z. B. mit knex, drizzle oder einfachen SQL-Dateien), weil es kein `dbDelta()` gibt.

## Sicherheit

- API-Keys nicht im Klartext ins Backend-Formular zurückschreiben, nur „hinterlegt“ anzeigen.
- Alle fremden URLs (Feeds, Quellseiten, Vergleichsseiten, Bild-URLs) über denselben geschützten Abruf.
- KI-HTML immer durch die Positivliste, bevor es gespeichert oder ausgeliefert wird.
- Admin-Routen nur für angemeldete Admins, Sammel-Aktionen mit CSRF-Schutz.

## Reihenfolge der Umsetzung

1. Kern ohne Backend: Store, `fetchPage`, `urls`, RSS-Import, Crawl, KI-Klassifikation, Publish über den Node-Adapter. Lauf per CLI. Tests mit gemockten Antworten.
2. Sperre, Laufstatus, Protokoll, Fehlerwiederholung mit drei Versuchen, Zeitbudget, Idempotenz.
3. Bilder (fal.ai zuerst, dann OpenRouter), Prüfung und Umwandlung mit sharp.
4. Backend: Queue mit Filter, Einzel- und Sammel-Aktionen, Einstellungen, Laufstatus, Buttons.
5. Brave-Themensuche mit Zeitplan-Slots, Auswahl, Abgleich und Recherche.
6. Schreibstile mit Ableiten und Probetext, Längenstufen.
7. Benachrichtigung bei wartenden Artikeln, Ablaufdatum für alte Meldungen (neu gegenüber dem Plugin).
8. Optional: WordPress-REST-Adapter und mehrere Seiten (Weg 2).

## Tests, die es von Anfang an geben sollte

- URL-Normalisierung mit Tracking-Parametern, Fragment, Schrägstrich am Ende und Reihenfolge der Parameter.
- JSON-Auslesen mit Codezaun, Einleitungssatz und kaputtem JSON.
- Wortvergleich der Überschriften mit Stoppwörtern und Grenzfall 0,5.
- Zeitplan-Slots über Tagesgrenzen und Zeitzone.
- Fehlerpfad: drei Fehler hintereinander führen zu `rejected` mit letzter Meldung.
- Publish nach simuliertem Abbruch legt keinen zweiten Beitrag an.
- Gedankenstrich-Bereinigung.
- SSRF: Abrufe auf `localhost`, `127.0.0.1`, `10.x`, `169.254.169.254` und Weiterleitungen dorthin werden abgelehnt.
