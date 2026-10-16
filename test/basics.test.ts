import { describe, expect, it } from "vitest";
import { extractJson, JsonExtractError } from "../src/core/json";
import { classifyMaxTokens, pickLength } from "../src/core/lengths";
import { cleanTags, contentFingerprint, removeDashes, slugify, stripHtml } from "../src/core/text";
import { braveGuid, md5, normalizeUrl, rssGuid, urlHash } from "../src/core/urls";
import { parseProfileConfig, parseSiteSettings } from "../src/core/settings";
import { classifySystemPrompt, rssWritingTask, styleBlock } from "../src/core/prompts";

describe("normalizeUrl / urlHash", () => {
  it("entfernt Schema, Fragment, Tracking-Parameter und Schrägstrich am Ende, sortiert Parameter", () => {
    expect(normalizeUrl("HTTPS://Example.COM/news/a/?b=2&utm_source=x&a=1&fbclid=z#top")).toBe("example.com/news/a?a=1&b=2");
  });
  it("behandelt Tracking-Parameter ohne Rücksicht auf Groß-/Kleinschreibung", () => {
    expect(normalizeUrl("https://x.de/a?UTM_Medium=1&Ref=2&gclid=3&mc_cid=4&mc_eid=5")).toBe("x.de/a");
  });
  it("gleiche Meldung mit und ohne Tracking ergibt denselben Hash", () => {
    expect(urlHash("http://x.de/a/")).toBe(urlHash("https://x.de/a?utm_campaign=feed"));
    expect(urlHash("https://x.de/a?p=1")).not.toBe(urlHash("https://x.de/a?p=2"));
  });
  it("Reihenfolge der Parameter spielt keine Rolle", () => {
    expect(urlHash("https://x.de/?b=1&a=2")).toBe(urlHash("https://x.de/?a=2&b=1"));
  });
  it("GUIDs wie in KNP", () => {
    expect(rssGuid("abc", "https://x.de")).toBe(md5("abc"));
    expect(rssGuid("", "https://x.de")).toBe(md5("https://x.de"));
    expect(braveGuid("Neue Uhr")).toBe(md5("brave|neue uhr"));
  });
});

describe("extractJson", () => {
  it("liest sauberes JSON", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });
  it("entfernt Codezäune", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('```\n{"a":2}\n```')).toEqual({ a: 2 });
  });
  it("schneidet Einleitung und Nachsatz ab", () => {
    expect(extractJson('Hier ist das Ergebnis:\n{"a":{"b":3}}\nViel Erfolg!')).toEqual({ a: { b: 3 } });
  });
  it("wirft bei kaputtem JSON mit den ersten 300 Zeichen", () => {
    const raw = "kein json " + "x".repeat(400);
    expect(() => extractJson(raw)).toThrow(JsonExtractError);
    try {
      extractJson(raw);
    } catch (e) {
      expect((e as Error).message.length).toBeLessThan(360);
    }
  });
  it("Arrays gelten nicht als Objekt", () => {
    expect(() => extractJson("[1,2]")).toThrow(JsonExtractError);
  });
});

describe("Textbereinigung", () => {
  it("entfernt Gedankenstriche", () => {
    expect(removeDashes("Neu – und besser")).toBe("Neu, und besser");
    expect(removeDashes("Neu — und besser")).toBe("Neu, und besser");
    expect(removeDashes("2020–2024 und A—B")).toBe("2020-2024 und A-B");
    expect(removeDashes("Bindestrich-Wort bleibt")).toBe("Bindestrich-Wort bleibt");
  });
  it("bereinigt Tags", () => {
    expect(cleanTags(["#Garmin", " garmin ", "", "Fenix 8", "  #  ", "Akku", 3, "GPS"], 3)).toEqual(["Garmin", "Fenix 8", "Akku"]);
    expect(cleanTags("kein Array", 6)).toEqual([]);
  });
  it("Slug mit Umlauten", () => {
    expect(slugify("Größere Akkus für Sportuhren: Das ändert sich!")).toBe("groessere-akkus-fuer-sportuhren-das-aendert-sich");
    expect(slugify("!!!")).toBe("news");
  });
  it("Fingerabdruck ohne HTML, 160 Zeichen", () => {
    const html = "<p>" + "Wort ".repeat(60) + "</p>";
    expect(contentFingerprint(html)).toHaveLength(160);
    expect(stripHtml("<p>a &amp; b</p><p>c</p>")).toBe("a & b c");
  });
});

