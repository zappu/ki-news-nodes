# Erfahrungen aus KNP 1.0.0 bis 1.12.1

Jeder Punkt hier hat im Plugin mindestens eine Version gekostet. Im Node-Projekt von Anfang an berücksichtigen.

## Quellen und Feeds

**Feed-Qualität geht vor Menge.** Der BFH-Entscheidungsfeed (`precedent.rss`) lieferte nur Aktenzeichen wie „II R 17/23“ statt lesbarer Texte. Die KI konnte damit nichts anfangen, es gab JSON-Fehler und Aussortierungen. Der Feed flog in 1.4.0 raus. Nur Feeds nehmen, deren Links auf lesbare Meldungen führen.

**Instabile Feeds.** Die BMF-Feeds lieferten dauerhaft HTTP 504 und wurden entfernt. Ein kaputter Feed darf nie den ganzen Lauf stoppen, nur protokolliert werden.

**Verlagsfeeds.** Für Kanzlei Reese wurden Haufe, LTO und beck-aktuell bewusst ausgeschlossen (Urheberrecht, Lizenz). Gerichte erlauben die Übernahme ihrer Pressemitteilungen mit Quellenangabe: BFH mit Datum, BGH, BAG für die Feed-Einbindung. Bei jeder neuen Seite prüfen, welche Quellen rechtlich passen.

**Bot-Sperren.** Ab etwa 13.10.2026 lehnte Haufe Abrufe mit der Kennung „KINewsPublisher“ mit HTTP 410 ab, obwohl die Seiten existierten. Seit 1.12.1 sendet das Plugin Browser-Kennung und Browser-Kopfzeilen (Wortlaut in `04`). Ob das bei Haufe dauerhaft hilft, war am 16.10. noch nicht bestätigt.

**Soziale Netzwerke liefern keinen Artikeltext.** YouTube, X, Facebook, TikTok, Instagram, LinkedIn und Reddit werden bei der Recherche übersprungen.

**Gleiche Meldung, mehrere Feeds.** GUIDs unterscheiden sich, die URL ist gleich oder hat Tracking-Parameter. Lösung seit 1.4.0: zusätzlich zur GUID ein Hash der normalisierten URL (Regeln in `02`). Die Spalte bekam einen Index, Altdaten wurden nachberechnet.

## KI

**Ein Aufruf statt vieler.** Relevanz, Text, Teaser, SEO-Felder, Kategorie, Bildbriefing und Tags kommen aus einem einzigen KI-Aufruf. Tags kosteten dadurch in 1.5.0 nichts extra.

**JSON kommt nicht immer sauber.** Modelle setzen Codezäune oder Einleitungssätze davor. Deshalb das robuste Auslesen in `03`. In Node zusätzlich das Schema prüfen.

**Gedankenstriche.** Trotz Anweisung im Prompt setzt die KI sie. Seit 1.11.0 werden sie nachträglich aus allen Textfeldern entfernt. Die Regel gilt auch für Stil-Ableitung und Probetext.

**Länge und Token-Limit.** Lange Artikel brauchen Luft. Seit 1.10.0 bekommt OpenRouter wie Anthropic ein ausdrückliches Token-Limit und KI-Aufrufe haben 180 Sekunden Zeit. Seit 1.11.0 richtet sich das Limit nach der gezogenen Länge (`Höchstwortzahl * 4 + 2000`, höchstens 12 000). Ist das Limit zu knapp, bricht das JSON mitten im Artikel ab und der Aufruf zählt als Fehler.

**Zu wenig Stoff.** Ist eine Meldung kurz, soll die KI einordnen statt erfinden. Bei Brave-Themen ausdrücklich keine erfundenen Funktionen, Preise, Zahlen, Verfügbarkeiten oder Zitate. Brave-Themen mit weniger als 300 Zeichen Faktenbasis werden gar nicht erst geschrieben.

**Einheitliche Länge wirkt künstlich.** Deshalb seit 1.11.0 Längenstufen, aus denen pro Artikel zufällig gezogen wird.

**Fremde Prompts haben eigene Formatwünsche.** Übernommene Auswahl-Prompts aus „KI News Autopilot“ verlangten andere Ausgaben. Der feste Abschnitt „AUSGABE (hat Vorrang …)“ am Ende des User-Prompts löst das.

## Bilder

**Gemini liefert große PNGs** (um 2 MB, 1408 × 768). Seit 1.4.0 automatische Umwandlung in JPEG mit Qualität 80. Nach der Umwandlung müssen Größenvarianten und Metadaten neu erzeugt werden; das fehlte bis 1.7.0.

**Bildfehler blockieren nichts.** Ein fehlendes Bild ist kein Grund, den Artikel nicht zu veröffentlichen. Bildfehler werden nur notiert.

**Sicherheit.** Bild-URLs und Base64-Daten der Anbieter sind fremde Eingaben: SSRF-Prüfung, Größenlimit 8 MiB, Bildtyp aus den Bytes bestimmen, nur JPEG, PNG, WebP (seit 1.7.0).

## Laufsteuerung

