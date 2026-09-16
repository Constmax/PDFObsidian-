# Textboxen in PDF++ — Umsetzungsplan

Status: Entwurf, noch keine Implementierung.
Branch: `claude/gifted-euler-yooegv`

---

## 1. Ziel

Textboxen im Obsidian-PDF-Viewer, deren Bedienung sich an GoodNotes orientiert:
Werkzeug wählen, Stelle antippen oder Box aufziehen, direkt lostippen. Der Text
landet als echte Annotation **im PDF**, ist also auch außerhalb von Obsidian
sichtbar (Acrobat, Preview, Zotero) und später wieder editierbar.

Abgrenzung: Das ist bewusst *nicht* das Backlink-Highlight-Paradigma von PDF++
(Annotation als Markdown). Textboxen sind Inhalt des Dokuments, nicht Notizen
darüber.

---

## 2. Ausgangslage

### 2.1 Das Plugin

PDF++ v0.40.31, ~24.600 Zeilen TypeScript. Kein eigener Viewer — es patcht
Obsidians eingebauten pdf.js-Viewer per `monkey-around` (`src/patchers/`).
Das ist der bestimmende Architekturfakt.

Annotationen werden heute ausschließlich über pdf-lib geschrieben
(`src/lib/highlights/write-file/pdf-lib.ts`), und zwar nur die Subtypen
`Highlight`, `Underline`, `Squiggly`, `StrikeOut`, `Link`. Der Einstieg
`PdfLibIO.addAnnotation()` (Zeile 104) baut rohe PDF-Dictionaries.

### 2.2 Was die Konsolen-Tests ergeben haben

Getestet in Obsidian mit geöffnetem PDF, **ohne installiertes PDF++** — die
Befunde betreffen also Obsidians nativen Viewer, nicht das Plugin.

| Befund | Ergebnis |
|---|---|
| `pdfjsLib.AnnotationEditorType` | vollständig: `DISABLE -1, NONE 0, FREETEXT 3, HIGHLIGHT 9, STAMP 13, INK 15, SIGNATURE 101` |
| pdf.js-Version (abgeleitet aus `SIGNATURE`) | 5.x, also aktuell |
| `pdfjsViewer.AnnotationEditorLayerBuilder` | nicht auf dem Global exportiert |
| `PDFPageView.annotationEditorLayer` | **vorhanden und instanziiert** |
| `PDFViewer.prototype.annotationEditorMode` | Setter vorhanden, akzeptiert `{mode: 3}` |
| Ebenen-Div | `800×1133`, `pointer-events: auto`, Klasse `freetextEditing` gesetzt |
| `layer.createAndAddNewEditor(...)` | liefert `FreeTextEditor`-Instanz |
| DOM-Kinder der Ebene danach | **0** — nichts wurde gerendert |
| Fehler beim Rendern | `TypeError: Failed to convert value to 'AbortSignal'` in `AnnotationEditorUIManager.combinedSignal` |

**Interpretation:** Obsidian baut die Editor-Ebene bei jeder Seite auf, betreibt
sie aber nicht. Der `AnnotationEditorUIManager` ist in einem abgeräumten Zustand
— sein `AbortController` ist `null`, was in pdf.js genau nach `destroy()`
passiert. Die Klassen sind vorhanden, die Instanz ist tot.

### 2.3 Was das bedeutet

Die FreeText-Engine muss **nicht gebaut** werden. Sie ist da und funktioniert.
Was fehlt, ist ein lebender UIManager und die Anbindung an Obsidian.

Damit entfällt der Brocken, der dieses Vorhaben sonst teuer gemacht hätte: der
**Appearance Stream**. FreeText-Annotationen brauchen zur Darstellung ein
`/AP`-Objekt; pdf-lib hat dafür keine API, und es von Hand zu erzeugen bedeutet
Font-Einbettung, `/DR`-Resource-Dict, `/DA`-String und eigene Zeilenumbruch-
Berechnung. pdf.js erledigt das beim Speichern selbst.

---

## 3. Grundsatzentscheidung

Drei Wege standen zur Wahl:

| Weg | Beschreibung | Bewertung |
|---|---|---|
| A | `annotationEditorMode` umschalten, fertig | **verworfen** — UIManager ist tot, ein Moduswechsel allein reicht nicht |
| A− | Eigenen UIManager betreiben, pdf.js-Editor nutzen | **gewählt** |
| B | Eigener Overlay-Editor + FreeText via pdf-lib inkl. Appearance Stream | verworfen — 3–4 Wochen, hohes Risiko bei der PDF-Erzeugung |

**Gewählt: A−.** Wir nutzen pdf.js' `FreeTextEditor` und `AnnotationEditorLayer`,
stellen aber den UIManager selbst bereit und halten ihn am Leben.

Was wir dadurch geschenkt bekommen: Inline-Bearbeitung mit Caret, Verschieben,
Resize-Handles, Schriftgröße und Farbe über `AnnotationEditorParamsType`,
korrekte Koordinaten bei Zoom und Rotation, saubere Serialisierung.

---

## 4. Schwerpunkte und Probleme

