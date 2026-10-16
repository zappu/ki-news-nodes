# Pipeline-Spezifikation (Verhalten von KNP 1.12.1)

Dieses Dokument beschreibt, was das Plugin tut, nicht wie es in PHP gebaut ist. Werte in Klammern sind die festen Grenzen im Code. Wo eine Regel WordPress-spezifisch ist, steht das dabei.

## Grundidee

Eine einzige Tabelle hält den gesamten Zustand. Jede Zeile ist ein Queue-Eintrag: eine RSS-Meldung oder ein Brave-Thema. Ein Lauf arbeitet die Einträge in Schritten ab, jeder Schritt nimmt Einträge eines bestimmten Status und hebt sie auf den nächsten. Pro Schritt und Lauf wird höchstens `max_per_run` Einträge bearbeitet, damit weder Laufzeit noch API-Kosten ausufern.

## Datenmodell: Tabelle `knp_articles`

| Spalte | Typ | Bedeutung |
|---|---|---|
| id | Ganzzahl, Primärschlüssel | |
| guid | Text 191, eindeutig | RSS: `md5(Item-GUID oder Link)`. Brave: `md5('brave|' + Überschrift in Kleinbuchstaben)` |
| url_hash | Text 32, Index | `md5(normalisierte URL)`, siehe Duplikate |
| feed_url | Text 500 | Feed-URL oder die Markierung `brave:search` |
| source_url | Text 500 | Artikel-URL bzw. erste Quelle eines Brave-Themas |
| source_name | Text 191 | Feed-Titel bzw. „Brave-Themensuche“ |
| source_list | Langtext, JSON | Nur Brave: Liste aus `{title, url, desc, age}`, nach der Recherche `{title, url}` |
| title_original | Text | Originaltitel bzw. Brave-Überschrift |
| published_at | Datum | Datum aus dem Feed, bei Brave der Anlagezeitpunkt (UTC) |
| full_content | Langtext | Crawl-Text bzw. gebündelter Recherchetext |
| status | Text 20, Index | siehe Status-Fluss |
| relevance | 0/1/leer | Ergebnis der KI-Prüfung |
| rewritten_title | Text | KI-Titel |
| rewritten_content | Langtext | KI-Artikel als HTML |
| teaser_text | Text | max. 160 Zeichen |
| seo_title | Text | max. 60 Zeichen |
| seo_description | Text | max. 155 Zeichen |
| category_key | Text 100 | Schlüssel aus der Kategorienliste |
| tags | Text | Kommagetrennt |
| image_briefing | Text | Bildbeschreibung für den Bildgenerator |
| image_attachment_id | Ganzzahl | WordPress-Medien-ID; in Node: Bild-ID oder Pfad |
| post_id | Ganzzahl | ID des veröffentlichten Beitrags |
| error | Text | Letzte Fehlermeldung bzw. Aussortiergrund |
| attempts | Ganzzahl, Standard 0 | Zahl der Fehlversuche |
| retry_status | Text 20 | Status, ab dem nach einem Fehler wiederholt wird |
| created_at, updated_at | Datum | Ortszeit der Website |

Einstellungen, Schreibstile, Laufprotokoll, Laufstatus und der Brave-Zustand liegen im Plugin in WordPress-Optionen. In Node braucht es dafür eigene Speicherorte (Tabelle oder Datei).

## Status-Fluss

```
new ──Crawl/Recherche──> crawled ──KI──> classified ──(Freigabe)──> approved ──Publish──> published
                                            │                                    ▲
                                            └──── ohne manuelle Freigabe ─────────┘
KI: nicht relevant  ──> rejected (Grund in error)
technischer Fehler  ──> failed  (attempts +1, retry_status = Status vor dem Schritt)
3. Fehlversuch      ──> rejected („Nach 3 Fehlversuchen aussortiert. Letzter Fehler: …“)
```

Die Statusnamen sind `new`, `crawled`, `classified`, `approved`, `published`, `rejected`, `failed`.

Manuelle Aktionen in der Queue: Freigeben (`approved`), Aussortieren (`rejected`), Erneut versuchen (zurück auf `new`, `attempts` 0, Fehler leer), Löschen. Alle vier gibt es auch als Sammel-Aktion für mehrere markierte Einträge.