describe("Längenstufen", () => {
  it("zieht aus den angehakten Stufen", () => {
    expect(pickLength(["short", "long"], () => 0).tier).toBe("short");
    expect(pickLength(["short", "long"], () => 0.99).tier).toBe("long");
    expect(pickLength([], () => 0.5).tier).toBe("medium");
  });
  it("Token-Limit nach Länge", () => {
    expect(classifyMaxTokens(500)).toBe(4000);
    expect(classifyMaxTokens(1200)).toBe(6800);
    expect(classifyMaxTokens(5000)).toBe(12000);
  });
});

describe("Einstellungen", () => {
  it("Standardwerte aus KNP", () => {
    const s = parseSiteSettings({});
    expect(s.maxPerRun).toBe(5);
    expect(s.maxTags).toBe(6);
    expect(s.requireApproval).toBe(true);
    expect(s.imageModel).toBe("fal-ai/flux/schnell");
    expect(s.fallbackCategory).toBe("News");
    const p = parseProfileConfig({});
    expect(p.importWindow).toBe(2);
    expect(p.rssLengths).toEqual(["short", "medium"]);
    expect(p.braveLengths).toEqual(["medium", "long"]);
  });
  it("begrenzt Werte und liest Zeilenlisten", () => {
    const s = parseSiteSettings({ maxPerRun: 99, maxTags: "1", postStatus: "draft" });
    expect(s.maxPerRun).toBe(25);
    expect(s.maxTags).toBe(3);
    expect(s.postStatus).toBe("draft");
    const p = parseProfileConfig({ feeds: "https://a.de/feed\n\n https://b.de/rss ", braveStartHour: 20, braveEndHour: 10, rssLengths: "long,quatsch" });
    expect(p.feeds).toEqual(["https://a.de/feed", "https://b.de/rss"]);
    expect(p.braveEndHour).toBe(21);
    expect(p.rssLengths).toEqual(["long"]);
  });
});

describe("Prompts", () => {
  it("baut den Klassifikations-Prompt im Wortlaut", () => {
    const sys = classifySystemPrompt({
      topicPrompt: "Thema X",
      categories: [
        { key: "smartwatches", name: "Smartwatches" },
        { key: "news", name: "News" },
      ],
      writingTask: rssWritingTask("Deutsch", 300, 500),
      tagsEnabled: true,
      maxTags: 6,
    });
    expect(sys).toContain("THEMENPROFIL:\nThema X\n\nVERFÜGBARE KATEGORIEN (nur diese Keys verwenden):\nsmartwatches = Smartwatches\nnews = News\n\nAUFGABE:\n1. Prüfe");
    expect(sys).toContain("Länge 300 bis 500 Wörter.");
    expect(sys).toContain("6. Erzeuge 6 prägnante Schlagworte");
    expect(sys).toContain('"image_briefing": "...", "tags": ["...", "..."]}');
    const noTags = classifySystemPrompt({ topicPrompt: "T", categories: [], writingTask: "", tagsEnabled: false, maxTags: 6 });
    expect(noTags).not.toContain("Schlagworte");
    expect(noTags).toContain('"image_briefing": "..."}');
  });
  it("Stilanweisung hat Vorrang vor dem Beispieltext", () => {
    expect(styleBlock({ name: "S", instruction: "Kurz.", sample: "Beispiel" })).toContain("<stilanweisung>\nKurz.\n</stilanweisung>");
    expect(styleBlock({ name: "S", instruction: "", sample: "Beispiel" })).toContain("(Style Mimic)");
    expect(styleBlock({ name: "S", instruction: " ", sample: "" })).toBe("");
  });
});