Nach Schwierigkeit sortiert, nicht nach Reihenfolge.

### 4.1 UIManager-Lifecycle — das Kernproblem

Der UIManager ist abgeräumt. Zwei Ansätze, in dieser Reihenfolge zu prüfen:

**Ansatz 1 (billig, zuerst testen):** pdf.js seinen eigenen UIManager bauen
lassen, indem `annotationEditorMode` schon **vor** dem Laden des Dokuments
gesetzt ist. `PDFViewer.setDocument()` legt den Manager nur an, wenn der Modus
zu diesem Zeitpunkt passt. Im Konsolentest haben wir den Modus *nachträglich*
gesetzt — zu spät.

Der Hebel dafür existiert im Plugin bereits: `patchAppOptions()`
(`src/patchers/pdf-internals.ts:1140`) fängt `AppOptions.get` ab und
überschreibt heute schon drei Optionen. Dort `annotationEditorMode`
mitzuliefern ist eine Zeile.

Wenn das trägt, sinkt der Gesamtaufwand deutlich.

**Ansatz 2 (Rückfallebene):** UIManager selbst instanziieren. Problem: Die
Konstruktor-Signatur hat sich zwischen den pdf.js-Versionen mehrfach geändert
(Reihenfolge und Anzahl positionaler Argumente). Erfordert Feature-Detection
und eine Kompatibilitätsschicht, die bei unbekannter Signatur sauber aufgibt
statt etwas Kaputtes zu bauen.

Zusätzlich in beiden Fällen: Der Manager muss Seiten-Rerenders überleben. Bei
Zoom, Rotation und Scrollen baut pdf.js Ebenen neu auf.

### 4.2 Persistenz und die zwei Schreibpfade

Heute schreibt PDF++ **ausschließlich** über pdf-lib plus
`vault.modifyBinary()` (`write-file/pdf-lib.ts:85`). pdf.js' Editor schreibt
über `pdfDocument.saveDocument()`.

Beide erzeugen jeweils die **komplette Datei** aus ihrer eigenen Sicht des
Dokuments. Laufen sie nebeneinander, gewinnt der letzte Schreiber und die
Änderungen des anderen sind weg. Das ist der gefährlichste Punkt im ganzen
Vorhaben, weil der Schaden stille Datenverluste in den PDFs des Nutzers sind.

Gegenmaßnahmen:

- Ein einziger Commit-Trichter für Textboxen, der vor dem Schreiben prüft, ob
  die Datei seit dem Laden der pdf.js-Instanz verändert wurde.
- Bei Abweichung: nicht schreiben, sondern neu laden und den Nutzer informieren.
- Serialisierung gegen laufende pdf-lib-Schreibvorgänge.

Nebenaspekt Performance: Jeder Commit schreibt das gesamte PDF neu. Bei einem
80-MB-Scan ist das spürbar. Deshalb Commit bei Blur und entprellt, nicht pro
Tastendruck.

### 4.3 Viewer-Reload nach dem Schreiben

`vault.modifyBinary()` löst einen kompletten Neuaufbau des Viewers aus. Im
bestehenden Code sieht man den Workaround: ein `setTimeout(..., 300)` in
`src/lib/copy-link.ts:390`, weil danach sämtliche DOM-Referenzen tot sind.

Für uns entschärft, weil der Commit nur beim Verlassen der Box passiert und
nicht pro Zeichen. Trotzdem zu lösen: Scrollposition und Seite erhalten,
Editor-Zustand vor dem Reload sauber abschließen. Nach dem Reload ist die
Textbox eine normale PDF-Annotation und wird von der regulären Annotation-Ebene
gerendert — der Rundlauf sollte optisch stabil sein.

### 4.4 Klick-Routing und Koexistenz mit der Textauswahl

Im Test kam kein Klick bei der Editor-Ebene an. pdf.js' eigenes Klick-Handling
ist für die Standard-Viewer-Toolbar gedacht, die Obsidian nicht mitliefert.

Wir umgehen das, statt es zu reparieren: Platzierung über die im Plugin bereits
vorhandene Pointer-Logik aus `startRectangularSelection()`
(`src/color-palette.ts:457`) — erprobt, Touch-tauglich, rechnet Bildschirm- in
PDF-Koordinaten um. Das Werkzeug ist ein expliziter Modus mit Klasse am
Viewer-Element, Textebene auf `pointer-events: none`, Escape beendet. Genau das
Muster, das `pdf-plus-selecting` heute schon verwendet.

Das entspricht auch GoodNotes besser: Dort ist das Aufziehen einer Box eine
bewusste Geste mit aktivem Werkzeug, kein beliebiger Klick ins Dokument.

### 4.5 Mobile und Touch

`manifest.json` sagt `isDesktopOnly: false`. Gerade für GoodNotes-artige Nutzung
ist das iPad naheliegend.

Konkretes Risiko: `AbortSignal.any()` — die Funktion, an der unser Test
gescheitert ist — ist vergleichsweise jung. Auf älteren Android-WebViews fehlt
sie. Das muss erkannt werden und darf das Plugin nicht mitreißen.

