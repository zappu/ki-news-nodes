/**
 * Schritt Brave-Themensuche (KNP 1.10.0 bis 1.12.1): je Profil mit Themensuche zur fälligen Zeit Brave
 * News durchsuchen, die KI wählt neue Themen aus, Duplikate fallen über GUID, Wortvergleich und URL raus.
 * Neue Themen landen als Queue-Eintrag mit `feed_url = brave:search` und ihren Quellen in `source_list`.
 */
import { DailyLimitError, defaultSleep, type PipelineContext, type RunState, type StepResult } from "../context";
import {
  BraveRateLimitError,
  braveSearch,
  braveSlots,
  cleanHeadline,
  dedupeResults,
  formatLocalTime,
  isSimilarHeadline,
  normalizeKnownHeadlines,
  parseQueryLine,
  type BraveResult,
  type BraveSearchOptions,
} from "../brave";
import { fetchPageHtml } from "../fetchPage";
import { extractHeadings } from "../html";
import { extractJson, JsonExtractError } from "../json";
import { BRAVE_SELECT_MAX_TOKENS, braveSelectSystemPrompt, braveSelectUserPrompt, DEFAULT_BRAVE_PROMPT } from "../prompts";
import type { Profile } from "../settings";
import { BRAVE_FEED_MARK } from "../types";
import { braveGuid, urlHash } from "../urls";
import { localDayKey } from "../time";
import { LLM_TIMEOUT_MS } from "./classify";

export const BRAVE_SOURCE_NAME = "Brave-Themensuche";
export const KNOWN_TITLES_LIMIT = 300;
export const KNOWN_TO_PROMPT = 400;
export const MAX_TOPIC_SOURCES = 5;
/** Fand die letzte Suche nichts, wartet die nächste so lange */
export const EMPTY_SEARCH_WAIT_MS = 3_600_000;

export interface BraveSession {
  search(o: Omit<BraveSearchOptions, "apiKey" | "now" | "tz">): Promise<BraveResult[]>;
}

/**
 * Brave-Zugang für einen Lauf: Tageslimit je Seite (`dailyBraveLimit`), Pause zwischen den Anfragen
 * (`braveDelayMs`), jede Anfrage wird in `news_usage` gezählt. Null ohne Brave-Schlüssel.
 */
export function createBraveSession(ctx: PipelineContext, run: Pick<RunState, "settings" | "dayKey" | "now">): BraveSession | null {
  const apiKey = ctx.braveApiKey?.trim();
  if (!apiKey) return null;
  const sleep = ctx.sleep ?? defaultSleep;
  let last = 0;
  return {
    async search(o) {
      const limit = run.settings.dailyBraveLimit;
      if (limit > 0 && (await ctx.store.getUsage(ctx.siteId, run.dayKey, "brave")) >= limit) {
        throw new DailyLimitError(`Tageslimit von ${limit} Brave-Anfragen erreicht, weiter morgen`);
      }
      const wait = last ? run.settings.braveDelayMs - (Date.now() - last) : 0;
      if (wait > 0) await sleep(wait);
      await ctx.store.incrementUsage(ctx.siteId, run.dayKey, "brave");
      last = Date.now();
      return braveSearch(ctx.http, { ...o, apiKey, now: run.now(), tz: run.settings.timezone });
    },
  };
}

export interface Topic {
  headline: string;
  sources: number[];
}

/** Antwort der Themenauswahl; ohne lesbares JSON gilt jede Zeile ab 20 Zeichen ohne `{` als Überschrift */
export function parseTopics(raw: string): Topic[] {
  try {
    const v = extractJson(raw);
    const list = Array.isArray(v.topics) ? (v.topics as unknown[]) : [];
    return list
      .map((t) => {
        const o = (t && typeof t === "object" ? t : {}) as Record<string, unknown>;
        const sources = Array.isArray(o.sources) ? o.sources.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0) : [];
        return { headline: typeof o.headline === "string" ? o.headline : "", sources };
      })
      .filter((t) => t.headline);
  } catch (e) {
    if (!(e instanceof JsonExtractError)) throw e;
    return raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length >= 20 && !l.includes("{"))
      .map((headline) => ({ headline, sources: [] }));
  }
}

