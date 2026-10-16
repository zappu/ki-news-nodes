# Glossar KI News Nodes

**Pipeline-Kern**: Der Teil, der Meldungen importiert, recherchiert, per KI neu schreibt, bebildert und an eine Zielseite übergibt. Kennt weder Blog-Tabelle noch Admin-Backend einer bestimmten Seite. _Nicht verwenden_: Plugin, Modul (für den Kern).

**Zielseite**: Eine Website, die fertige Artikel aus der Pipeline bekommt, zuerst smartwatch-fitnesstracker.de. _Nicht verwenden_: Kunde, Mandant, Instanz.

**Profil**: Ein Satz aus Themenprofil, Feeds, Brave-Suchbegriffen, Schreibvorgaben, Artikelziel pro Tag und optional fester Kategorie innerhalb einer Zielseite. Eine Zielseite hat ab Version 1 beliebig viele Profile, die sich Kostenlimit und Duplikatprüfung teilen. _Nicht verwenden_: Kanal, Feed-Set, Quelle.

**Ziel-Adapter**: Die Schnittstelle, über die der Kern auf einer Zielseite Beiträge anlegt, Bilder ablegt, Kategorien und bekannte Titel liest. _Nicht verwenden_: Connector, Exporter.

**Queue-Eintrag**: Eine RSS-Meldung oder ein Brave-Thema auf dem Weg durch die Pipeline, mit Status von `new` bis `published` oder `rejected`. _Nicht verwenden_: Artikel (erst nach der Veröffentlichung), Item, Job.

**Lauf**: Ein Durchgang durch alle Pipeline-Schritte für alle aktiven Profile einer Zielseite, gestartet vom Plesk-Cron-Skript oder per Knopf im Admin. Immer nur einer gleichzeitig je Zielseite. _Nicht verwenden_: Job, Batch.

**Freigabe**: Manuelle Bestätigung eines klassifizierten Queue-Eintrags im Admin; erst danach wird veröffentlicht. _Nicht verwenden_: Review, Prüfung.

**Abgelaufen**: Ein klassifizierter Queue-Eintrag, der 14 Tage nicht freigegeben wurde und deshalb aussortiert ist. _Nicht verwenden_: verworfen, gelöscht.
