/**
 * Alle KI-Prompts im Wortlaut aus KNP 1.12.1 (`docs/uebergabe/03_Prompts.md`).
 * Die Texte sind über viele Läufe eingestellt worden; Änderungen bewusst entscheiden und begründen.
 */
import type { Category } from "./types";

export interface StyleForPrompt {
  name: string;
  instruction: string;
  sample: string;
}

/** Schreibstil-Block; leer, wenn weder Anweisung noch Beispieltext da sind (Anweisung hat Vorrang) */
export function styleBlock(style: StyleForPrompt | null | undefined): string {
  if (!style) return "";
  const instruction = style.instruction.trim();
  const sample = style.sample.trim();
  if (instruction) {
    return (
      `\nSCHREIBSTIL „${style.name}“:\n` +
      "Schreibe Titel, Artikel und Teaser nach dieser Stilanweisung. Ist sie auf Englisch formuliert, wende sie sinngemäß auf den Text an. Die Vorgaben oben zu Sprache, Länge, HTML, Fakten und Gedankenstrichen gelten weiter, auch wenn der Stil davon abweicht.\n" +
      "<stilanweisung>\n" +
      instruction +
      "\n</stilanweisung>\n"
    );
  }
  if (sample) {
    return (
      `\nSCHREIBSTIL „${style.name}“ (Style Mimic):\n` +
      "Schreibe Titel, Artikel und Teaser im Stil des folgenden Beispieltextes. Übernimm Tonfall, Ansprache, Satzlänge und Satzbau, Wortwahl, Rhythmus und den Grad an Humor oder Sachlichkeit. Übernimm keine Inhalte, Fakten, Namen oder ganzen Sätze aus dem Beispiel, nur die Art zu schreiben. Die Vorgaben oben zu Sprache, Länge, HTML, Fakten und Gedankenstrichen gelten weiter, auch wenn der Stil davon abweicht.\n" +
      "<beispieltext>\n" +
      sample +
      "\n</beispieltext>\n"
    );
  }
  return "";
}

export function rssWritingTask(language: string, min: number, max: number): string {
  return (
    "1. Prüfe, ob die Meldung zum Themenprofil passt (relevant true/false).\n" +
    `2. Wenn relevant: Schreibe den Artikel vollständig neu in eigenen Worten auf ${language}. Kein Copy-Paste, keine wörtlichen Übernahmen, journalistischer Stil, sauberes HTML nur mit <p>, <h2>, <h3>, <ul>, <li>, <strong>. Erfinde keine Fakten, die nicht in der Meldung stehen; reicht der Stoff nicht für die Länge, ordne ein und erkläre Hintergründe. Länge ${min} bis ${max} Wörter. Menschlicher Ton, variierende Satzlängen, keine Floskeln, keine Gedankenstriche.\n`
  );
}

export function braveWritingTask(language: string, min: number, max: number, structure: string): string {
  return (
    "1. Prüfe, ob das Thema zum Themenprofil passt (relevant true/false).\n" +
    `2. Wenn relevant: Schreibe einen vollständigen, hilfreichen Artikel zum Thema auf ${language}, gestützt auf die Quellen. Nutze nur Fakten, die in den Quellen stehen. Erfinde keine Funktionen, Preise, Zahlen, Verfügbarkeiten oder Zitate; ist etwas unklar, sag das kurz. Keine wörtlichen Übernahmen, keine Quellenangaben oder Links im Text. Gliederung: ${structure} Sauberes HTML nur mit <p>, <h2>, <h3>, <ul>, <ol>, <li>, <strong>, <em>. Länge ${min} bis ${max} Wörter. Menschlicher Ton, variierende Satzlängen, keine Floskeln, keine Gedankenstriche.\n`
  );
}

export function tagTask(maxTags: number): string {
  return `6. Erzeuge ${maxTags} prägnante Schlagworte (Tags) für den Artikel: einzelne Begriffe oder kurze 2-3-Wort-Phrasen zu den zentralen Themen (z. B. Rechtsgebiet, handelnde Institutionen, betroffene Personengruppe, Kernbegriff). Kein #-Symbol, keine Duplikate, keine reinen Füllwörter, jedes Tag max. 4 Wörter.\n\n`;
}

export interface ClassifyPromptInput {
  topicPrompt: string;
  categories: Category[];
  writingTask: string;
  tagsEnabled: boolean;
  maxTags: number;
  style?: StyleForPrompt | null;
}