/** Alle Suchbegriffe eines Profils abfragen; 429 beendet die Schleife mit dem, was schon da ist */
async function searchAll(session: BraveSession, profile: Profile, log: (l: string) => void): Promise<BraveResult[]> {
  const all: BraveResult[] = [];
  const queries = profile.config.braveQueries;
  for (let i = 0; i < queries.length; i++) {
    const { query, lang } = parseQueryLine(queries[i]!);
    if (!query) continue;
    try {
      all.push(...(await session.search({ query, lang, count: 10, days: profile.config.braveDays })));
    } catch (e) {
      if (e instanceof DailyLimitError) throw e;
      if (e instanceof BraveRateLimitError) {
        log(`Brave (${profile.name}): Anfragelimit erreicht, Suche mit ${all.length} Treffern beendet.`);
        break;
      }
      if (i === 0) throw e;
      log(`Brave (${profile.name}): Suche „${query}“ fehlgeschlagen: ${(e as Error).message}`);
    }
  }
  return dedupeResults(all);
}

async function compareHeadings(ctx: PipelineContext, profile: Profile, log: (l: string) => void): Promise<string[]> {
  const out: string[] = [];
  for (const url of profile.config.braveCompareUrls) {
    try {
      out.push(...extractHeadings(await fetchPageHtml(ctx.http, url, 20_000)));
    } catch (e) {
      log(`Brave (${profile.name}): Vergleichsseite ${url} nicht lesbar: ${(e as Error).message}`);
    }
  }
  return out;
}

export interface BraveDiscoverOptions {
  /** Knopf „Brave-Themen jetzt suchen“: ignoriert Schalter, Zeitplan und Pause */
  manual?: boolean;
}

