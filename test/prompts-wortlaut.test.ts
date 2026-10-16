/**
 * Die Prompts im Code müssen dem Wortlaut in `docs/uebergabe/03_Prompts.md` entsprechen.
 * Einzige bewusste Abweichung: „WordPress-Tags“ heißt im Node-Projekt „Tags“ (im Dokument erlaubt).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { braveWritingTask, DEFAULT_BRAVE_PROMPT, DEFAULT_BRAVE_STRUCTURE, rssWritingTask, styleBlock, tagTask } from "../src/core/prompts";

const doc = readFileSync(new URL("../docs/uebergabe/03_Prompts.md", import.meta.url), "utf8");

/** Ersten Codeblock nach einer Überschrift (oder einem Marker) holen */
function block(after: string): string {
  const start = doc.indexOf(after);
  if (start < 0) throw new Error(`Abschnitt fehlt: ${after}`);
  const m = /```\n([\s\S]*?)```/.exec(doc.slice(start));
  if (!m) throw new Error(`Kein Codeblock nach: ${after}`);
  return m[1]!;
}

describe("Prompts entsprechen dem Übergabepaket", () => {
  it("Schreibauftrag RSS", () => {
    const expected = block("### Schreibauftrag RSS").replace("{language}", "Deutsch").replace("{min}", "300").replace("{max}", "500");
    expect(rssWritingTask("Deutsch", 300, 500)).toBe(expected);
  });
  it("Schreibauftrag Brave", () => {
    const expected = block("### Schreibauftrag Brave").replace("{language}", "Deutsch").replace("{brave_structure}", "GLIEDERUNG.").replace("{min}", "500").replace("{max}", "800");
    expect(braveWritingTask("Deutsch", 500, 800, "GLIEDERUNG.")).toBe(expected);
  });
  it("Tag-Auftrag", () => {
    const expected = block("### Tag-Auftrag").replace("{max_tags}", "6").replace("(WordPress-Tags)", "(Tags)");
    expect(tagTask(6)).toBe(expected);
  });
  it("Standardtexte für Brave", () => {
    expect(DEFAULT_BRAVE_PROMPT + "\n").toBe(block("### Standard für `brave_prompt`"));
    expect(DEFAULT_BRAVE_STRUCTURE + "\n").toBe(block("### Standard für `brave_structure`"));
  });
  it("Schreibstil-Blöcke", () => {
    const withInstruction = block("### Block im System-Prompt, mit Stilanweisung").replace("{Name}", "Klar").replace("{instruction}", "Kurze Sätze.");
    expect(styleBlock({ name: "Klar", instruction: "Kurze Sätze.", sample: "" })).toBe(withInstruction);
    const withSample = block("### Block nur mit Beispieltext").replace("{Name}", "Klar").replace("{sample}", "Ein Beispiel.");
    expect(styleBlock({ name: "Klar", instruction: "", sample: "Ein Beispiel." })).toBe(withSample);
  });
});
