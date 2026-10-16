# 0003 Prompts liefern weiter HTML, der Adapter wandelt in Markdown

Die Node-Seiten speichern Artikel als Markdown und lassen rohes HTML nur nach einer Positivliste zu (keine `id` an `div`, Klassen nur `btie-`/`toc-`). Die Prompts aus `docs/uebergabe/03` bleiben trotzdem wörtlich, weil sie über viele Läufe eingestellt sind; der Ziel-Adapter wandelt das KI-HTML mit turndown in Markdown um. Quellenangabe und KI-Hinweis werden als Markdown angehängt (Abschnitt „Quellen“ als Liste, Hinweis kursiv) statt als `div` mit fester ID.

Stand: 16.10.2026, Grilling-Runde 1.