export async function braveDiscover(ctx: PipelineContext, run: RunState, opts: BraveDiscoverOptions = {}): Promise<StepResult> {
  const profiles = run.activeProfileIds.map((id) => run.profiles.get(id)!).filter((p) => (opts.manual || p.config.braveEnabled) && p.config.braveQueries.length);
  if (!profiles.length) return { summary: opts.manual ? "Brave: kein aktives Profil mit Suchbegriffen." : "Brave: Themensuche ist in keinem aktiven Profil eingeschaltet." };
  const session = run.brave;
  if (!session) return { summary: "Brave: kein Brave-Schlüssel hinterlegt (BRAVE_API_KEY)." };
  if (!run.llm) return { summary: "Brave: kein KI-Schlüssel hinterlegt." };

  const log = (l: string) => run.logger.log(l);
  const now = run.now();
  const tz = run.settings.timezone;
  let siteKnown: string[] | null = null;
  let createdTotal = 0;
  let searched = 0;

  for (const profile of profiles) {
    const cfg = profile.config;
    const createdToday = await ctx.store.countBraveSince(ctx.siteId, profile.id, run.dayStart);
    let want: number;
    if (opts.manual) {
      want = Math.max(1, cfg.bravePerDay - createdToday);
    } else {
      const slots = braveSlots(now, tz, cfg.bravePerDay, cfg.braveStartHour, cfg.braveEndHour);
      want = slots.due - createdToday;
      if (want < 1) {
        log(`Brave (${profile.name}): Heute ${createdToday} von ${cfg.bravePerDay} Themen${slots.next ? `, nächstes ab ${formatLocalTime(slots.next, tz)} Uhr` : ""}.`);
        continue;
      }
      const lastTry = Number((await ctx.store.getState(ctx.siteId, `brave_last_try_${profile.id}`)) ?? 0);
      const lastFound = await ctx.store.getState(ctx.siteId, `brave_last_found_${profile.id}`);
      if (lastFound === "0" && now.getTime() - lastTry < EMPTY_SEARCH_WAIT_MS) {
        log(`Brave (${profile.name}): letzte Suche ohne neues Thema, nächster Versuch ab ${formatLocalTime(new Date(lastTry + EMPTY_SEARCH_WAIT_MS), tz)} Uhr.`);
        continue;
      }
    }
    want = Math.min(want, run.settings.maxPerRun);

    try {
      searched++;
      const results = await searchAll(session, profile, log);
      await ctx.store.setState(ctx.siteId, `brave_last_try_${profile.id}`, String(now.getTime()));
      if (!results.length) {
        await ctx.store.setState(ctx.siteId, `brave_last_found_${profile.id}`, "0");
        log(`Brave (${profile.name}): keine Treffer.`);
        continue;
      }

      siteKnown ??= [...(await ctx.target.recentTitles(KNOWN_TITLES_LIMIT)), ...(await ctx.store.recentQueueTitles(ctx.siteId, KNOWN_TITLES_LIMIT))];
      const known = normalizeKnownHeadlines([...siteKnown, ...(await compareHeadings(ctx, profile, log))]);

      const raw = await run.llm({
        system: braveSelectSystemPrompt(cfg.topicPrompt, localDayKey(now, tz)),
        user: braveSelectUserPrompt({
          bravePrompt: cfg.bravePrompt.trim() || DEFAULT_BRAVE_PROMPT,
          known: known.slice(0, KNOWN_TO_PROMPT),
          results,
          days: cfg.braveDays,
          count: want,
          language: run.settings.language,
        }),
        maxTokens: BRAVE_SELECT_MAX_TOKENS,
        timeoutMs: LLM_TIMEOUT_MS,
        purpose: "brave-select",
      });

      let created = 0;
      let duplicates = 0;
      for (const topic of parseTopics(raw)) {
        if (created >= want) break;
        const headline = cleanHeadline(topic.headline);
        if (headline.length < 20) continue;
        const seenUrls = new Set<string>();
        const sources = topic.sources
          .map((n) => results[n - 1])
          .filter((r): r is BraveResult => !!r && !seenUrls.has(r.url) && !!seenUrls.add(r.url))
          .slice(0, MAX_TOPIC_SOURCES);
        const guid = braveGuid(headline);
        const firstHash = sources[0] ? urlHash(sources[0].url) : null;
        if (
          (await ctx.store.guidExists(ctx.siteId, guid)) ||
          known.some((k) => isSimilarHeadline(k, headline)) ||
          (firstHash && (await ctx.store.urlHashExists(ctx.siteId, firstHash)))
        ) {
          duplicates++;
          continue;
        }
        const id = await ctx.store.insertEntry({
          siteId: ctx.siteId,
          profileId: profile.id,
          guid,
          urlHash: firstHash,
          feedUrl: BRAVE_FEED_MARK,
          sourceUrl: sources[0]?.url ?? "",
          sourceName: BRAVE_SOURCE_NAME,
          sourceList: sources,
          titleOriginal: headline,
          publishedAt: now,
        });
        if (!id) {
          duplicates++;
          continue;
        }
        known.push(headline);
        created++;
      }
      await ctx.store.setState(ctx.siteId, `brave_last_found_${profile.id}`, String(created));
      createdTotal += created;
      log(`Brave (${profile.name}): ${created} neue Themen aus ${results.length} Treffern${duplicates ? `, ${duplicates} schon behandelt` : ""}.`);
    } catch (e) {
      if (e instanceof DailyLimitError) {
        log(`Brave (${profile.name}): ${e.message}.`);
        break;
      }
      log(`Brave (${profile.name}): Suche fehlgeschlagen: ${(e as Error).message}`);
    }
  }
  return { summary: `Brave: ${createdTotal} neue Themen (${searched} Profil${searched === 1 ? "" : "e"} durchsucht).` };
}
