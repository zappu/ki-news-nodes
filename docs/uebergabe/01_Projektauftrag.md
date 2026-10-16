# Projektauftrag: KI News für Node.js

## Ausgangslage

KI News Publisher (KNP) ist ein WordPress-Plugin von Thomas Wulff (Thoka Network). Es baut aus RSS-Meldungen und aus Themen der Brave-Suche fertige Blogbeiträge: Volltext laden, per KI prüfen und neu schreiben, Teaserbild erzeugen, mit SEO-Daten veröffentlichen. Ursprünglich entstand es für kanzlei-reese.de (Kanzlei für Recht und Steuern in Flensburg), seit 1.10.0 enthält es auch die Themensuche aus Kais Plugin „KI News Autopilot“ (gedacht für chatgpt-prompts.de).

Aktueller Stand des Plugins: 1.12.1 vom 16.10.2026. Repo `zappu/ki-news-publisher`, Branch `master`.

Mehrere Websites von Thomas laufen nicht auf WordPress, sondern auf Node.js mit eigenem Admin-Backend (Blogverwaltung, ZimmWriter-Bulk-Upload, Statistik, SEO, interne Verlinkung, Kommentare, siehe ralflist.de und die Skills `webprojekt-neu` und `webprojekt-admin-backend`). Diese Seiten sollen dieselbe News-Pipeline bekommen.

## Entscheidung bisher

Es wird kein Port des PHP-Codes, sondern ein Neubau in Node.js mit demselben Ablauf. Übernommen werden Logik, Prompts, Grenzwerte und Erfahrungen. Ersetzt wird alles, was WordPress liefert (Cron, Datenbank, Beiträge, Mediathek, SEO-Plugins, Admin-Seiten, Updater).

Zwei Wege standen zur Wahl:

**Weg 1, Modul im Admin-Backend.** Die Pipeline wird ein Modul, das als Bereich „News“ ins Admin-Backend der Node-Seiten eingehängt wird und Artikel in deren Blog-Speicher schreibt, wie es der ZimmWriter-Bulk-Upload tut. Schneller umsetzbar. Nachteil: zwei Codebasen (PHP-Plugin und Node-Modul), neue Funktionen müssen doppelt gebaut werden.

**Weg 2, zentraler Dienst.** Ein Node-Dienst auf Thomas' Server betreibt die Pipeline für mehrere Seiten und liefert fertige Artikel per API aus: an WordPress über die REST-API, an Node-Seiten über einen Import-Endpunkt. Pro Seite eine eigene Konfiguration. Mehr Aufwand, dafür eine Codebasis und als Angebot für Kunden nutzbar.

Empfehlung aus dem Vorgespräch: mit Weg 1 anfangen, den Pipeline-Kern aber so schneiden, dass er ohne Backend läuft und über einen Ziel-Adapter veröffentlicht. Dann ist der spätere Umstieg auf Weg 2 kein Neubau. Endgültig entschieden ist das noch nicht.

## Was mitkommt und was nicht

Mitkommen soll alles, was in `02` bis `05` beschrieben ist: RSS-Import mit Duplikatprüfung, Brave-Themensuche mit KI-Auswahl und Recherche, Crawl, KI-Klassifikation und Rewrite in einem Aufruf, Tags, Schreibstile und Längenstufen, Teaserbilder, Redaktions-Queue mit Freigabe und Sammel-Aktionen, Fehlerwiederholung mit drei Versuchen, Lauf-Sperre und Protokoll.

Nicht mitkommen muss:

- die Übernahme der Einstellungen aus „KI News Autopilot“ (betrifft nur WordPress),
- der Update-Mechanismus über `update.json` und mediainfo.space,
- die Umwege um WordPress-Hooks beim Anlegen von Beiträgen (direkter DB-Insert seit 1.9.0),
- Rank Math und Yoast, an ihre Stelle treten Meta-Felder im Beitrag.

## Arbeitsweise

- Neues Repo unter `zappu`, vor und nach jeder Änderung mit GitHub abgleichen.
- Versionierung nach SemVer mit Changelog auf Deutsch (Hinzugefügt, Geändert, Behoben, Sicherheit), wie im Plugin.
- Jede Version lauffähig und getestet, externe Dienste in Tests gemockt.
- Neue Projekte beginnen mit einer Grilling-Session, damit Plan und Vorgehen feststehen.

## Fragen für die Grilling-Session

Ziel und Umfang

1. Welche Node-Seiten sollen die Pipeline bekommen, und wie viele werden es voraussichtlich?
2. Nur für eigene Seiten oder später auch als Angebot für Kunden? Davon hängt Weg 1 oder 2 ab.
3. Soll das WordPress-Plugin langfristig weiter gepflegt werden oder irgendwann durch den zentralen Dienst ersetzt werden?

Technik der Zielseiten

4. Wie speichern die Node-Seiten ihre Blogbeiträge (Datenbank welcher Art, Dateien, Markdown)? Welche Felder hat ein Beitrag (Titel, Slug, Inhalt, Auszug, Kategorie, Tags, Bild, SEO-Titel, Meta-Description, Status, Autor, Datum)?
5. Wo liegen Bilder und in welchen Größen werden sie gebraucht?
6. Gibt es im Admin-Backend schon Bausteine für Tabellen, Filter und Sammel-Aktionen, die die Queue nutzen kann?
7. Läuft jede Seite als eigener Prozess (PM2, systemd), und wie werden Hintergrundjobs dort heute gestartet?
8. Welche Node-Version und welche Datenbank sind auf den Servern gesetzt?

Verhalten

9. Ein Profil pro Seite oder mehrere Profile pro Seite (z. B. getrennte Feed-Sets mit eigenen Prompts und Kategorien)? Das stand beim Plugin schon einmal als Wunsch im Raum.
10. Standard für neue Beiträge: Entwurf, zur Prüfung oder direkt veröffentlicht? Soll die manuelle Freigabe wie im Plugin Standard sein?
11. Welcher KI-Anbieter und welches Modell als Standard (Anthropic direkt oder OpenRouter)? Welcher Bildanbieter?
12. Wo sollen API-Keys liegen (Datenbank, `.env`, verschlüsselt)?
13. Brauchen die Node-Seiten Benachrichtigungen, z. B. eine Mail, wenn Artikel zur Freigabe warten?

Betrieb

14. Wie wird ausgerollt (Git-Pull auf dem Server, Paket, Container)?
15. Wie viele Artikel pro Tag sind je Seite realistisch, und gibt es ein Kostenlimit für KI und Bilder?

> Antworten auf diese Fragen: `PROJEKTPLAN.md` und `docs/entscheidungen/` (Grilling-Session vom 16.10.2026).
