/**
 * Schritt Teaserbilder: für klassifizierte (mit Freigabe auch freigegebene) Einträge ohne Bild aus dem
 * Bildbriefing ein Bild erzeugen und über den Ziel-Adapter ablegen. Bildfehler blockieren nichts
 * (KNP 1.7.0): Sie werden nur als „Bild: …“ notiert, zählen nicht als Fehlversuch, und der Artikel kann
 * ohne Bild erscheinen. Nach zwei gescheiterten Bildversuchen bleibt der Eintrag ohne Bild, damit ein
 * kaputtes Modell nicht jeden Lauf Geld kostet.
 */
import { DailyLimitError, type PipelineContext, type RunState, type StepResult } from "../context";
import { generateTeaserImage } from "../images";
import type { QueueStatus } from "../types";

export const IMAGE_ERROR_PREFIX = "Bild:";
export const IMAGE_ERROR_FINAL = "Bild (2. Versuch):";

export async function teaserImages(ctx: PipelineContext, run: RunState): Promise<StepResult> {
  if (!run.settings.imagesEnabled) return { summary: "Bilder: ausgeschaltet." };
  const statuses: QueueStatus[] = run.settings.requireApproval ? ["classified", "approved"] : ["classified"];
  const candidates = (await ctx.store.takeImageCandidates(ctx.siteId, statuses, run.settings.maxPerRun, IMAGE_ERROR_FINAL));
  if (!candidates.length) return { summary: "Bilder: keine Einträge ohne Bild." };
  const keys = ctx.imageKeys ?? {};
  const provider = run.settings.imageProvider;
  if (!(provider === "fal" ? keys.fal : keys.openrouter)?.trim()) {
    return { summary: `Bilder: ${candidates.length} Einträge warten, aber es ist kein ${provider === "fal" ? "fal.ai-Schlüssel (FAL_KEY)" : "OpenRouter-Schlüssel (OPENROUTER_API_KEY)"} hinterlegt.` };
  }

  let ok = 0;
  let failed = 0;
  let limitHit = "";
  for (const entry of candidates) {
    const limit = run.settings.dailyImageLimit;
    if (limit > 0 && (await ctx.store.getUsage(ctx.siteId, run.dayKey, "image")) >= limit) {
      limitHit = ` Tageslimit von ${limit} Bildern erreicht, weiter morgen.`;
      break;
    }
    try {
      await ctx.store.incrementUsage(ctx.siteId, run.dayKey, "image");
      const img = await generateTeaserImage(ctx.http, provider, run.settings.imageModel, keys, entry.imageBriefing ?? "");
      const alt = entry.rewrittenTitle ?? entry.titleOriginal;
      const saved = await ctx.target.uploadImage({ buffer: img.buffer, mime: img.mime, filename: `news-teaser-${entry.id}.${img.ext}`, alt });
      // Fehlertext eines früheren Bildversuchs entfernen, sonstige Meldungen stehen lassen
      const error = entry.error?.startsWith("Bild") ? null : entry.error;
      await ctx.store.updateEntry(entry.id, { imageRef: saved.ref, error });
      ok++;
    } catch (e) {
      if (e instanceof DailyLimitError) {
        limitHit = ` ${e.message}.`;
        break;
      }
      failed++;
      const msg = (e as Error).message.replace(/^Bild:\s*/, "");
      const prefix = entry.error?.startsWith(IMAGE_ERROR_PREFIX) ? IMAGE_ERROR_FINAL : IMAGE_ERROR_PREFIX;
      await ctx.store.updateEntry(entry.id, { error: `${prefix} ${msg}` });
      run.logger.log(`Bilder: Eintrag ${entry.id} ohne Bild: ${msg}`);
    }
  }
  return { summary: `Bilder: ${ok} erzeugt, ${failed} fehlgeschlagen (von ${candidates.length}).${limitHit}` };
}
