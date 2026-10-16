/**
 * HTML-Verarbeitung mit cheerio: Positivliste für KI-HTML und Textextraktion beim Crawlen.
 */
import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";

/** Erlaubte Elemente im KI-Text (KNP: p, h2, h3, ul, ol, li, strong, em, a[href, rel], blockquote) */
const ALLOWED_TAGS = new Set(["p", "h2", "h3", "ul", "ol", "li", "strong", "em", "a", "blockquote", "br"]);
/** Elemente, die samt Inhalt verschwinden */
const DROP_WITH_CONTENT = new Set(["script", "style", "noscript", "iframe", "object", "embed", "template", "svg", "form", "head", "title"]);
/** Verwandte Elemente, die auf ein erlaubtes abgebildet werden */
const MAP_TAGS: Record<string, string> = { b: "strong", i: "em", h1: "h2", h4: "h3", h5: "h3", h6: "h3" };

/**
 * Filtert HTML auf die Positivliste. Nicht erlaubte Elemente werden aufgelöst (Inhalt bleibt),
 * gefährliche samt Inhalt entfernt. Links nur mit http(s), Attribute nur href und rel.
 */
export function sanitizeArticleHtml(html: string): string {
  const $ = cheerio.load(`<div id="__root">${html}</div>`, null, false);
  const root = $("#__root");

  const walk = (nodes: AnyNode[]) => {
    for (const node of nodes) {
      if (node.type === "comment" || node.type === "directive" || node.type === "cdata") {
        $(node).remove();
        continue;
      }
      if (node.type !== "tag" && node.type !== "script" && node.type !== "style") continue;
      const el = node as Element;
      let name = el.name.toLowerCase();
      if (DROP_WITH_CONTENT.has(name)) {
        $(el).remove();
        continue;
      }
      walk([...el.children]);
      if (MAP_TAGS[name]) {
        el.name = MAP_TAGS[name]!;
        name = el.name;
      }
      if (!ALLOWED_TAGS.has(name)) {
        $(el).replaceWith($(el).contents());
        continue;
      }
      const attrs = { ...el.attribs };
      for (const attr of Object.keys(attrs)) {
        const keep = name === "a" && (attr === "href" || attr === "rel");
        if (!keep) $(el).removeAttr(attr);
      }
      if (name === "a") {
        const href = (attrs.href ?? "").trim();
        if (!/^https?:\/\//i.test(href)) $(el).replaceWith($(el).contents());
      }
    }
  };
  walk([...root.contents()]);
  return (root.html() ?? "").replace(/\n{3,}/g, "\n\n").trim();
}

/** Elemente, die vor der Textextraktion samt Inhalt entfernt werden (KNP-Crawl) */
const CRAWL_DROP = "script, style, noscript, iframe, svg, form, nav, footer, header, aside";
const BLOCK_TAGS = "p, div, section, article, main, li, h1, h2, h3, h4, h5, h6, br, tr, blockquote, pre, ul, ol, table, figure, figcaption";

export const CRAWL_MIN_CHARS = 300;
export const CRAWL_MAX_CHARS = 15_000;

/**
 * Text einer Artikelseite (Heuristik aus KNP): erst `article`, sonst `main`; unter 300 Zeichen der
 * ganze `body`; immer noch unter 300 alle Tags entfernen. Leerraum zusammenfassen, höchstens zwei
 * Zeilenumbrüche, auf `maxChars` kürzen.
 */
export function extractArticleText(html: string, maxChars = CRAWL_MAX_CHARS): string {
  const $ = cheerio.load(html);
  $(CRAWL_DROP).remove();
  // Blockgrenzen als Zeilenumbruch erhalten, sonst kleben Absätze aneinander
  $(BLOCK_TAGS).each((_, el) => {
    $(el).append("\n");
  });

  const pick = (sel: string) => {
    const first = $(sel).first();
    return first.length ? tidy(first.text()) : "";
  };
  let text = pick("article");
  if (!text) text = pick("main");
  if (text.length < CRAWL_MIN_CHARS) text = pick("body");
  if (text.length < CRAWL_MIN_CHARS) text = tidy(html.replace(/<[^>]*>/g, " "));
  return text.slice(0, maxChars);
}

function tidy(s: string): string {
  return s
    .replace(/\r/g, "")
    .replace(/[ \t\f\v ]+/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Überschriften h1 bis h4 einer Seite (für Vergleichsseiten in der Brave-Suche) */
export function extractHeadings(html: string, minChars = 15): string[] {
  const $ = cheerio.load(html);
  const out: string[] = [];
  $("h1, h2, h3, h4").each((_, el) => {
    const t = $(el).text().replace(/\s+/g, " ").trim();
    if (t.length >= minChars) out.push(t);
  });
  return out;
}
