/**
 * Testdatenbank: MySQL oder MariaDB, Standard `mysql://news:newspass@127.0.0.1:3306/news_test`,
 * änderbar über `TEST_DATABASE_URL`. Die Tests legen die Tabellen jedes Mal neu an.
 */
import { createNewsStore, type NewsStore } from "../../src/store/store";

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "mysql://news:newspass@127.0.0.1:3306/news_test";

export async function freshStore(now?: () => Date): Promise<NewsStore> {
  const store = createNewsStore({ url: TEST_DATABASE_URL, connectionLimit: 6 }, now);
  const [rows] = await store.pool.query("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name LIKE 'news\\_%'");
  for (const r of rows as { t: string }[]) await store.pool.query(`DROP TABLE IF EXISTS \`${r.t}\``);
  await store.migrate();
  return store;
}
