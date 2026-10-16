/**
 * JSON robust aus einer KI-Antwort lesen (Regeln aus `docs/uebergabe/03`, Abschnitt 4):
 * Codezaun entfernen, parsen; sonst vom ersten `{` bis zum letzten `}` parsen; sonst Fehler mit den
 * ersten 300 Zeichen der Antwort.
 */
export class JsonExtractError extends Error {}

export function extractJson(raw: string): Record<string, unknown> {
  let s = raw.trim();
  s = s.replace(/^```(?:json|JSON)?\s*/, "").replace(/\s*```$/, "").trim();
  const direct = tryObject(s);
  if (direct) return direct;
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first >= 0 && last > first) {
    const cut = tryObject(s.slice(first, last + 1));
    if (cut) return cut;
  }
  throw new JsonExtractError(`Antwort ist kein gültiges JSON: ${raw.trim().slice(0, 300)}`);
}

function tryObject(s: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