## Ein Pipeline-Lauf

Ein Lauf startet per Zeitplan oder manuell („Pipeline jetzt ausführen“). Reihenfolge:

0. Fehlversuche wiederholen
1. Veröffentlichung freigegebener Beiträge (läuft bewusst früh)
2. RSS-Import
3. Brave-Themensuche
4. Crawl bzw. Recherche
5. KI-Klassifikation und Rewrite
6. Teaserbilder

Die Veröffentlichung läuft vor Import, Crawl, KI und Bildern, damit bereits freigegebene Artikel nicht warten müssen, wenn ein externer Dienst langsam ist oder hängt (seit 1.8.0). Folge: Ohne manuelle Freigabe wird ein Artikel, der in diesem Lauf klassifiziert und bebildert wurde, erst im nächsten Lauf veröffentlicht.

### Sperre, Status und Protokoll

- Es darf nur ein Lauf gleichzeitig laufen. Das Plugin nutzt einen an die Datenbankverbindung gebundenen Advisory-Lock (`GET_LOCK`), der beim Abbruch des Prozesses von selbst verfällt. Ein zweiter Lauf wird übersprungen und als „locked“ protokolliert. Die Vorgänger mit Options-Lock und Transient blieben bei abgebrochenen Läufen hängen (siehe `05`).
- Vor jedem Schritt prüft ein Heartbeat, ob die Sperre noch gehalten wird. Sonst bricht der Lauf mit Fehler ab.
- Laufstatus (`running`, `completed`, `failed`, `locked`) mit Meldung, Zeitpunkt und aktuellem Schritt wird vor und nach jedem Schritt gespeichert. Bei einem Absturz bleibt sichtbar, wo es hing.
- Das Protokoll ist eine Liste von Zeilen pro Lauf („Step 2 Crawl: 3 von 5 Artikeln erfolgreich gecrawlt.“). Es wird nach jedem Schritt zwischengespeichert und im Backend angezeigt.

### Zeitplan

Intervalle zur Auswahl: 15 Minuten, 30 Minuten, stündlich (Standard), zweimal täglich, täglich. Nach dem Speichern der Einstellungen wird neu geplant, erster Lauf eine Minute später. Fehlt der geplante Job, legt das Plugin ihn beim nächsten Seitenaufruf neu an.

## Schritt 0: Fehlversuche wiederholen

Nimmt bis zu 200 Einträge mit Status `failed`. Ist `attempts` schon 3 oder mehr, wird der Eintrag aussortiert. Sonst wird `status = retry_status` gesetzt, damit derselbe Lauf ihn wieder aufgreift. Fehlt `retry_status` (Altdaten), wird das Ziel aus dem Präfix der Fehlermeldung abgeleitet: `KI:` → `crawled`, `Publish:` → `approved` bzw. `classified`, sonst `new`.

Fehler laufen immer über eine zentrale Funktion `fail(eintrag, retry_status, fehler)`: Zähler +1, beim dritten Fehler sofort `rejected`, sonst `failed` mit gespeichertem Rücksprung. Fehlertexte werden auf 1900 Zeichen gekürzt.

Bildfehler zählen nicht als Fehlversuch (siehe Schritt Bilder).

## Schritt RSS-Import

- Feeds: eine URL pro Zeile in der Einstellung `feeds`, nur gültige URLs.
- Pro Feed die ersten 30 Items.
- Datumsfenster: Items älter als `import_window` Tage (Standard 2, Bereich 1 bis 7) werden übersprungen. Items ohne Datum werden übernommen.
- Duplikate: übersprungen, wenn `md5(GUID oder Link)` schon als `guid` existiert oder wenn der `url_hash` des Links schon existiert (gleiche Meldung in zwei Feeds oder mit Tracking-Parametern).
- Neuer Eintrag mit Status `new`, Feldern guid, url_hash, feed_url, source_url, source_name (Feed-Titel), title_original, published_at.
- Ein fehlerhafter Feed wird protokolliert und übersprungen, der Lauf geht weiter.

### URL-Normalisierung für `url_hash`

1. Host in Kleinbuchstaben, Schema wird verworfen.
2. Fragment `#…` entfällt.
3. Query-Parameter `utm_*`, `fbclid`, `gclid`, `mc_cid`, `mc_eid`, `ref` entfallen, die übrigen werden nach Name sortiert.
4. Schrägstrich am Pfadende entfällt.
5. Ergebnis `host + pfad + ?query`, davon `md5`.

