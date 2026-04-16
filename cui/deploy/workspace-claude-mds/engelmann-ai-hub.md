# Engelmann AI Hub — Partner Workspace

## Zweck dieses Workspaces

Der Engelmann AI Hub ist ein KI-Workflow-Cockpit UND ERP-Ersatz fuer Engelmann Energiesysteme GmbH.
Das System ersetzt schrittweise die WIKO Bausoftware durch moderne, KI-gestuetzte Module.

**Die App laeuft auf Port 3009** — im Browser-Panel: `/app-proxy/3009`

---

## Wer nutzt diesen Workspace

### Kurt Engelmann — Prokurist & WIKO-Experte (Fachpartner)
Prokurist bei Engelmann Energiesysteme. **WIKO-Experte** der die ERP-Anforderungen definiert.
Entwickelt HTML-Dashboards und ERP-Module mit Claude Code.
**Sein Ziel:** WIKO durch moderne ERP-Module im AI Hub ersetzen.
**Was er braucht:** WIKO-Screenshots hochladen, ERP-Module entwickeln, fachliche Freigabe geben.
**Ton:** Fachlich, konkret, pragmatisch. Kurt kennt WIKO in- und auswendig.

### David Engelmann — Geschaeftsfuehrer (Product Owner)
Inhaber Engelmann Energiesysteme GmbH. EUR 25.000 Entwicklungspartnerschaft.
**Sein Ziel:** Eigene KI-Workflows fuer seine Kunden + WIKO ablosen.
**Was er braucht:** Workflows entwickeln/testen, strategische Entscheidungen.
**Ton:** Unternehmerisch, pragmatisch, auf Ergebnisse fokussiert.

### Sahori Nakamura — Workflow-Entwicklerin
Mitarbeiterin bei Engelmann, entwickelt Workflows mit Claude Code.
Login: `sahori@engelmann-es.at`

---

## WIKO ERP-Abloesung — Das Hauptprojekt

### Was ist WIKO?
WIKO ist Engelmanns bisheriges ERP-System (Projektcontrolling fuer Ingenieurbueros).
Die komplette WIKO-Datenbank wurde in die Engelmann Supabase importiert:

- **987 Tabellen** im Schema `wiko`
- **222.373 Datensaetze** (echte Produktionsdaten!)
- **2.148 Projekte**, 35.935 Zeitbuchungen, 1.390 Rechnungen (7,7 Mio EUR)
- **42 Mitarbeiter** (27 aktiv), 493 Adressen, 918 Kontakte

### Die Daten sind da — es fehlen die Oberflaechen

Die WIKO-Daten sind vollstaendig in der Supabase-Datenbank (Schema `wiko`).
Was jetzt gebaut werden muss: **Moderne React-Module die diese Daten anzeigen und bearbeiten**.

### Screenshot-Upload — So startest du

1. **Gehe zu:** ERP → **ERP Entwicklung** (in der Sidebar)
2. Dort siehst du **8 WIKO-Module** mit Upload-Slots fuer Screenshots
3. **Oeffne WIKO** auf deinem Rechner
4. Mache Screenshots von jeder Ansicht (`Win + Shift + S`)
5. Lade sie beim passenden Modul hoch
6. Sag mir welches Modul du zuerst nachbauen willst — ich baue es!

### Die 8 Kern-Module

| # | Modul | Was WIKO macht | Echte Daten |
|---|-------|---------------|-------------|
| 1 | **Zeiterfassung** | Stunden buchen auf Projekte | 35.935 Buchungen |
| 2 | **Projekt-Controlling** | Projektuebersicht, Budget, Status | 2.148 Projekte, 474 Auftraege |
| 3 | **Rechnungsstellung** | Ausgangsrechnungen, HOAI-Rechnungen | 1.390 Rechnungen, 7,7M EUR |
| 4 | **HOAI Honorar** | Honorarberechnung Leistungsphasen | 621 LPH-Zuordnungen |
| 5 | **Leistungsstand** | Fertigstellungsgrad pro Projekt | 13.835 Eintraege |
| 6 | **Mitarbeiterverwaltung** | Stammdaten, Anwesenheit, Urlaub | 42 Mitarbeiter |
| 7 | **Adressen/CRM** | Kunden, Kontaktpersonen | 493 Adressen, 918 Kontakte |
| 8 | **Nachunternehmer** | Sub-Planer, Abrechnungen | 57 Subunternehmer |

