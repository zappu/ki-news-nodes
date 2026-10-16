/**
 * Schritt Veröffentlichung: freigegebene (bzw. ohne Freigabe: klassifizierte) Einträge über den
 * Ziel-Adapter als Beitrag anlegen. Idempotent: gibt es schon einen Beitrag zu diesem Eintrag, wird er
 * vervollständigt statt doppelt angelegt. Jede Phase wird protokolliert, damit ein Hänger eindeutig
 * einem Artikel und einer Phase zuzuordnen ist.
 */
import type { PipelineContext, RunState, StepResult } from "../context";
import { sanitizeArticleHtml } from "../html";
import { contentFingerprint, slugify, stripHtml } from "../text";
import { hostOf } from "../urls";
import { sourceKindOf, type Category, type PostPayload, type QueueEntry } from "../types";

export const MAX_SOURCE_LINKS = 5;

/** Kategoriename für den Beitrag (Entscheidung 0004): feste Kategorie > Schlüssel der KI > Rückfall „News“ */
export function resolveCategory(entry: QueueEntry, fixedCategory: string | null, categories: Category[], fallback: string): string | null {
  if (fixedCategory) return fixedCategory;
  const key = (entry.categoryKey ?? "").trim().toLowerCase();
  const hit = key ? categories.find((c) => c.key.toLowerCase() === key || c.name.toLowerCase() === key) : undefined;
  return hit ? hit.name : fallback || null;
}

export function buildPostPayload(entry: QueueEntry, run: Pick<RunState, "settings" | "profiles">, categories: Category[]): PostPayload {
  const settings = run.settings;
  const profile = run.profiles.get(entry.profileId);
  const kind = sourceKindOf(entry);
  const title = stripHtml(entry.rewrittenTitle ?? entry.titleOriginal);
  let sources: { title: string; url: string }[] = [];
  if (settings.addSourceLink) {
    sources =
      kind === "brave"
        ? (entry.sourceList ?? []).slice(0, MAX_SOURCE_LINKS).map((s) => ({ title: s.title || hostOf(s.url), url: s.url }))
        : [{ title: entry.sourceName || hostOf(entry.sourceUrl), url: entry.sourceUrl }];
  }
  return {
    title,
    slugBase: slugify(title),
    html: sanitizeArticleHtml(entry.rewrittenContent ?? ""),
    excerpt: entry.teaserText ?? "",
    status: settings.postStatus,
    author: settings.author,
    category: resolveCategory(entry, profile?.config.fixedCategory ?? null, categories, settings.fallbackCategory),
    tags: settings.tagsEnabled ? entry.tags : [],
    imageRef: entry.imageRef,
    imageAlt: entry.imageRef ? title : null,
    seoTitle: entry.seoTitle ?? "",
    seoDescription: entry.seoDescription ?? "",
    sources,
    sourceKind: kind,
    aiDisclosure: settings.aiDisclosure.trim(),
    origin: { queueId: entry.id, sourceUrl: entry.sourceUrl },
  };
}

export async function publish(ctx: PipelineContext, run: RunState): Promise<StepResult> {
  const from = run.settings.requireApproval ? "approved" : "classified";
  const entries = await ctx.store.takeByStatus(ctx.siteId, [from], run.settings.maxPerRun);
  if (!entries.length) return { summary: "Veröffentlichung: nichts zu veröffentlichen." };

  let categories: Category[] | null = null;
  let done = 0;
  for (const entry of entries) {
    let phase = "Kategorie";
    try {
      categories ??= await ctx.target.categories();
      phase = "Inhalt";
      const payload = buildPostPayload(entry, run, categories);
      phase = "Beitrag suchen";
      const existing = await ctx.target.findExisting({ queueId: entry.id, title: payload.title, fingerprint: contentFingerprint(payload.html) });
      let ref: string;
      if (existing) {
        phase = "Beitrag vervollständigen";
        await ctx.target.completePost(existing, payload);
        ref = existing;
      } else {
        phase = "Beitrag anlegen";
        ref = (await ctx.target.createPost(payload)).ref;
      }
      phase = "Status";
      await ctx.store.updateEntry(entry.id, { postRef: ref, status: "published", error: null });
      run.logger.log(`Veröffentlichung: Eintrag ${entry.id} → Beitrag ${ref}${existing ? " (vervollständigt)" : ""}, Kategorie ${payload.category ?? "keine"}.`);
      done++;
    } catch (e) {
      const status = await ctx.store.failEntry(entry, from, `Publish: ${phase}: ${(e as Error).message}`);
      run.logger.log(`Veröffentlichung: Eintrag ${entry.id} in Phase „${phase}“ ${status === "rejected" ? "aussortiert" : "fehlgeschlagen"}: ${(e as Error).message}`);
    }
  }
  return { summary: `Veröffentlichung: ${done} von ${entries.length} Beiträgen veröffentlicht.` };
}
