/**
 * Schritt Crawl und Recherche (Status `new` → `crawled`):
 * - RSS-Meldungen: Volltext der Artikelseite laden.
 * - Brave-Themen: Quellen lesen und zu einem Recherchetext bündeln, bei weniger als 2 Quellen vorher
 *   eine Nachsuche. Soziale Netzwerke liefern keinen Artikeltext und fallen weg.
 */
import { DailyLimitError, type PipelineContext, type RunState, type StepResult } from "../context";
import { BraveRateLimitError, langFromLanguage, type BraveResult } from "../brave";
import { crawlArticle, fetchPageHtml } from "../fetchPage";
import { extractArticleText } from "../html";
import { sourceKindOf, type QueueEntry, type SourceRef } from "../types";
import { hostOf, isHttpUrl, urlHash } from "../urls";

const SOCIAL_HOSTS = ["youtube.com", "youtu.be", "x.com", "twitter.com", "facebook.com", "fb.com", "tiktok.com", "instagram.com", "linkedin.com", "reddit.com"];

export const RESEARCH_MAX_SOURCES = 8;
export const RESEARCH_READ = 4;
export const RESEARCH_EXCERPT_CHARS = 3500;
export const RESEARCH_USABLE = 5;
export const RESEARCH_MIN_CHARS = 300;

export function isSocialHost(url: string): boolean {
  const host = hostOf(url).toLowerCase();
  return SOCIAL_HOSTS.some((s) => host === s || host.endsWith("." + s));
}

/** Recherchetext im Format aus KNP: [Quelle n] Titel / URL / Zusammenfassung / Auszug */
export function formatResearch(sources: { title: string; url: string; desc: string; text: string }[]): string {
  return sources
    .map((s, i) => {
      let block = `[Quelle ${i + 1}] ${s.title || hostOf(s.url)}\nURL: ${s.url}`;
      if (s.desc) block += `\nZusammenfassung: ${s.desc}`;
      if (s.text) block += `\nAuszug: ${s.text}`;
      return block;
    })
    .join("\n\n");
}

async function research(ctx: PipelineContext, run: RunState, entry: QueueEntry): Promise<void> {
  const profile = run.profiles.get(entry.profileId);
  let sources: SourceRef[] = [...(entry.sourceList ?? [])];

  if (sources.length < 2 && run.brave) {
    const words = entry.titleOriginal.split(/\s+/).filter(Boolean).slice(0, 12).join(" ");
    let extra: BraveResult[] = [];
    try {
      extra = await run.brave.search({ query: words, lang: langFromLanguage(run.settings.language), count: 8, days: (profile?.config.braveDays ?? 3) + 4 });
    } catch (e) {
      if (!(e instanceof BraveRateLimitError) && !(e instanceof DailyLimitError)) throw e;
      run.logger.log(`Recherche: Nachsuche für Eintrag ${entry.id} ausgelassen: ${(e as Error).message}`);
    }
    const known = new Set(sources.map((s) => urlHash(s.url)));
    for (const r of extra) {
      const h = urlHash(r.url);
      if (known.has(h)) continue;
      known.add(h);
      sources.push(r);
    }
  }

  sources = sources.filter((s) => isHttpUrl(s.url) && !isSocialHost(s.url)).slice(0, RESEARCH_MAX_SOURCES);
  const read = await Promise.all(
    sources.map(async (s, i) => {
      if (i >= RESEARCH_READ) return "";
      try {
        return extractArticleText(await fetchPageHtml(ctx.http, s.url), RESEARCH_EXCERPT_CHARS);
      } catch {
        return "";
      }
    }),
  );
  const usable = sources
    .map((s, i) => ({ title: s.title, url: s.url, desc: (s.desc ?? "").trim(), text: read[i] ?? "" }))
    .filter((s) => s.url && (s.text || s.desc))
    .slice(0, RESEARCH_USABLE);
  const chars = usable.reduce((n, s) => n + s.text.length + s.desc.length, 0);
  if (chars < RESEARCH_MIN_CHARS) throw new Error("Keine verwertbaren Quellen gefunden");

  await ctx.store.updateEntry(entry.id, {
    fullContent: formatResearch(usable),
    sourceList: usable.map((s) => ({ title: s.title, url: s.url })),
    sourceUrl: usable[0]!.url,
    urlHash: urlHash(usable[0]!.url),
    status: "crawled",
    error: null,
  });
}

export async function crawl(ctx: PipelineContext, run: RunState): Promise<StepResult> {
  const entries = await ctx.store.takeFair(ctx.siteId, ["new"], run.settings.maxPerRun, run.activeProfileIds);
  let rss = 0;
  let rssOk = 0;
  let brave = 0;
  let braveOk = 0;
  for (const entry of entries) {
    const kind = sourceKindOf(entry);
    if (kind === "brave") brave++;
    else rss++;
    try {
      if (kind === "brave") {
        await research(ctx, run, entry);
        braveOk++;
      } else {
        const text = await crawlArticle(ctx.http, entry.sourceUrl);
        await ctx.store.updateEntry(entry.id, { fullContent: text, status: "crawled", error: null });
        rssOk++;
      }
    } catch (e) {
      const prefix = kind === "brave" ? "Recherche" : "Crawl";
      const status = await ctx.store.failEntry(entry, "new", `${prefix}: ${(e as Error).message}`);
      run.logger.log(`${prefix}: Eintrag ${entry.id} (${entry.sourceUrl || entry.titleOriginal}) ${status === "rejected" ? "aussortiert" : "fehlgeschlagen"}: ${(e as Error).message}`);
    }
  }
  const researchNote = brave ? `, Recherche: ${braveOk} von ${brave} Brave-Themen` : "";
  return { summary: `Crawl: ${rssOk} von ${rss} Artikeln erfolgreich gecrawlt${researchNote}.` };
}