export function classifySystemPrompt(i: ClassifyPromptInput): string {
  const cats = i.categories.map((c) => `${c.key} = ${c.name}`).join("\n");
  const tagsField = i.tagsEnabled ? ', "tags": ["...", "..."]' : "";
  return (
    "Du bist der Klassifikations- und Rewrite-Agent einer automatisierten Online-Zeitung.\n\n" +
    "THEMENPROFIL:\n" +
    i.topicPrompt.trim() +
    "\n\n" +
    "VERFÜGBARE KATEGORIEN (nur diese Keys verwenden):\n" +
    cats +
    "\n\n" +
    "AUFGABE:\n" +
    i.writingTask +
    "3. Erzeuge Teaser (max. 160 Zeichen), SEO-Titel (max. 60 Zeichen), SEO-Description (max. 155 Zeichen).\n" +
    "4. Wähle genau einen category_key aus der Liste.\n" +
    "5. Formuliere ein image_briefing für ein Teaser-Bild: Szene, Stil, Farben, Stimmung. Ohne erkennbare Personen, ohne Namen, ohne Text im Bild.\n" +
    (i.tagsEnabled ? tagTask(i.maxTags) : "") +
    styleBlock(i.style) +
    "ANTWORTFORMAT: Antworte ausschließlich mit einem einzigen validen JSON-Objekt, ohne Markdown, ohne Codeblöcke, ohne Erklärung:\n" +
    `{"relevant": true, "title": "...", "content_html": "...", "teaser": "...", "seo_title": "...", "seo_description": "...", "category_key": "...", "image_briefing": "..."${tagsField}}\n` +
    'Wenn nicht relevant: {"relevant": false, "reason": "..."}'
  );
}

export const RSS_INPUT_MAX = 12_000;
export const BRAVE_INPUT_MAX = 20_000;

export function rssUserMessage(sourceUrl: string, titleOriginal: string, fullContent: string): string {
  return `QUELLE: ${sourceUrl}\nORIGINALTITEL: ${titleOriginal}\n\nARTIKELTEXT:\n${fullContent.slice(0, RSS_INPUT_MAX)}`;
}

export function braveUserMessage(titleOriginal: string, fullContent: string): string {
  return `THEMA: ${titleOriginal}\n\nQUELLEN:\n${fullContent.slice(0, BRAVE_INPUT_MAX)}`;
}

// ─── Brave-Themenauswahl ───────────────────────────────────────────────────────────────────────

export const BRAVE_SELECT_MAX_TOKENS = 2000;

export function braveSelectSystemPrompt(topicPrompt: string, today: string): string {
  return (
    "Du bist Chefredakteur einer Online-Zeitung und wählst neue Themen aus aktuellen Suchtreffern aus.\n\n" +
    "THEMENPROFIL DER ZEITUNG:\n" +
    topicPrompt.trim() +
    "\n\n" +
    `Heute ist ${today}. Verwende ausschließlich die gelieferten Suchtreffer und erfinde keine Nachrichten.`
  );
}

export interface BraveSelectInput {
  bravePrompt: string;
  known: string[];
  results: { title: string; desc: string; url: string; age?: string }[];
  days: number;
  count: number;
  language: string;
}

export function braveSelectUserPrompt(i: BraveSelectInput): string {
  const known = i.known.length ? i.known.map((h) => `- ${h}`).join("\n") : "- (noch keine)";
  const hits = i.results.map((r, n) => `${n + 1}. ${r.title} | ${r.desc} | ${r.url}${r.age ? ` | ${r.age}` : ""}`).join("\n");
  return (
    i.bravePrompt.trim() +
    "\n\n" +
    "BEREITS BEHANDELTE ÜBERSCHRIFTEN (nie wiederholen, auch nicht umformuliert):\n" +
    known +
    "\n\n" +
    `AKTUELLE SUCHTREFFER (letzte ${i.days} Tage, nur daraus auswählen):\n` +
    hits +
    "\n\n" +
    "AUSGABE (hat Vorrang vor allen Formatvorgaben weiter oben):\n" +
    `Wähle bis zu ${i.count} Themen. Zu jedem Thema eine Überschrift auf ${i.language}, die klar sagt, was neu ist und warum es Leser interessiert, mit genug Kontext für einen vollständigen Artikel. Dazu die Nummern der Suchtreffer, die das Thema belegen (1 bis 5 Nummern).\n` +
    "Gibt es nichts wirklich Neues, liefere eine leere Liste.\n" +
    'Antworte ausschließlich mit einem JSON-Objekt ohne Markdown: {"topics": [{"headline": "...", "sources": [3, 7]}]}'
  );
}

export const DEFAULT_BRAVE_PROMPT =
  "Finde die nützlichsten neuen Themen aus den Suchtreffern, von denen unsere Leser sofort profitieren.\n\n" +
  "Bevorzuge Themen, die:\n" +
  "- einen klaren praktischen Nutzen haben\n" +
  "- sich zu einem hilfreichen Artikel oder einer Anleitung ausbauen lassen\n" +
  "- erklären, warum die Neuigkeit wichtig ist\n" +
  "- für ein breites Publikum verständlich sind\n\n" +
  "Vermeide:\n" +
  "- reine Forschungs- oder Benchmark-Meldungen ohne praktischen Bezug\n" +
  "- kleine Fehlerbehebungen und Finanznachrichten von Unternehmen\n" +
  "- Gerüchte ohne glaubwürdige Quelle\n" +
  "- Themen, die wir schon behandelt haben";

export const DEFAULT_BRAVE_STRUCTURE =
  "Kurzer, packender Einstieg (was ist neu), warum es für normale Nutzer wichtig ist, Schritt-für-Schritt-Anleitung zur Nutzung (konkret und praktisch), Tipps und Einsatzbeispiele, kurzes Fazit.";

export const DEFAULT_AI_DISCLOSURE = "Dieser Beitrag wurde mit Unterstützung von KI erstellt und redaktionell geprüft.";
