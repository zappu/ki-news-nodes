/**
 * Schritt Crawl: Volltext der RSS-Meldungen laden (Status `new` → `crawled`).
 * Die Recherche für Brave-Themen kommt mit Version 0.3.0; solche Einträge bleiben bis dahin liegen.
 */
import type { PipelineContext, RunState, StepResult } from "../context";
import { crawlArticle } from "../fetchPage";

export async function crawl(ctx: PipelineContext, run: RunState): Promise<StepResult> {
  const entries = await ctx.store.takeFair(ctx.siteId, ["new"], run.settings.maxPerRun, run.activeProfileIds, { kind: "rss" });
  let ok = 0;
  for (const entry of entries) {
    try {
      const text = await crawlArticle(ctx.http, entry.sourceUrl);
      await ctx.store.updateEntry(entry.id, { fullContent: text, status: "crawled", error: null });
      ok++;
    } catch (e) {
      const msg = `Crawl: ${(e as Error).message}`;
      const status = await ctx.store.failEntry(entry, "new", msg);
      run.logger.log(`Crawl: Eintrag ${entry.id} (${entry.sourceUrl}) ${status === "rejected" ? "aussortiert" : "fehlgeschlagen"}: ${(e as Error).message}`);
    }
  }
  return { summary: `Crawl: ${ok} von ${entries.length} Artikeln erfolgreich gecrawlt.` };
}
