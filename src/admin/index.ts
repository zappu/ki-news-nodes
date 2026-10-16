/**
 * Server-Teil des Admin-Bereichs: Dienst und Eingabe-Schemas für die Admin-Prozeduren der Seite.
 * Die React-Seiten liegen unter `ki-news-nodes/admin/ui`.
 */
export { createNewsAdmin, newsInputs, NEWS_QUERIES, NEWS_MUTATIONS, NEWS_VERSION } from "./service";
export type { NewsAdmin, NewsAdminDeps, NewsClient, NewsOverview, QueueDetail, QueueListItem, RunSummary } from "./service";
