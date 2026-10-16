/**
 * Schritt KI-Klassifikation und Rewrite: ein KI-Aufruf pro Eintrag erledigt Relevanzprüfung, Text,
 * Teaser, SEO-Felder, Kategorie, Bildbriefing und Tags (Status `crawled` → `classified` oder `rejected`).
 */
import { DailyLimitError, type PipelineContext, type RunState, type StepResult } from "../context";
import { sanitizeArticleHtml } from "../html";
import { extractJson } from "../json";
import { classifyMaxTokens, pickLength } from "../lengths";
import {
  braveUserMessage,
  braveWritingTask,
  classifySystemPrompt,
  DEFAULT_BRAVE_STRUCTURE,
  rssUserMessage,
  rssWritingTask,
} from "../prompts";
import type { Profile } from "../settings";
import { cleanTags, removeDashes, slugify, stripHtml } from "../text";
import { sourceKindOf, type Category, type QueueEntry } from "../types";

export const LLM_TIMEOUT_MS = 180_000;

/** Kategorien, aus denen die KI für dieses Profil wählt; bei fester Kategorie nur diese eine */
export function categoriesForProfile(profile: Profile, siteCategories: Category[]): Category[] {
  const fixed = profile.config.fixedCategory;
  if (!fixed) return siteCategories;
  const match = siteCategories.find((c) => c.name.toLowerCase() === fixed.toLowerCase() || c.key.toLowerCase() === fixed.toLowerCase());
  return [match ?? { key: slugify(fixed), name: fixed }];
}

export interface ClassifyResult {
  relevant: boolean;
  reason?: string;
  title?: string;
  contentHtml?: string;
  teaser?: string;
  seoTitle?: string;
  seoDescription?: string;
  categoryKey?: string;
  imageBriefing?: string;
  tags?: string[];
}

const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** Antwort der KI prüfen und bereinigen (Gedankenstriche, HTML-Positivliste, Tags) */
export function parseClassifyResponse(raw: string, opts: { tagsEnabled: boolean; maxTags: number }): ClassifyResult {
  const v = extractJson(raw);
  const relevant = v.relevant === true || v.relevant === "true";
  if (!relevant) return { relevant: false, reason: s(v.reason) || "Nicht relevant für das Themenprofil" };
  const title = removeDashes(stripHtml(s(v.title)));
  const contentHtml = sanitizeArticleHtml(removeDashes(s(v.content_html)));
  if (!title || !stripHtml(contentHtml)) throw new Error("Antwort ohne Titel oder Text");
  return {
    relevant: true,
    title,
    contentHtml,
    teaser: removeDashes(stripHtml(s(v.teaser))),
    seoTitle: removeDashes(stripHtml(s(v.seo_title))),
    seoDescription: removeDashes(stripHtml(s(v.seo_description))),
    categoryKey: s(v.category_key),
    imageBriefing: stripHtml(s(v.image_briefing)),
    tags: opts.tagsEnabled ? cleanTags(v.tags, opts.maxTags) : [],
  };
}

export function buildClassifyRequest(entry: QueueEntry, profile: Profile, categories: Category[], run: Pick<RunState, "settings" | "random">) {
  const kind = sourceKindOf(entry);
  const cfg = profile.config;
  const length = pickLength(kind === "brave" ? cfg.braveLengths : cfg.rssLengths, run.random);
  const writingTask =
    kind === "brave"
      ? braveWritingTask(run.settings.language, length.min, length.max, cfg.braveStructure.trim() || DEFAULT_BRAVE_STRUCTURE)
      : rssWritingTask(run.settings.language, length.min, length.max);
  const system = classifySystemPrompt({
    topicPrompt: cfg.topicPrompt,
    categories,
    writingTask,
    tagsEnabled: run.settings.tagsEnabled,
    maxTags: run.settings.maxTags,
    style: null, // Schreibstile folgen mit Version 0.7.0
  });
  const user = kind === "brave" ? braveUserMessage(entry.titleOriginal, entry.fullContent ?? "") : rssUserMessage(entry.sourceUrl, entry.titleOriginal, entry.fullContent ?? "");
  return { system, user, maxTokens: classifyMaxTokens(length.max), length };
}