## Schritt Brave-Themensuche

Läuft nur, wenn `brave_enabled` an ist und Brave-Key, KI-Key und Suchbegriffe vorhanden sind. Der Button „Brave-Themen jetzt suchen“ startet die Suche auch bei ausgeschalteter Option und ignoriert Zeitplan und Pause.

### Wie viele Themen

- Pro Tag sollen `brave_per_day` Themen entstehen (Standard 3, Bereich 1 bis 48), gleichmäßig verteilt zwischen `brave_start_hour` und `brave_end_hour` (Standard 8 und 22, Zeitzone der Website).
- Slot k (0-basiert) ist fällig ab `Mitternacht + (start + k * (ende - start) / n) Stunden`.
- Gesucht werden `fällige Slots - heute schon angelegte Brave-Einträge`, höchstens `max_per_run`. Ist das kleiner als 1, wird nur ein Hinweis protokolliert („Heute 1 von 3 Themen, nächstes ab 15:00 Uhr.“).
- Fand die letzte Suche nichts, wartet die nächste eine Stunde (Zustand `last_try`, `last_found`).
- Manuell: `max(1, brave_per_day - heute angelegt)`, ebenfalls höchstens `max_per_run`.

### Suche

- Endpunkt Brave News Search, eine Anfrage pro Zeile in `brave_queries`, 10 Treffer pro Anfrage.
- Zeile mit Sprachpräfix `de|Suchbegriff` setzt die Suchsprache, ohne Präfix wird englisch gesucht. Für de, fr, es, it, pt, nl wird zusätzlich das Land gesetzt.
- Zeitraum: die letzten `brave_days` Tage (Standard 3, Bereich 1 bis 14).
- 1,1 Sekunden Pause zwischen den Anfragen (Free-Plan: eine Anfrage pro Sekunde).
- Treffer werden über die URL entdoppelt, höchstens 90 insgesamt. Pro Treffer: title, url, description (auf 300 Zeichen gekürzt), age.
- HTTP 429 beendet die Schleife mit dem, was schon da ist. Schlägt schon die erste Anfrage fehl, endet der Schritt mit Fehler.

### Bekannte Überschriften

Für den Abgleich werden gesammelt: die letzten 300 Beitragstitel der Website (veröffentlicht, Entwurf, ausstehend, geplant), Original- und KI-Titel der letzten 300 Queue-Einträge und alle `h1` bis `h4` (ab 15 Zeichen) der Vergleichsseiten aus `brave_compare_urls`. Bereinigt auf 12 bis 220 Zeichen, entdoppelt ohne Groß-/Kleinschreibung. In die KI gehen höchstens 400.

### Themenauswahl

Ein KI-Aufruf (Prompt in `03`) mit Themenprofil, Auswahl-Prompt, bekannten Überschriften und nummerierten Treffern. Antwort `{"topics":[{"headline":"…","sources":[3,7]}]}`. Lässt sich kein JSON lesen, gilt jede Zeile mit mindestens 20 Zeichen und ohne `{` als Überschrift ohne Quellen.

### Anlegen

Für jedes Thema, bis die gewünschte Zahl erreicht ist:

- Überschrift bereinigen (Nummern, Spiegelstriche, Anführungszeichen, Sternchen am Rand entfernen), unter 20 Zeichen verwerfen.
- Quellen über die Nummern auflösen, höchstens 5.
- Doppelt, wenn die GUID schon existiert, die Überschrift laut Wortvergleich doppelt ist oder der `url_hash` der ersten Quelle schon existiert.
- Neuer Eintrag mit `feed_url = brave:search`, `source_name = Brave-Themensuche`, Quellen als JSON in `source_list`, Überschrift als `title_original`. Die neue Überschrift zählt ab sofort zu den bekannten.

### Wortvergleich (Sicherheitsnetz hinter der KI)

