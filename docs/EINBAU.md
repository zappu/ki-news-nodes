# Einbau in eine SSR-Seite

Anleitung für den Einbau von `ki-news-nodes` in eine Node-Seite nach der SSR-Vorlage (Express, tRPC v11, drizzle/mysql2, Admin mit React 19 und Tailwind 4). Vorbild ist smartwatch-fitnesstracker.de, Branch `news` bzw. ab Version `2026-10-16` im `main`.

## 1. Abhängigkeiten

In der `package.json` der Seite:

```json
"dependencies": {
  "cheerio": "^1.1.2",
  "feedsmith": "^2.6.0",
  "sharp": "^0.35.5",
  "undici": "^7.30.1"
},
"devDependencies": {
  "ki-news-nodes": "github:zappu/ki-news-nodes#vX.Y.Z"
}
```

- Das Paket steht unter **devDependencies**. Plesk installiert mit `omit=dev` und `ignore-scripts` (`.npmrc` der Seite) und holt das private Repo deshalb nie; es wird beim Build auf dem Laptop in `dist/` gebündelt.
- Die Laufzeit-Bibliotheken des Pakets (cheerio, feedsmith, undici, sharp; mysql2 und zod hat die Seite schon) stehen in den **dependencies** der Seite, weil der Build sie extern lässt. sharp bringt seine Binärdatei als optionales Paket mit und braucht keine Install-Skripte (Node ab 20.9).
- Nach jeder Änderung beide Sperrdateien erneuern: `pnpm install` und `npm install --package-lock-only`.

## 2. Alias `@ki-news`

Das Paket wird als TypeScript-Quelle eingebunden. Damit esbuild es trotz `--packages=external` bündelt, wird es über einen Pfad-Alias statt über den Paketnamen importiert.

`tsconfig.json`:

```json
"paths": {
  "@ki-news": ["./node_modules/ki-news-nodes/src/index.ts"],
  "@ki-news/*": ["./node_modules/ki-news-nodes/src/*"]
}
```

`vite.config.ts` und `vitest.config.ts` (bei `resolve.alias`):

```ts
"@ki-news": path.resolve(import.meta.dirname, "node_modules", "ki-news-nodes", "src"),
```

`client/src/admin/index.css`, damit Tailwind die Klassen der News-Seiten findet:

```css
@source "../../../node_modules/ki-news-nodes/src/admin/ui";
```

Im Build-Skript `scripts/news.ts` zum zweiten esbuild-Aufruf (Skripte nach `dist/scripts`) hinzufügen und in `package.json` `"news": "node dist/scripts/news.js"` ergänzen.

## 3. Umgebungsvariablen

In `server/_core/env.ts`:

| Variable | Zweck |
|---|---|
| `BRAVE_API_KEY` | Brave-Themensuche; ohne Schlüssel nur RSS |
| `FAL_KEY` | Teaserbilder über fal.ai; alternativ `OPENROUTER_API_KEY` (hat die Seite schon) |
| `NEWS_SITE_ID` | Kennung der Seite in den `news_`-Tabellen, Standard `main` |

Die Schlüssel stehen nur in der `.env`, nie in der Datenbank und nie in einer API-Antwort. Der Admin zeigt nur, ob sie gesetzt sind.

## 4. Ziel-Adapter `server/news/adapter.ts`

`createBlogTarget()` liefert ein `PublishTarget`:

- `categories()`: Kategorien aus `shared/pages.ts`, Schlüssel = Slug, „News“ immer dabei.
- `recentTitles()`, `findExisting()`: aus `blog_posts` (Rückfall: gleicher Titel unter den letzten 200 Beiträgen). Die eigentliche Idempotenz macht das Paket über `news_post_links`.
- `uploadImage()`: `storagePut` nach `blog/news/<dateiname>`, Rückgabe der URL als `ref`.
- `createPost()`: KI-HTML mit turndown (GFM) in Markdown, Quellen als `Quelle: <a … rel="nofollow noopener" target="_blank">` bzw. Liste unter `**Quellen:**`, KI-Hinweis kursiv; dann `createPost` der Seite mit Kategorie, Tags (Rückfall `["News"]`), SEO-Titel und -Beschreibung, Teaserbild.
- `completePost()`: Status setzen, falls der Beitrag zunächst als Entwurf angelegt wurde.

