/**
 * Admin-Dienst für den Bereich „News“ einer Zielseite. Ohne Bezug zu tRPC oder Express: Die Seite
 * verbindet jede Funktion mit ihrer geschützten Admin-Prozedur und nutzt dafür die Eingabe-Schemas aus
 * `newsInputs`. Jede Funktion nimmt genau ein Eingabe-Objekt, damit die Zuordnung gleichförmig bleibt.
 */
import { z } from "zod";
import pkg from "../../package.json";
import type { PipelineContext } from "../core/context";
import { fetchFeed } from "../core/feeds";
import { sanitizeArticleHtml } from "../core/html";
import { runPipeline } from "../core/pipeline";
import { parseProfileConfig, parseSiteSettings, type Profile, type SiteSettings } from "../core/settings";
import { localDayKey } from "../core/time";
import { QUEUE_STATUSES, sourceKindOf, type Category, type QueueEntry, type QueueStatus, type SourceKind, type SourceRef } from "../core/types";
import { isHttpUrl } from "../core/urls";
import type { NewsStore, RunRow } from "../store/store";

export const NEWS_VERSION: string = pkg.version;

const id = z.number().int().positive();

/** Eingabe-Schemas je Funktion (für `.input()` der Admin-Prozeduren) */
export const newsInputs = {
  overview: z.object({}),
  queue: z.object({
    status: z.enum(QUEUE_STATUSES).nullish(),
    profileId: id.nullish(),
    search: z.string().max(200).nullish(),
    page: z.number().int().min(1).max(10_000).default(1),
    pageSize: z.number().int().min(1).max(200).default(50),
  }),
  entry: z.object({ id }),
  bulk: z.object({ action: z.enum(["approve", "reject", "retry", "delete"]), ids: z.array(id).min(1).max(500) }),
  settings: z.object({}),
  saveSettings: z.object({ settings: z.record(z.string(), z.unknown()) }),
  profiles: z.object({}),
  saveProfile: z.object({ id: id.nullish(), name: z.string().trim().min(1).max(80), active: z.boolean(), config: z.record(z.string(), z.unknown()) }),
  deleteProfile: z.object({ id }),
  categories: z.object({}),
  runs: z.object({ limit: z.number().int().min(1).max(200).default(30) }),
  run: z.object({ id }),
  start: z.object({ braveOnly: z.boolean().default(false) }),
  testFeed: z.object({ url: z.string().trim().max(1000) }),
} as const;

/** Welche Funktionen lesen (Query) und welche ändern (Mutation) */
export const NEWS_QUERIES = ["overview", "queue", "entry", "settings", "profiles", "categories", "runs", "run"] as const;
export const NEWS_MUTATIONS = ["bulk", "saveSettings", "saveProfile", "deleteProfile", "start", "testFeed"] as const;

export interface NewsAdminDeps {
  siteId: string;
  store: NewsStore;
  /** Kontext für Läufe und Abrufe (KI-Kette, HTTP-Client, Ziel-Adapter, Schlüssel) */
  buildContext: () => PipelineContext;
  /** Welche Schlüssel und Dienste die Seite eingerichtet hat (nur ja/nein, nie die Werte) */
  keys: { llm: boolean; brave: boolean; fal: boolean; openrouter: boolean; mail: boolean };
  /** Läufe aus dem Admin starten; Standard: im Hintergrund dieses Prozesses */
  startRun?: (ctx: PipelineContext, opts: { braveOnly: boolean }) => void;
}