Wörter in Kleinbuchstaben, Satzzeichen raus, nur Wörter ab 3 Zeichen ohne Stoppwörter. Stoppwörter: the, and, for, with, new, how, you, your, now, can, that, this, from, der, die, das, und, mit, für, von, ein, eine, ist, neue, neu, wie, zum, zur, den, dem, des, jetzt, auf, bei, sie, ihr, was. Haben beide Überschriften mindestens 3 solche Wörter und ist `Schnittmenge / Vereinigung >= 0,5`, gilt das Thema als behandelt.

## Schritt Crawl (RSS) und Recherche (Brave)

Nimmt bis zu `max_per_run` Einträge mit Status `new`.

### Crawl einer Artikel-URL

- Abruf mit Browser-Kennung (Chrome unter Windows) und Kopfzeilen wie ein Browser, Sprache Deutsch bevorzugt (siehe `04`). Zeitlimit 30 s, höchstens 3 Weiterleitungen, Antwort höchstens 2 MiB, Schutz gegen Abrufe ins interne Netz (SSRF).
- Antwort außerhalb 200 bis 299 ist ein Fehler („HTTP 410“).
- Vor dem Parsen werden `script`, `style`, `noscript`, `iframe`, `svg`, `form`, `nav`, `footer`, `header`, `aside` samt Inhalt entfernt.
- Text aus dem ersten `article`, sonst dem ersten `main`. Unter 300 Zeichen: Text des ganzen `body`. Immer noch unter 300: alle Tags entfernen.
- Leerzeichen zusammenfassen, mehr als zwei Zeilenumbrüche auf zwei kürzen, auf 15 000 Zeichen kürzen.
- Unter 300 Zeichen ist ein Fehler („extrahierter Text zu kurz“).
- Erfolg: `full_content` setzen, Status `crawled`. Fehler: `fail(…, 'new', 'Crawl: …')`.

### Recherche für Brave-Themen

1. Quellen aus `source_list`. Sind es weniger als 2: eine Nachsuche mit Suchsprache aus der Ausgabesprache, den ersten 12 Wörtern der Überschrift, 8 Treffern und Zeitraum `brave_days + 4`. Neue URLs werden angehängt.
2. Hosts von YouTube, X/Twitter, Facebook, TikTok, Instagram, LinkedIn und Reddit fallen weg (auch Subdomains), ebenso URLs ohne Host.
3. Höchstens 8 Quellen bleiben, von denen die ersten 4 per Crawl gelesen werden, je höchstens 3500 Zeichen. Abruffehler lassen den Text leer.
4. Verwertbar ist eine Quelle mit URL und Text oder Beschreibung, höchstens 5.
5. Summe aus Text und Beschreibung aller verwertbaren Quellen unter 300 Zeichen ist ein Fehler („Keine verwertbaren Quellen gefunden“).
6. Ergebnis als `full_content` in diesem Format:

```
[Quelle 1] Titel
URL: https://…
Zusammenfassung: Beschreibung aus der Suche
Auszug: gelesener Text (nur wenn vorhanden)

[Quelle 2] …
```

`source_list` wird auf `{title, url}` der verwertbaren Quellen reduziert, `source_url` und `url_hash` auf die erste davon gesetzt. Status `crawled`. Fehler: `fail(…, 'new', 'Recherche: …')`.

## Schritt KI-Klassifikation und Rewrite

Nimmt bis zu `max_per_run` Einträge mit Status `crawled`. Ein einziger KI-Aufruf pro Artikel erledigt Relevanzprüfung, Text, Teaser, SEO-Felder, Kategorie, Bildbriefing und Tags. Prompt und Antwortformat stehen in `03`.

- Eingangstext gekürzt auf 12 000 Zeichen (RSS) bzw. 20 000 Zeichen (Brave).
- Länge: pro Artikel zufällig eine der angehakten Stufen. Stufen: kurz 300 bis 500, mittel 500 bis 800, lang 800 bis 1200 Wörter. Standard RSS kurz und mittel, Brave mittel und lang.
- Token-Limit der Antwort: `min(12000, Höchstwortzahl * 4 + 2000)`.
- Schreibstil: für RSS `style_rss`, für Brave `style_brave`, jeweils optional.
- Antwort als JSON lesen (siehe `03`, robustes Auslesen). Nicht lesbar ist ein Fehler.
- `relevant: false`: Status `rejected`, Grund aus `reason` in `error`.
- `relevant: true`: Felder übernehmen. Gedankenstriche werden aus Titel, Text, Teaser, SEO-Titel und SEO-Description entfernt: ` – ` bzw. ` — ` mit Leerzeichen wird zu `, `, übrige `–` und `—` werden zu `-`. Tags bereinigen: `#` und Leerraum am Rand weg, leere raus, Duplikate ohne Groß-/Kleinschreibung raus, auf `max_tags` kürzen. Status `classified`.
- Fehler (API, JSON): `fail(…, 'crawled', 'KI: …')`.