**Sperren, die hängen bleiben.** Ein Transient mit 10 Minuten, dann ein Options-Lock mit Heartbeat (1.7.1): Abgebrochene PHP-Requests hinterließen Sperren, die alle folgenden Läufe still blockierten. 1.7.2 behob einen Heartbeat-Fehler in derselben Sekunde wie der Lock-Erwerb. Gelöst erst in 1.7.3 mit einem Advisory-Lock, der an die Datenbankverbindung gebunden ist und mit ihr verschwindet. Für Node: eine Sperre wählen, die beim Absturz des Prozesses von selbst frei wird (z. B. Postgres `pg_try_advisory_lock`, ein Lock mit Ablaufzeit in Redis oder eine Lock-Datei mit PID-Prüfung). Ein Lauf, der keine Sperre bekommt, wird übersprungen und sichtbar als „locked“ protokolliert.

**Sichtbar machen, wo es hängt.** Seit 1.8.0 werden Laufstatus und Teilprotokoll vor und nach jedem Schritt gespeichert, seit 1.8.1 auch jede Phase der Veröffentlichung pro Artikel. Erst damit ließ sich ein blockierender Hook eines anderen Plugins finden.

**Veröffentlichen zuerst.** Freigegebene Artikel warteten, weil vor ihnen Import, Crawl, KI und Bilder liefen. Seit 1.8.0 kommt die Veröffentlichung direkt nach der Fehlerwiederholung.

**Zeitbudget.** Seit 1.8.1 endet die Veröffentlichung nach 120 Sekunden regulär, der Rest folgt im nächsten Lauf.

**Doppelte Beiträge nach Abbruch.** Abgebrochene Läufe hinterließen Teilbeiträge, der nächste Lauf legte einen zweiten an. Seit 1.8.2 wird die Queue-ID direkt beim Anlegen am Beitrag gespeichert und vorher gesucht, seit 1.8.3 zusätzlich über Titel und Textanfang.

**Fremde Hooks.** Ein Drittanbieter-Plugin blockierte `wp_insert_post()`. Seit 1.9.0 schreibt KNP Beiträge direkt in die Datenbank. Das ist WordPress-spezifisch, die Lehre gilt trotzdem: Das Anlegen eines Beitrags muss kurz, nachvollziehbar und wiederholbar sein.

**Fehler wiederholen statt liegenlassen.** Bis 1.11.0 blieben fehlgeschlagene Artikel einfach auf „failed“. Seit 1.12.0 werden sie ab dem fehlgeschlagenen Schritt wiederholt, nach dem dritten Fehler aussortiert, die letzte Meldung bleibt sichtbar.

**Geplanter Job verschwindet.** Nach Deaktivierung, Migration oder gelöschten Cron-Einträgen fehlte der Job. Seit 1.7.1 prüft das Plugin bei jedem Laden, ob er geplant ist, und legt ihn sonst neu an. In Node: Der Zeitplan gehört in den Prozess, der ohnehin läuft, und muss einen Neustart überstehen.

**Manuelle Läufe nicht als eine lange Anfrage.** Kais „KI News Autopilot“ ließ einen manuellen Lauf als eine einzige lange AJAX-Anfrage laufen, die an Zeitlimits von PHP und Proxy scheitert. Im Node-Backend den Lauf als Hintergrundjob starten und den Fortschritt abfragen.

## Redaktion

**Die Queue läuft voll.** Stand 16.10.2026 warteten auf kanzlei-reese.de 264 Artikel unter „Klassifiziert“, weil die manuelle Freigabe an war und niemand freigab. Seit dem 9.10. erschien kein Beitrag. Für Node überlegen: Hinweis oder Mail, wenn Artikel warten; Ablaufdatum für alte, nicht freigegebene Meldungen; Zähler im Dashboard.

**Sammel-Aktionen sind Pflicht.** Einzelfreigaben waren bei vielen Artikeln zu langsam (1.6.0).

**Styling ohne Codeänderung.** Quellenangabe und KI-Hinweis tragen feste IDs (`knp-source-attribution`, `knp-ai-disclosure`), damit das Theme sie gestalten kann (1.3.0).

**Kategorien legen sich selbst an.** Fehlt eine Kategorie aus der Liste, wird sie beim ersten passenden Beitrag angelegt.

## Testen

Im Plugin-Repo läuft WordPress mit SQLite in einer Sandbox, alle externen Abrufe (Feeds, Quellseiten, Brave, KI, Bilder) werden abgefangen und mit festen Antworten beantwortet. Für Node dasselbe Prinzip: HTTP-Aufrufe zentral über einen Client, der sich in Tests durch Attrappen ersetzen lässt, und Testfälle für jeden Statusübergang samt Fehlerpfaden.

## Release-Disziplin

Jede Änderung im Plugin bekam eine Version, einen Changelog-Eintrag und ein geprüftes Paket. Versionsnummer an mehreren Stellen gleichzeitig ändern, das vergisst man leicht. Im Node-Projekt nach Möglichkeit eine einzige Quelle für die Version (`package.json`) und den Rest daraus ableiten.

> Anmerkung zum Node-Projekt: Abweichend vom Absatz „Geplanter Job verschwindet“ läuft der Zeitplan über Plesk-Cron und ein Skript (`docs/entscheidungen/0002`), abweichend von „Styling ohne Codeänderung“ und „Kategorien legen sich selbst an“ gelten die Entscheidungen 0003 und 0004.
