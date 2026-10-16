/**
 * Schritt 0: Fehlversuche wiederholen (KNP 1.12.0). Einträge mit Status `failed` gehen zurück auf den
 * Status, bei dem der Fehler passierte, damit derselbe Lauf sie wieder aufgreift. Wer schon drei
 * Versuche hat, wird aussortiert. Fehlt der Rücksprung (Altdaten), entscheidet das Präfix der Meldung.
 */
import type { PipelineContext, RunState, StepResult } from "../context";
import type { QueueEntry, QueueStatus } from "../types";
import { MAX_ATTEMPTS } from "../../store/store";

export const RETRY_BATCH = 200;

export function retryTarget(entry: Pick<QueueEntry, "retryStatus" | "error">, requireApproval: boolean): QueueStatus {
  if (entry.retryStatus && entry.retryStatus !== "failed") return entry.retryStatus;
  const err = entry.error ?? "";
  if (err.startsWith("KI:")) return "crawled";
  if (err.startsWith("Publish:")) return requireApproval ? "approved" : "classified";
  return "new";
}

export async function retryFailed(ctx: PipelineContext, run: RunState): Promise<StepResult> {
  const entries = await ctx.store.takeByStatus(ctx.siteId, ["failed"], RETRY_BATCH);
  let back = 0;
  let out = 0;
  for (const entry of entries) {
    if (entry.attempts >= MAX_ATTEMPTS) {
      await ctx.store.updateEntry(entry.id, {
        status: "rejected",
        retryStatus: null,
        error: `Nach ${MAX_ATTEMPTS} Fehlversuchen aussortiert. Letzter Fehler: ${entry.error ?? "unbekannt"}`,
      });
      out++;
      continue;
    }
    await ctx.store.updateEntry(entry.id, { status: retryTarget(entry, run.settings.requireApproval) });
    back++;
  }
  return { summary: entries.length ? `Wiederholung: ${back} Einträge erneut eingereiht, ${out} aussortiert.` : "Wiederholung: keine Fehlversuche." };
}