## Schritt Teaserbilder

- Nur wenn `images_enabled` an ist.
- Kandidaten: Status `classified` (mit manueller Freigabe auch `approved`), noch ohne Bild, mit Bildbriefing. Höchstens `max_per_run`, älteste zuerst.
- Bild per fal.ai oder OpenRouter aus dem `image_briefing` erzeugen (siehe `04`).
- Prüfung der Bilddaten: nur JPEG, PNG oder WebP, ermittelt aus dem Inhalt, nicht aus Endung oder Header. Höchstens 8 MiB. Base64 wird streng dekodiert. Bild-URLs des Anbieters werden wie fremde URLs gegen SSRF geprüft.
- PNG wird in JPEG mit Qualität 80 umgewandelt (Gemini liefert PNGs um 2 MB bei 1408 × 768).
- Dateiname `knp-teaser-{id}.{endung}`, Alt-Text und Titel = KI-Titel.
- Fehler blockieren nicht: nur „Bild: …“ in `error`, kein Fehlversuch. Der Artikel wird ohne Bild veröffentlicht, falls er vorher dran ist.

## Schritt Veröffentlichung

- Quelle: Status `approved`, wenn manuelle Freigabe an ist, sonst `classified`. Höchstens `max_per_run`.
- Zeitbudget 120 Sekunden pro Lauf. Danach endet der Schritt regulär, der Rest folgt im nächsten Lauf.
- Fortschritt wird pro Artikel und Phase protokolliert (Kategorie, Inhalt, Beitrag anlegen, Kategorie setzen, Tags, Bild, SEO, Herkunft), damit ein Hänger eindeutig einem Artikel und einer Phase zuzuordnen ist.

### Idempotenz

Vor dem Anlegen wird geprüft, ob es schon einen Beitrag zu diesem Queue-Eintrag gibt: zuerst über die gespeicherte Queue-ID am Beitrag (`_knp_article_id`), sonst über gleichen Titel plus gleiche ersten 160 Zeichen des Textes ohne HTML. Gibt es ihn, wird er vervollständigt statt doppelt angelegt. Grund: abgebrochene Läufe hatten Teilbeiträge hinterlassen.

### Beitrag

- Titel: KI-Titel ohne HTML. Auszug: Teaser. Status: `post_status` (Entwurf, ausstehend oder veröffentlicht; Standard Entwurf). Autor: `author_id`.
- Slug im Plugin: `knp-{queue-id}-{erste 12 Zeichen von md5(Titel)}`. Für Node besser einen lesbaren Slug aus dem Titel bauen und Kollisionen abfangen.
- Inhalt: KI-HTML, gefiltert auf `p, h2, h3, ul, ol, li, strong, em, a[href, rel], blockquote, div[id]`.
- Quellenangabe, wenn `add_source_link` an ist:
  - RSS: `<div id="knp-source-attribution"><p>Quelle: <a href="…" rel="nofollow noopener" target="_blank">Feed-Titel oder Host</a></p></div>`
  - Brave: `<div id="knp-source-attribution"><p>Quellen:</p><ul><li><a …>Titel oder Host</a></li>…</ul></div>` mit bis zu 5 Links.
- KI-Hinweis, wenn `ai_disclosure` nicht leer ist: `<div id="knp-ai-disclosure"><p>Text</p></div>`. Die IDs dienen dem Theme-Styling.
- Kategorie: `category_key` über die Kategorienliste auf einen Namen abbilden. Gibt es die Kategorie mit diesem Namen nicht, wird sie angelegt. Unbekannter Key: keine Kategorie.
- Tags setzen, Beitragsbild setzen, SEO-Titel und Meta-Description speichern (WordPress: Rank Math und Yoast gleichzeitig).
- Herkunft am Beitrag speichern: Queue-ID und Quell-URL.
- Erfolg: `post_id` setzen, Status `published`. Fehler: `fail(…, approved bzw. classified, 'Publish: …')`.