Der Markdown-Renderer der Seite muss ein `nofollow` aus dem Artikel erhalten (in smartwatch-fitnesstracker.de seit `2026-10-16` in `server/views/components.tsx`).

## 5. Kontext, Admin-Dienst und Start `server/news/index.ts`

- `newsStore()`: `createNewsStore({ url, connectionLimit: 3 })`, eigener Pool in UTC.
- `newsContext()`: `siteId`, `store`, `http: createHttpClient()`, `llm` über die KI-Kette der Seite (`callLlm` mit `system`, `user`, `maxTokens`, `timeoutMs`; `null` ohne Schlüssel), `target`, `braveApiKey`, `imageKeys`, `adminUrl` (`absoluteUrl("/admin/news")`), `notify` über den Mailversand der Seite an `ADMIN_EMAILS` (nur wenn Mail eingerichtet ist).
- `newsAdmin()`: `createNewsAdmin({ siteId, store, buildContext, keys })`; `keys` sagt nur, welche Schlüssel vorhanden sind.
- `initNews()`: beim Start der App `store.migrate()` (in `server/_core/index.ts` nach `initLlmSettings`).
- `newsCliEnvironment()`: für das Cron-Skript.

## 6. Router `server/news/router.ts`

Eine Zeile je Funktion, Eingaben aus `newsInputs` des Pakets, immer `adminProcedure`:

```ts
overview: adminProcedure.input(newsInputs.overview).query(({ input }) => newsAdmin().overview(input)),
bulk: adminProcedure.input(newsInputs.bulk).mutation(({ input }) => newsAdmin().bulk(input)),
```

Abfragen: `overview`, `queue`, `entry`, `settings`, `profiles`, `categories`, `runs`, `run` (`NEWS_QUERIES`). Änderungen: `bulk`, `saveSettings`, `saveProfile`, `deleteProfile`, `start`, `testFeed` (`NEWS_MUTATIONS`). In `server/routers.ts` als `news: newsRouter` einhängen. Warum die Seite diese Datei selbst hält, steht in Entscheidung 0005.

## 7. Admin-Seite und Dashboard-Kachel

`client/src/admin/pages/News.tsx`:

```tsx
const utils = trpc.useUtils();
return <NewsAdmin client={utils.client.news} notify={{ success: toast.success, error: toast.error }} homeHref="/admin" />;
```

Route `/news` in `App.tsx`, Menüpunkt „News“, Kachel im Dashboard mit `trpc.news.overview.useQuery({}, { retry: false })`. Die UI importiert vom Server nur Typen, das Admin-Bundle enthält keine Server-Bibliotheken.

## 8. Cron-Skript `scripts/news.ts`

```ts
import "../server/_core/loadEnv";
import { runCli } from "@ki-news";
import { closeDb } from "../server/db";
import { newsCliEnvironment } from "../server/news";

const code = await runCli(process.argv.slice(2), newsCliEnvironment);
await closeDb();
process.exit(code);
```

Befehle: `run` (mit Intervallprüfung), `run --force`, `brave`, `status`, `migrate`.

## 9. Auf dem Server einrichten

1. Update einspielen, `.env` um `BRAVE_API_KEY`, `FAL_KEY` und bei Bedarf `NEWS_SITE_ID` ergänzen, App neu starten. Die Tabellen `news_*` entstehen beim Start.
2. Im Admin unter **News → Einstellungen** prüfen: Freigabe nötig (Standard an), Tageslimits, Bildanbieter, Mail bei wartenden Artikeln.
3. Unter **Profile** ein Profil anlegen, Feeds mit „Feed testen“ prüfen, noch inaktiv lassen.
4. In Plesk unter „Geplante Aufgaben“ alle 15 Minuten `node dist/scripts/news.js run` im Ordner der App ausführen. Die Minute je Seite versetzen (zum Beispiel 2, 17, 32, 47), weil sich die Seiten einen Brave-Schlüssel teilen.
5. Profil aktivieren, „Lauf jetzt starten“, Protokoll und Queue prüfen.

## 10. Tests der Seite

`server/news/news.test.ts` prüft Adapter (Markdown, Quellen, Kategorien), einen ganzen Lauf mit Attrappen für HTTP und KI bis in `blog_posts` und den Bildspeicher, die Auslieferung des Artikels und die Admin-Prozeduren (Anmeldung, Base64, Herkunftsprüfung).