### Komplette Funktionsliste (66 Module, 8 Phasen)

Die vollstaendige Roadmap aller ERP-Module liegt unter:
`/root/projekte/werkingflow-business/products/engelmann/erp-vision/FUNKTIONSLISTE.md`

Phasen-Uebersicht:
- **Phase 0:** Foundation (Shell, Schema, Daten-Layer)
- **Phase 1:** Projekte & Zeiterfassung (11 Module) — **ZUERST**
- **Phase 2:** HOAI & Rechnungswesen (10 Module)
- **Phase 3:** Controlling & Leistungsstand (9 Module)
- **Phase 4:** CRM & Kontakte (5 Module)
- **Phase 5:** Vertraege & Nachunternehmer (5 Module)
- **Phase 6:** Dokumentation & Kommunikation (5 Module)
- **Phase 7:** Terminplanung (3 Module)
- **Phase 8:** Sonderfunktionen (6 Module)
- **AI-Funktionen:** 9 KI-Features die WIKO NICHT hat (LV-Generierung, Protokolle, etc.)

---

## Fuer Claude: ERP-Module entwickeln

### Grundprinzip
Kurt laed WIKO-Screenshots hoch → Du baust das Modul als React-Komponente nach.
**Gleiche Felder, gleiche Begriffe, moderneres Design (Dark Theme).**

### Technischer Stack

**Daten lesen/schreiben:** Ueber die generische WIKO API:
```
GET  /api/erp/wiko/meta                    → Alle Tabellen (Metadaten)
GET  /api/erp/wiko/meta?table=project      → Spalten einer Tabelle
GET  /api/erp/wiko/{table}                 → Datensaetze (mit Pagination, Sort, Search)
GET  /api/erp/wiko/{table}/{id}            → Einzelner Datensatz
POST /api/erp/wiko/{table}                 → Neuer Datensatz
PATCH /api/erp/wiko/{table}/{id}           → Datensatz aktualisieren
DELETE /api/erp/wiko/{table}/{id}          → Datensatz loeschen
```

**Query-Parameter (GET Liste):**
- `?page=1&limit=50` — Pagination
- `?sort=name_short&order=asc` — Sortierung
- `?search=Engelmann` — Volltextsuche (ueber Textfelder)
- `?status_id=eq.1` — Filter (PostgREST-Syntax)

**Schema-Metadaten:** `wiko-schema-metadata.json` im App-Root
Enthaelt fuer alle 987 Tabellen: Spaltennamen, Typen, PK, Nullable, Row-Count.

### Wo neue Module hingehoeren

```
src/app/erp/{modulname}/page.tsx           → Route/Page
src/components/erp/{Modulname}.tsx          → Komponente
```

Bestehende Module als Referenz:
- `src/components/erp/ErpZeiterfassung.tsx` — Wochenansicht mit Buchungs-Dialog
- `src/components/erp/ErpProjekteListe.tsx` — Projektliste
- `src/components/erp/ErpMitarbeiterListe.tsx` — Mitarbeiterliste
- `src/components/erp/ErpAdressenListe.tsx` — Adressliste mit Typ-Filter
- `src/components/erp/wiko/WikoDatenbankUebersicht.tsx` — Generische DB-Ansicht
- `src/components/erp/wiko/WikoTabellenansicht.tsx` — Generische CRUD-Tabelle

### Wichtige WIKO-Tabellen (Top 15 nach Nutzung)

| Tabelle | Zeilen | Beschreibung |
|---------|--------|-------------|
| `emplpresence` | 36.579 | Anwesenheit (Kommen/Gehen) |
| `tec` | 35.935 | Zeitbuchungen |
| `progression` | 13.835 | Leistungsstand/Fortschritt |
| `complete_progress` | 6.165 | Abgeschlossener Fortschritt |
| `b_invoice_compl` | 4.294 | Rechnungs-Completions |
| `empl2proj` | 4.123 | Mitarbeiter-Projekt-Zuordnung |
| `b_invoice2order` | 3.931 | Rechnung-Auftrag-Verknuepfung |
| `hoai_tabellen` | 2.927 | HOAI Honorartafeln |
| `struc` | 2.148 | Projektstruktur (PSP) |
| `project` | 2.148 | Projekte |
| `poscontr` | 1.587 | Positions-Controlling |
| `invoice` | 1.390 | Rechnungen |
| `charge_rates` | 1.286 | Stundensaetze |
| `payment` | 1.190 | Zahlungseingaenge |
| `contact` | 918 | Kontaktpersonen |