## Einstellungen

| Schlüssel | Standard | Erlaubt | Zweck |
|---|---|---|---|
| feeds | leer | URLs, eine pro Zeile | RSS-Feeds |
| topic_prompt | Golf-Beispiel (siehe `03`) | Text | Themenprofil der Zeitung |
| categories | Golf-Beispiel | Zeilen `key\|Name` | Kategorien für die KI |
| language | Deutsch | Text | Ausgabesprache, auch für die Brave-Nachsuche |
| ai_provider | anthropic | anthropic, openrouter | |
| ai_api_key | leer | | |
| ai_model | claude-sonnet-4-6 | Text | Modellname vor dem Bau aktuell prüfen |
| images_enabled | aus | an/aus | |
| image_provider | fal | fal, openrouter | |
| image_api_key | leer | | |
| image_model | fal-ai/flux/schnell | Text | bei OpenRouter z. B. google/gemini-2.5-flash-image |
| require_approval | an | an/aus | manuelle Freigabe |
| post_status | draft | draft, pending, publish | |
| author_id | 1 | ab 1 | |
| add_source_link | an | an/aus | |
| ai_disclosure | „Dieser Beitrag wurde mit Unterstützung von KI erstellt und redaktionell geprüft.“ | Text | leer = kein Hinweis |
| tags_enabled | an | an/aus | |
| max_tags | 6 | 3 bis 10 | |
| max_per_run | 5 | 1 bis 25 | pro Schritt und Lauf |
| cron_interval | hourly | 15 min, 30 min, hourly, twicedaily, daily | |
| import_window | 2 | 1 bis 7 Tage | |
| rss_lengths | short,medium | short, medium, long | |
| style_rss, style_brave | leer | ID eines Schreibstils | |
| brave_enabled | aus | an/aus | |
| brave_api_key | leer | | |
| brave_queries | leer | Zeilen, optional `de\|` | |
| brave_days | 3 | 1 bis 14 | |
| brave_per_day | 3 | 1 bis 48 | |
| brave_start_hour | 8 | 0 bis 23 | |
| brave_end_hour | 22 | start+1 bis 24 | |
| brave_compare_urls | leer | URLs, eine pro Zeile | Seiten für den Überschriften-Abgleich |
| brave_prompt | Standardtext (siehe `03`) | Text, leer = Standard | |
| brave_lengths | medium,long | short, medium, long | |
| brave_structure | Standardtext (siehe `03`) | Text, leer = Standard | |

Im Backend sind die Einstellungen in sechs Reitern gruppiert: Allgemein & KI, RSS-Feeds, Brave-Themensuche, Tags & Bilder, Veröffentlichung, Zeitplan. Seltene Brave-Felder stecken unter „Erweitert“.

## Schreibstile

Ein Schreibstil hat ID, Name (höchstens 80 Zeichen, eindeutig ohne Groß-/Kleinschreibung), Stilanweisung (höchstens 3000 Zeichen) und optional einen Beispieltext (höchstens 8000 Zeichen). Gespeichert werden darf er mit einer Anweisung ab 30 Zeichen oder einem Beispieltext ab 200 Zeichen.

Funktionen im Backend: anlegen, ändern, löschen, Anweisung aus einem Beispieltext ableiten lassen, Probetext im Stil schreiben lassen, beim Speichern direkt für RSS oder Brave auswählen. Wird ein verwendeter Stil gelöscht, fällt die Auswahl auf „kein Stil“ zurück. Prompts in `03`.

## Backend-Funktionen

- Queue mit Statusfilter und Zählern je Status, Spalten unter anderem Titel, Quelle, Status, Kategorie, Tags, Fehler mit Versuchszahl.
- Aktionen pro Eintrag und als Sammel-Aktion: Freigeben, Aussortieren, Erneut versuchen, Löschen. Checkboxen mit „Alle auswählen“.
- Buttons „Pipeline jetzt ausführen“ und „Brave-Themen jetzt suchen“.
- Anzeige von Laufstatus, letztem Protokoll und Brave-Zeitplan („Heute 1 von 3 Themen …“).
- Einstellungen in Reitern, Seite Schreibstile, Changelog-Seite.
