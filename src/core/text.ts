/**
 * Textbereinigung für KI-Ausgaben.
 */

/**
 * Gedankenstriche entfernen (KNP 1.11.0): ` – ` bzw. ` — ` mit Leerzeichen wird zu `, `,
 * übrige `–` und `—` werden zu `-`.
 */
export function removeDashes(s: string): string {
  return s.replace(/[  ]+[–—][  ]+/g, ", ").replace(/[–—]/g, "-");
}

/** Tags bereinigen: `#` und Leerraum am Rand weg, leere raus, Duplikate ohne Groß-/Kleinschreibung raus, kürzen */
export function cleanTags(tags: unknown, max: number): string[] {
  if (!Array.isArray(tags)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tags) {
    if (typeof t !== "string") continue;
    const clean = t.replace(/^[\s#]+|[\s#]+$/g, "").replace(/\s+/g, " ");
    if (!clean) continue;
    const key = clean.toLocaleLowerCase("de");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= max) break;
  }
  return out;
}

/** HTML-Tags entfernen und Leerraum zusammenfassen (für Titel, Fingerabdruck, Vergleiche) */
export function stripHtml(s: string): string {
  return s
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Fingerabdruck für die Idempotenz: die ersten 160 Zeichen des Textes ohne HTML */
export function contentFingerprint(html: string): string {
  return stripHtml(html).slice(0, 160);
}

/** Lesbarer Slug aus dem Titel (Umlaute ae/oe/ue/ss), höchstens 80 Zeichen */
export function slugify(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.slice(0, 80).replace(/-+$/, "") || "news";
}

/** Fehlertexte auf 1900 Zeichen kürzen (wie KNP) */
export function clipError(s: string): string {
  return s.length > 1900 ? s.slice(0, 1899) + "…" : s;
}
