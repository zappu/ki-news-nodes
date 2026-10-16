# 0005 Admin im Paket, Router in der Seite, Wartung im Lauf

Stand: 16.10.2026, Phase 5 (Fragen F22 bis F24)

## Frage

Wo liegen die Admin-Seiten und ihre Logik, wie wird der News-Bereich erprobt, und wann gehen die tägliche Mail und der Ablauf alter Einträge los?

## Entscheidung

1. **F22 ja, Admin im Paket.** Dienst (`createNewsAdmin`), Eingabe-Schemas (`newsInputs`) und React-Seiten (`NewsAdmin`) liegen im Paket. Die Seite hält nur eine dünne Datei `server/news/router.ts`, die jede Funktion mit ihrem `adminProcedure` verbindet.
2. **F23 nein, keine Testinstallation.** Der News-Bereich kommt mit dem normalen Update auf die Live-Seite, ist dort aber aus: kein aktives Profil, kein Plesk-Cron, Freigabe nötig. Erprobt wird vorher mit einer lokalen Kopie der Seite und der Testdatenbank (`server/news/news.test.ts`).
3. **F24 ja, Mail um 8 Uhr.** Die Wartung (Ablauf nach `expireDays`, Mail bei wartenden Artikeln) ist der erste Schritt jedes News-Laufs und läuft einmal am Tag ab `maintenanceHour` (Standard 8) in der Zeitzone der Seite.

## Abwägung

- Zu 1: Eine Router-Fabrik im Paket hätte tRPC und das `adminProcedure` der Seite übergeben bekommen müssen. Die Typen der Prozeduren gingen dabei verloren, der Admin-Client hätte nichts mehr geprüft. Die Zuordnung in der Seite ist eine Zeile je Funktion, die Logik bleibt trotzdem im Paket; neue Funktionen brauchen dort eine neue Zeile (die Liste steht in `NEWS_QUERIES`/`NEWS_MUTATIONS`).
- Zu 2: Eine eigene Testinstallation hätte eine zweite Datenbank, Domain und Plesk-App gebraucht. Ausgeschaltet ausgeliefert richtet der Bereich nichts an; die Tabellen entstehen, sonst passiert nichts.
- Zu 3: Der tägliche Cron der Seite (`/api/cron/cleanup`) läuft zu einer Zeit, die die Seite festlegt, und ist nicht an die News gebunden. In den News-Läufen hängt die Mail nur an der eigenen Einstellung, und es gibt keinen zweiten Einstiegspunkt. Fällt der Cron um 8 Uhr aus, holt der nächste Lauf die Wartung nach.

## Folgen

- Neue Admin-Funktion im Paket: Eintrag in `NEWS_QUERIES` oder `NEWS_MUTATIONS`, Changelog-Hinweis „Router der Seite ergänzen“.
- Ohne Plesk-Cron gibt es auch keine Mail und keinen Ablauf; der Knopf „Lauf jetzt starten“ führt die Wartung ebenfalls aus, wenn sie fällig ist.
