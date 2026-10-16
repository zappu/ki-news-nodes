# 0004 Kategorien kommen aus der Zielseite

KNP pflegt eine eigene Kategorienliste und legt fehlende Kategorien beim ersten Beitrag an. Die Node-Seiten definieren ihre Kategorien im Code (`shared/pages.ts`), viele mit eigener Seite, Menüeintrag und Texten. Deshalb liefert der Ziel-Adapter die Kategorienliste, die KI wählt daraus, und eine unbekannte Antwort führt zu „News“. Neue Kategorien legt die Pipeline nie an. Ein Profil kann eine feste Kategorie vorgeben; dann wählt die KI keine.

Stand: 16.10.2026, Grilling-Runde 2 und 3.