export interface QueueListItem {
  id: number;
  profileId: number;
  status: QueueStatus;
  kind: SourceKind;
  titleOriginal: string;
  rewrittenTitle: string | null;
  sourceName: string;
  sourceUrl: string;
  categoryKey: string | null;
  tags: string[];
  imageRef: string | null;
  postRef: string | null;
  error: string | null;
  attempts: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface QueueDetail extends QueueListItem {
  teaserText: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  imageBriefing: string | null;
  contentHtml: string;
  sourceList: SourceRef[];
  publishedAt: Date | null;
  fullContentChars: number;
}

export interface RunSummary {
  id: number;
  trigger: RunRow["trigger"];
  status: RunRow["status"];
  step: string | null;
  message: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  lines: number;
}

export interface NewsOverview {
  version: string;
  counts: Record<QueueStatus, number>;
  waiting: number;
  profiles: { total: number; active: number };
  lastRun: RunSummary | null;
  running: boolean;
  usageToday: { ai: number; brave: number; image: number };
  limits: { ai: number; brave: number; image: number };
  keys: NewsAdminDeps["keys"];
  settings: Pick<SiteSettings, "requireApproval" | "imagesEnabled" | "cronInterval" | "timezone">;
}

function listItem(e: QueueEntry): QueueListItem {
  return {
    id: e.id,
    profileId: e.profileId,
    status: e.status,
    kind: sourceKindOf(e),
    titleOriginal: e.titleOriginal,
    rewrittenTitle: e.rewrittenTitle,
    sourceName: e.sourceName,
    sourceUrl: e.sourceUrl,
    categoryKey: e.categoryKey,
    tags: e.tags,
    imageRef: e.imageRef,
    postRef: e.postRef,
    error: e.error,
    attempts: e.attempts,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
}

function runSummary(r: RunRow): RunSummary {
  return { id: r.id, trigger: r.trigger, status: r.status, step: r.step, message: r.message, startedAt: r.startedAt, finishedAt: r.finishedAt, lines: r.log.length };
}

type In<K extends keyof typeof newsInputs> = z.input<(typeof newsInputs)[K]>;
const parse = <K extends keyof typeof newsInputs>(k: K, v: In<K>) => newsInputs[k].parse(v) as z.output<(typeof newsInputs)[K]>;

export function createNewsAdmin(deps: NewsAdminDeps) {
  const { store, siteId } = deps;
  const startRun =
    deps.startRun ??
    ((ctx: PipelineContext, opts: { braveOnly: boolean }) => {
      void runPipeline(ctx, { trigger: "manual", braveOnly: opts.braveOnly }).catch((e) => console.error("[news] Lauf fehlgeschlagen:", e));
    });

  return {
    async overview(_input: In<"overview">): Promise<NewsOverview> {
      const [counts, settings, profiles, [last]] = await Promise.all([store.countByStatus(siteId), store.getSettings(siteId), store.listProfiles(siteId), store.listRuns(siteId, 1)]);
      const usage = await store.usageForDay(siteId, localDayKey(new Date(), settings.timezone));
      return {
        version: NEWS_VERSION,
        counts,
        waiting: settings.requireApproval ? counts.classified : 0,
        profiles: { total: profiles.length, active: profiles.filter((p) => p.active).length },
        lastRun: last ? runSummary(last) : null,
        running: last?.status === "running",
        usageToday: { ai: usage.ai ?? 0, brave: usage.brave ?? 0, image: usage.image ?? 0 },
        limits: { ai: settings.dailyAiLimit, brave: settings.dailyBraveLimit, image: settings.dailyImageLimit },
        keys: deps.keys,
        settings: { requireApproval: settings.requireApproval, imagesEnabled: settings.imagesEnabled, cronInterval: settings.cronInterval, timezone: settings.timezone },
      };
    },

    async queue(input: In<"queue">): Promise<{ items: QueueListItem[]; total: number; counts: Record<QueueStatus, number> }> {
      const f = parse("queue", input);
      const [list, counts] = await Promise.all([store.listQueue(siteId, f), store.countByStatus(siteId)]);
      return { items: list.items.map(listItem), total: list.total, counts };
    },

    async entry(input: In<"entry">): Promise<QueueDetail | null> {
      const { id: entryId } = parse("entry", input);
      const e = await store.getEntry(entryId);
      if (!e || e.siteId !== siteId) return null;
      return {
        ...listItem(e),
        teaserText: e.teaserText,
        seoTitle: e.seoTitle,
        seoDescription: e.seoDescription,
        imageBriefing: e.imageBriefing,
        contentHtml: sanitizeArticleHtml(e.rewrittenContent ?? ""),
        sourceList: e.sourceList ?? [],
        publishedAt: e.publishedAt,
        fullContentChars: e.fullContent?.length ?? 0,
      };
    },

    async bulk(input: In<"bulk">): Promise<{ changed: number }> {
      const { action, ids } = parse("bulk", input);
      const changed =
        action === "approve" ? await store.approve(siteId, ids) : action === "reject" ? await store.reject(siteId, ids) : action === "retry" ? await store.retry(siteId, ids) : await store.remove(siteId, ids);
      return { changed };
    },

    async settings(_input: In<"settings">): Promise<SiteSettings> {
      return store.getSettings(siteId);
    },

    async saveSettings(input: In<"saveSettings">): Promise<SiteSettings> {
      const { settings } = parse("saveSettings", input);
      const current = await store.getSettings(siteId);
      return store.saveSettings(siteId, parseSiteSettings({ ...current, ...settings }));
    },

    async profiles(_input: In<"profiles">): Promise<Profile[]> {
      return store.listProfiles(siteId);
    },

    async saveProfile(input: In<"saveProfile">): Promise<Profile> {
      const p = parse("saveProfile", input);
      const others = (await store.listProfiles(siteId)).filter((x) => x.id !== p.id);
      if (others.some((x) => x.name.toLocaleLowerCase("de") === p.name.toLocaleLowerCase("de"))) throw new Error(`Es gibt schon ein Profil „${p.name}“.`);
      const config = parseProfileConfig(p.config);
      if (p.id) {
        const existing = await store.getProfile(siteId, p.id);
        if (!existing) throw new Error("Profil nicht gefunden.");
        await store.updateProfile(siteId, p.id, { name: p.name, active: p.active, config });
        return (await store.getProfile(siteId, p.id))!;
      }
      return store.createProfile(siteId, { name: p.name, active: p.active, config });
    },

    async deleteProfile(input: In<"deleteProfile">): Promise<{ deleted: boolean }> {
      return { deleted: await store.deleteProfile(siteId, parse("deleteProfile", input).id) };
    },

    async categories(_input: In<"categories">): Promise<Category[]> {
      return deps.buildContext().target.categories();
    },

    async runs(input: In<"runs">): Promise<RunSummary[]> {
      return (await store.listRuns(siteId, parse("runs", input).limit)).map(runSummary);
    },

    async run(input: In<"run">): Promise<(RunSummary & { log: string[] }) | null> {
      const r = await store.getRun(parse("run", input).id);
      if (!r || r.siteId !== siteId) return null;
      return { ...runSummary(r), log: r.log };
    },

    async start(input: In<"start">): Promise<{ started: true }> {
      const { braveOnly } = parse("start", input);
      startRun(deps.buildContext(), { braveOnly });
      return { started: true };
    },

    async testFeed(input: In<"testFeed">): Promise<{ ok: boolean; title: string; items: { title: string; link: string; date: Date | null }[]; error: string | null }> {
      const { url } = parse("testFeed", input);
      if (!isHttpUrl(url)) return { ok: false, title: "", items: [], error: "Keine gültige http(s)-Adresse." };
      try {
        const feed = await fetchFeed(deps.buildContext().http, url);
        return { ok: true, title: feed.title, items: feed.items.slice(0, 5).map((i) => ({ title: i.title, link: i.link, date: i.date })), error: null };
      } catch (e) {
        return { ok: false, title: "", items: [], error: (e as Error).message };
      }
    },
  };
}

export type NewsAdmin = ReturnType<typeof createNewsAdmin>;
type QueryName = (typeof NEWS_QUERIES)[number];
type MutationName = (typeof NEWS_MUTATIONS)[number];

/**
 * Was die React-Seiten vom Client der Seite brauchen. Ein tRPC-Client mit dem Router aus
 * `createNewsAdmin` erfüllt diese Form direkt (`trpc.useUtils().client.news`).
 */
export type NewsClient = { [K in QueryName]: { query: (input: In<K>) => Promise<Awaited<ReturnType<NewsAdmin[K]>>> } } & {
  [K in MutationName]: { mutate: (input: In<K>) => Promise<Awaited<ReturnType<NewsAdmin[K]>>> };
};