### 4.6 Private APIs und Obsidian-Updates

PDF++ warnt im README bereits vor seiner Abhängigkeit von Obsidian-Interna. Die
Editor-Ebene liegt noch tiefer als alles, was das Plugin heute anfasst, und ist
Funktionalität, die Obsidian selbst nicht nutzt — also auch nicht testet. Jedes
Obsidian-Update kann das brechen.

Leitlinie: Feature-Detection an jeder Grenze, bei Fehlschlag eine verständliche
Meldung und Abschalten des Werkzeugs — niemals ein halb geschriebenes PDF.

### 4.7 Upstream-Refactor

Ushio arbeitet laut README an v1.0.0 mit „extensive refactoring". Ein Fork mit
großem Feature läuft auf schmerzhafte Rebases zu, besonders in `src/patchers/`
und `src/lib/highlights/`.

Gegenmaßnahme: alles Neue unter `src/lib/textbox/`, Eingriffe in bestehende
Dateien so klein und so wenige wie möglich.

---

## 5. Architektur

```
src/lib/textbox/
  index.ts          Submodul im Stil von PDFPlusLibSubmodule, Einstiegspunkt
  ui-manager.ts     UIManager beschaffen/am Leben halten, Feature-Detection
  tool.ts           Werkzeugmodus: Pointer-Logik, Platzierung, Escape
  persist.ts        saveDocument() -> vault.modifyBinary(), Konfliktprüfung
```

Eingriffe in Bestehendes, bewusst minimal:

| Datei | Änderung |
|---|---|
| `src/patchers/pdf-internals.ts:1140` | `annotationEditorMode` in `patchAppOptions` ergänzen |
| `src/toolbar.ts` | Werkzeug-Button registrieren |
| `src/settings.ts` | Schalter, Standard-Schriftgröße/-farbe |
| `styles.css` | Zustandsklassen für den aktiven Modus |
| `src/lib/index.ts` | Submodul einhängen |

Bestehende Gates werden respektiert: `lib.isEditable(child)` (`lib/index.ts:1034`,
prüft `enablePDFEdit` und ob die Datei extern liegt).

---

## 6. Meilensteine

**M0 — Spike UIManager (entscheidet den Gesamtaufwand)**
`annotationEditorMode` über den vorhandenen AppOptions-Patch *vor* dem
Dokumentladen setzen. Prüfen, ob dann ein lebender UIManager existiert und
`createAndAddNewEditor` eine sichtbare Box rendert.
*Ergebnis ja* → Rest wird deutlich billiger. *Ergebnis nein* → Ansatz 2 aus 4.1.

**M1 — Box erzeugen und tippen**
Werkzeugmodus, Platzierung über die Rect-Select-Pointer-Logik, Text eingeben.
Noch ohne Speichern.

**M2 — Persistenz**
Commit bei Blur, Konfliktprüfung, Reload-Handling. Ab hier im echten Vault
gegen echte PDFs testen.

**M3 — Wiedereditieren und Löschen**
Bestehende FreeText-Annotationen anfassen, ändern, entfernen.

**M4 — Format**
Schriftgröße und Farbe, angebunden an die vorhandene Farbpalette.

**M5 — Feinschliff Richtung GoodNotes**
Mitwachsende Box, Format-Leiste, Touch-Feinheiten.

MVP ist M0–M3. Realistisch **rund eine Woche**, abhängig vom Ausgang von M0.

---

## 7. Nicht im Scope des MVP

Freihand und Ink, Bilder und Stempel, Undo/Redo über Obsidians History,
Rotation einzelner Boxen, Textboxen als Ziel von PDF++-Backlinks
(siehe offene Fragen), Mehrspaltenlayout innerhalb einer Box.

---

## 8. Offene Fragen

1. **Backlink-Integration:** Sollen Textboxen wie andere Annotationen in
   PDF++' „Link zur Annotation kopieren"-System auftauchen? Technisch möglich
   (sie bekommen eine reguläre Annotation-ID), aber zusätzlicher Aufwand und
   konzeptionell eine andere Sache als eine Notiz *über* das Dokument.

2. **Mobile:** Muss das auf iPad/Android laufen, oder reicht Desktop für den
   ersten Wurf? Beeinflusst M1 und M5 spürbar.

3. **Speicherverhalten:** Automatisch bei Blur, oder explizit über Befehl und
   Button? Automatisch ist bequemer, schreibt bei großen PDFs aber oft die
   ganze Datei neu.

4. **Fork oder Upstream:** Dauerhaft eigener Fork, oder später ein Vorschlag an
   Ushio? Letzteres würde bedeuten, sich früh an seinen v1.0.0-Strukturen zu
   orientieren, statt gegen den heutigen Stand zu bauen.

---

## 9. Testbarkeit — wichtig

Das Feature hängt an Obsidian-Interna und lässt sich in dieser Umgebung
**nicht ausführen**. Hier entstehen typecheck- und lint-saubere Änderungen;
die Verifikation im echten Vault liegt beim Nutzer. Bei dieser Eingriffstiefe
sind mehrere Runden Rückmeldung einzuplanen.
