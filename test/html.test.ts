import { describe, expect, it } from "vitest";
import { extractArticleText, extractHeadings, sanitizeArticleHtml } from "../src/core/html";

describe("sanitizeArticleHtml", () => {
  it("lässt erlaubte Elemente stehen", () => {
    const html = "<h2>Titel</h2><p>Text <strong>fett</strong> und <em>kursiv</em></p><ul><li>a</li></ul><ol><li>b</li></ol><blockquote>z</blockquote>";
    expect(sanitizeArticleHtml(html)).toBe(html);
  });
  it("entfernt Skripte samt Inhalt und löst unbekannte Elemente auf", () => {
    expect(sanitizeArticleHtml('<div class="x"><p onclick="x()">Hallo<script>alert(1)</script></p><span>Welt</span></div>')).toBe("<p>Hallo</p>Welt");
  });
  it("bildet verwandte Elemente ab", () => {
    expect(sanitizeArticleHtml("<h1>A</h1><h4>B</h4><b>c</b><i>d</i>")).toBe("<h2>A</h2><h3>B</h3><strong>c</strong><em>d</em>");
  });
  it("Links nur mit http(s), nur href und rel", () => {
    expect(sanitizeArticleHtml('<a href="https://x.de" target="_blank" rel="nofollow" style="c">x</a>')).toBe('<a href="https://x.de" rel="nofollow">x</a>');
    expect(sanitizeArticleHtml('<a href="javascript:alert(1)">y</a>')).toBe("y");
  });
  it("entfernt Kommentare und Bilder", () => {
    expect(sanitizeArticleHtml('<p>a<!-- x --><img src="x" onerror="y">b</p>')).toBe("<p>ab</p>");
  });
});

describe("extractArticleText", () => {
  const long = "Satz mit Inhalt. ".repeat(30);
  it("nimmt den article-Bereich und entfernt Navigation", () => {
    const html = `<html><body><nav>Menü Menü</nav><header>Kopf</header><article><h1>Überschrift</h1><p>${long}</p><aside>Werbung</aside></article><footer>Fuß</footer></body></html>`;
    const t = extractArticleText(html);
    expect(t.startsWith("Überschrift\n")).toBe(true);
    expect(t).not.toContain("Menü");
    expect(t).not.toContain("Werbung");
    expect(t).not.toContain("Fuß");
  });
  it("fällt auf main und dann auf body zurück", () => {
    expect(extractArticleText(`<body><main><p>${long}</p></main></body>`)).toContain("Satz mit Inhalt.");
    const t = extractArticleText(`<body><article>kurz</article><div><p>${long}</p></div></body>`);
    expect(t).toContain("Satz mit Inhalt.");
    expect(t.length).toBeGreaterThan(300);
  });
  it("fasst Leerraum zusammen und kürzt", () => {
    const t = extractArticleText(`<article><p>a    b</p>\n\n\n\n<p>c</p><p>${long}</p></article>`, 100);
    expect(t.startsWith("a b\n")).toBe(true);
    expect(t).not.toMatch(/\n{3,}/);
    expect(t.length).toBe(100);
  });
  it("Überschriften für den Abgleich", () => {
    expect(extractHeadings("<h1>Kurz</h1><h2>Eine ausreichend lange Überschrift</h2><h5>Nicht dabei, weil h5 ist</h5>")).toEqual(["Eine ausreichend lange Überschrift"]);
  });
});
