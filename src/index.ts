/**
 * Öffentliche Schnittstelle des Pakets `ki-news-nodes`.
 */
import pkg from "../package.json";

export const VERSION: string = pkg.version;

export type { PipelineContext } from "./core/context";
export { createHttpClient, isBlockedAddress, HttpError, BROWSER_HEADERS, textOf } from "./core/http";
export type { HttpClient, HttpRequest, HttpResponse } from "./core/http";
export { runPipeline } from "./core/pipeline";
export type { RunResult } from "./core/pipeline";
export { parseProfileConfig, parseSiteSettings, CRON_INTERVALS } from "./core/settings";
export type { Profile, ProfileConfig, SiteSettings } from "./core/settings";
export { QUEUE_STATUSES, BRAVE_FEED_MARK } from "./core/types";
export type { Category, LlmFn, LlmRequest, PostPayload, PublishTarget, QueueEntry, QueueStatus, SourceKind } from "./core/types";
export { createNewsStore, NewsStore, MAX_ATTEMPTS } from "./store/store";
export { runCli } from "./cli";
export type { CliEnvironment } from "./cli";
