# Externe Dienste (so wie KNP 1.12.1 sie aufruft)

Endpunkte, Header und Felder sind aus dem Plugin-Code übernommen. Modellnamen und API-Versionen vor dem Bau gegen die aktuelle Dokumentation der Anbieter prüfen.

## Anthropic (Text)

- `POST https://api.anthropic.com/v1/messages`
- Header: `Content-Type: application/json`, `x-api-key: {Key}`, `anthropic-version: 2023-06-01`
- Body:

```json
{
  "model": "{ai_model}",
  "max_tokens": 4000,
  "system": "{System-Prompt}",
  "messages": [{ "role": "user", "content": "{User-Nachricht}" }]
}
```

- Zeitlimit 180 s.
- Antwort: alle Blöcke in `content` mit `type: "text"` aneinanderhängen. Leer ist ein Fehler.
- Fehler: HTTP ungleich 200, Meldung aus `error.message`, sonst „HTTP {code}“. Fehlertext mit Präfix „Anthropic API: “.

## OpenRouter (Text)

- `POST https://openrouter.ai/api/v1/chat/completions`
- Header: `Content-Type: application/json`, `Authorization: Bearer {Key}`, `HTTP-Referer: {URL der Website}`, `X-Title: KI News Publisher`
- Body:

```json
{
  "model": "{ai_model}",
  "max_tokens": 4000,
  "messages": [
    { "role": "system", "content": "{System-Prompt}" },
    { "role": "user", "content": "{User-Nachricht}" }
  ]
}
```

- Zeitlimit 180 s.
- Antwort: `choices[0].message.content`. Leer ist ein Fehler.
- Fehler wie bei Anthropic, Präfix „OpenRouter API: “.

Beide Anbieter laufen über eine gemeinsame Funktion `complete(system, user, maxTokens)`, die Klassifikation, Themenauswahl, Stil-Ableitung und Probetext nutzen. `max_tokens` je Aufruf: Klassifikation dynamisch (siehe `02`), Themenauswahl 2000, Stil ableiten 600, Probetext 700.

## Brave Search API

- Basis `https://api.search.brave.com/res/v1/`, genutzt wird nur `news/search`.
- Header: `Accept: application/json`, `X-Subscription-Token: {Brave-Key}`
- Query-Parameter (RFC-3986-kodiert):

| Parameter | Wert |
|---|---|
| q | Suchbegriff ohne Sprachpräfix |
| count | 10 (Themensuche) bzw. 8 (Nachsuche) |
| freshness | Zeitraum `JJJJ-MM-TTtoJJJJ-MM-TT`, von heute minus X Tage bis heute |
| search_lang | aus dem Präfix, sonst `en` |
| spellcheck | 0 |
| country | DE, FR, ES, IT, PT, NL für die entsprechende Sprache, sonst weggelassen |

- Zeitlimit 30 s.
- Antwort: `results[]` mit `title`, `url`, `description`, `age`. Titel und Beschreibung können HTML enthalten, das entfernt wird.
- HTTP 429: „Anfragelimit erreicht“, Suche bricht ab. Andere Codes ungleich 200: Fehler mit den ersten 200 Zeichen der Antwort.
- Free-Plan: eine Anfrage pro Sekunde, deshalb 1,1 s Pause zwischen Anfragen.

## fal.ai (Bild)

- `POST https://fal.run/{image_model}`, z. B. `https://fal.run/fal-ai/flux/schnell` (synchroner Aufruf)
- Header: `Content-Type: application/json`, `Authorization: Key {fal-Key}`
- Body:

```json
{ "prompt": "{image_briefing}", "image_size": "landscape_16_9", "num_images": 1 }
```

- Zeitlimit 120 s.
- Antwort: Bild-URL in `images[0].url`. Fehlt sie, ist das ein Fehler. Danach wird das Bild von dieser URL geladen.

## OpenRouter (Bild)

- `POST https://openrouter.ai/api/v1/chat/completions`, Header wie bei Text, Key aus `image_api_key`
- Body:

```json
{
  "model": "{image_model, z. B. google/gemini-2.5-flash-image}",
  "modalities": ["image", "text"],
  "messages": [{ "role": "user", "content": "{image_briefing}" }]
}
```

- Zeitlimit 120 s.
- Antwort: `choices[0].message.images[0].image_url.url`. Meist eine Data-URL `data:image/png;base64,…`, sonst eine normale URL.

## Bilddaten übernehmen

- Data-URL nur, wenn sie dem Muster `data:image/(jpeg|png|webp);base64,…` folgt. Base64 streng dekodieren, Größe vorher und nachher gegen 8 MiB prüfen.
- Normale URL nur nach SSRF-Prüfung, höchstens 3 Weiterleitungen, höchstens 8 MiB, Zeitlimit 120 s, Antwort 200 bis 299.
- Den Bildtyp aus den Bytes bestimmen (in PHP `getimagesize`, in Node z. B. `sharp(...).metadata()`), erlaubt sind JPEG, PNG, WebP.
- PNG in JPEG mit Qualität 80 umwandeln.

## Quellseiten abrufen (Crawl, Recherche, Vergleichsseiten)

Seit 1.12.1 meldet sich das Plugin wie ein Browser:

```
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36
Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8
Accept-Language: de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7
Cache-Control: no-cache
Pragma: no-cache
Upgrade-Insecure-Requests: 1
```

Crawl und Recherche: Zeitlimit 30 s. Vergleichsseiten: 20 s, nur HTTP 200 zählt. Beide mit höchstens 3 Weiterleitungen und 2 MiB.

Die Chrome-Version im User-Agent veraltet mit der Zeit. Im Node-Projekt als Einstellung oder Konstante führen und gelegentlich anheben.

## RSS

Im Plugin über die WordPress-Funktion `fetch_feed()` (SimplePie). Genutzt werden pro Item: Datum, Link (Permalink), ID/GUID, Titel und der Feed-Titel. RSS 2.0 und Atom kommen beide vor.
