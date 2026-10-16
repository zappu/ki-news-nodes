/**
 * Tagesgrenzen in der Zeitzone der Zielseite (für Tageslimits, Artikelziel und später die Brave-Slots).
 * Gespeichert wird immer in UTC.
 */

interface LocalParts {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function parts(date: Date, tz: string): LocalParts {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    formatters.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour), mi: Number(p.minute), s: Number(p.second) };
}

/** Abstand der Ortszeit zu UTC in Millisekunden zu diesem Zeitpunkt */
function offsetMs(date: Date, tz: string): number {
  const p = parts(date, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(date.getTime() / 1000) * 1000;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Tag in Ortszeit als `JJJJ-MM-TT` */
export function localDayKey(date: Date, tz: string): string {
  const p = parts(date, tz);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/** Zeitpunkt (UTC) einer Ortszeit an diesem Tag; Stunde 24 ist Mitternacht des Folgetags */
export function localTimeOnDay(date: Date, tz: string, hour: number, minute = 0): Date {
  const p = parts(date, tz);
  const naive = Date.UTC(p.y, p.m - 1, p.d, hour, minute);
  // zweimal korrigieren, damit Tage mit Zeitumstellung stimmen
  const first = naive - offsetMs(new Date(naive), tz);
  return new Date(naive - offsetMs(new Date(first), tz));
}

/** Mitternacht in Ortszeit als UTC-Zeitpunkt */
export function startOfLocalDay(date: Date, tz: string): Date {
  return localTimeOnDay(date, tz, 0);
}
