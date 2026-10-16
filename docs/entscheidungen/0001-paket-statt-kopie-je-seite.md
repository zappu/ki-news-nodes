# 0001 Eigenes Paket statt Kopie je Seite

Jede Node-Seite ist ein eigenes Repo aus der SSR-Vorlage. Ein Modul in der Vorlage hätte bei fünf Seiten fünf Kopien bedeutet, die auseinanderlaufen. Deshalb wird die Pipeline ein eigenes Repo `zappu/ki-news-nodes` (Kern, Admin-Router und -Seiten, Adapter für `blog_posts`), das jede Seite als Abhängigkeit einbindet und beim Build in `dist/` bündelt, damit Plesk beim NPM install keinen GitHub-Zugang braucht.

KNP für WordPress bekommt nur noch Fehlerbehebungen, neue Funktionen entstehen im Node-Kern. Ein zentraler Dienst für Kunden (Weg 2) ist kein Ziel für Version 1; der Kern bleibt so geschnitten, dass er später als Dienst laufen kann (`site_id` in allen Tabellen).

Stand: 16.10.2026, Grilling-Runde 1.