### Design-Regeln

- **Dark Theme:** `bg-slate-950`, `bg-slate-900` (Cards), `border-slate-800`
- **Text:** `text-white` (Titel), `text-slate-300` (Body), `text-slate-400` (Labels)
- **Akzente:** Gruen (Zeiterfassung), Blau (Projekte), Amber (Rechnungen), Purple (HOAI)
- **Icons:** Lucide React Icons
- **data-ai-id:** Auf wichtigen Elementen setzen (fuer Testing)
- **Responsive:** Desktop-first, aber mobile-friendly

### Workflow: Screenshot → Modul

1. Kurt zeigt Screenshot und sagt "Bau mir die Zeiterfassungs-Wochenansicht"
2. Du analysierst: Welche Felder, welches Layout, welche Interaktionen
3. Du fragst die WIKO API: `GET /api/erp/wiko/tec?limit=5` um echte Daten zu sehen
4. Du baust die React-Komponente mit echten Daten
5. Du fuegst sie unter `src/app/erp/zeiterfassung/page.tsx` ein
6. `npm run build:live` → Kurt sieht es live

---

## App starten / bauen

```bash
cd apps/engelmann

# App starten (bereits gebaut):
npm run start:live

# Neu bauen:
npm run build:live
```

**Engelmann nutzt `build:live`** (Supabase Production) — kein lokaler Docker noetig.
**NIEMALS** `npm run build` direkt — immer `build:live`.

---

## Test-Credentials

| Rolle | Email | Passwort |
|-------|-------|----------|
| David Engelmann (Owner) | `david@engelmann.at` | `Engelmann2024!` |
| Kurt Engelmann (Mitarbeiter) | `mitarbeiter@engelmann-es.at` | `EngelmannTeam2024!` |
| Sahori Nakamura (Dev) | `sahori@engelmann-es.at` | `EngelmannDev2024!` |

---

## WIKO Datenbank-Browser (bereits verfuegbar)

Unter **ERP → WIKO Datenbank** (`/erp/datenbank`) kann Kurt bereits ALLE 987 Tabellen:
- Durchsuchen, filtern, sortieren
- Einzelne Datensaetze ansehen
- Inline bearbeiten (Doppelklick auf Zelle)
- Neue Datensaetze anlegen
- Datensaetze loeschen

Das ist die generische Ansicht — die modulspezifischen Ansichten (Zeiterfassung, Projekte, etc.)
werden schrittweise als schoene Fach-UIs gebaut.

---

## Customer-Specs (Referenz-Dokumente)

Engelmanns Konzeptdokumente liegen unter:
`/root/projekte/orchestrator/workspaces/engelmann-ai-hub/customer-specs-engelmann/`

| Dokument | Inhalt |
|----------|--------|
| `TGA_Gesamtkonzept_V4.md` | Kurts Vision: 16 Software-Bausteine, On-Premise Server, n8n |
| `GEGENENTWURF_WERKINGFLOW_V1.md` | Rafaels Antwort: Cloud-first, AI Hub statt n8n |
| `TGA_Datenbank_Integration_Konzept.md` | Datenbank-Architektur |
| `TGA_Integration_MS365_Kommunikation.md` | MS365-Anbindung |
| `TGA-Datenbank-Dashboard-Konzept.pdf` | Kurts Dashboard-Entwuerfe |

---

## Wichtige Regeln

- **NIEMALS** `pkill -9 next-server` — killt alle Apps
- Ports pruefen: `ss -tlnp | grep 3009`
- Build-System: immer `build:live`, nie `npm run build` direkt
- **WIKO-Daten sind ECHT** — vorsichtig mit DELETE/UPDATE auf Produktionsdaten
- Bei Unsicherheit: Erst in der generischen WIKO-Datenbank nachschauen welche Spalten eine Tabelle hat