export async function classify(ctx: PipelineContext, run: RunState): Promise<StepResult> {
  // Artikelziel pro Tag je Profil: wer es erreicht hat, wartet bis morgen
  const today = await ctx.store.countClassifiedSince(ctx.siteId, run.dayStart);
  const remaining = new Map<number, number>();
  for (const p of run.profiles.values()) remaining.set(p.id, p.config.dailyTarget - (today.get(p.id) ?? 0));
  const full = [...remaining].filter(([, n]) => n <= 0).map(([id]) => id);

  const entries = await ctx.store.takeFair(ctx.siteId, ["crawled"], run.settings.maxPerRun, run.activeProfileIds, { excludeProfileIds: full });
  const atTarget = full.length ? ` ${full.length} Profil${full.length === 1 ? " hat" : "e haben"} das Tagesziel erreicht.` : "";
  if (!entries.length) return { summary: `KI: keine Einträge zum Schreiben.${atTarget}` };
  if (!run.llm) return { summary: `KI: ${entries.length} Einträge warten, aber es ist kein KI-Schlüssel hinterlegt.` };

  let siteCategories: Category[] | null = null;
  let written = 0;
  let rejected = 0;
  let failed = 0;
  let waiting = 0;
  let limitHit = "";
  for (const entry of entries) {
    const profile = run.profiles.get(entry.profileId);
    if (!profile) {
      await ctx.store.updateEntry(entry.id, { status: "rejected", error: "Profil gelöscht" });
      rejected++;
      continue;
    }
    if ((remaining.get(profile.id) ?? 0) <= 0) {
      waiting++;
      continue;
    }
    try {
      siteCategories ??= await ctx.target.categories();
      const categories = categoriesForProfile(profile, siteCategories);
      const req = buildClassifyRequest(entry, profile, categories, run);
      const raw = await run.llm({ system: req.system, user: req.user, maxTokens: req.maxTokens, timeoutMs: LLM_TIMEOUT_MS, purpose: "classify" });
      const res = parseClassifyResponse(raw, run.settings);
      if (!res.relevant) {
        await ctx.store.updateEntry(entry.id, { status: "rejected", relevance: false, error: res.reason ?? null });
        rejected++;
        continue;
      }
      await ctx.store.updateEntry(entry.id, {
        status: "classified",
        relevance: true,
        rewrittenTitle: res.title!,
        rewrittenContent: res.contentHtml!,
        teaserText: res.teaser ?? "",
        seoTitle: res.seoTitle ?? "",
        seoDescription: res.seoDescription ?? "",
        categoryKey: res.categoryKey || null,
        imageBriefing: res.imageBriefing || null,
        tags: res.tags ?? [],
        classifiedAt: run.now(),
        error: null,
      });
      remaining.set(profile.id, (remaining.get(profile.id) ?? 0) - 1);
      written++;
    } catch (e) {
      if (e instanceof DailyLimitError) {
        limitHit = ` ${e.message}.`;
        break;
      }
      failed++;
      const status = await ctx.store.failEntry(entry, "crawled", `KI: ${(e as Error).message}`);
      run.logger.log(`KI: Eintrag ${entry.id} ${status === "rejected" ? "aussortiert" : "fehlgeschlagen"}: ${(e as Error).message.slice(0, 300)}`);
    }
  }
  const wait = waiting ? `, ${waiting} warten aufs nächste Tagesziel` : "";
  return { summary: `KI: ${written} geschrieben, ${rejected} nicht relevant, ${failed} mit Fehler${wait} (von ${entries.length}).${atTarget}${limitHit}` };
}
