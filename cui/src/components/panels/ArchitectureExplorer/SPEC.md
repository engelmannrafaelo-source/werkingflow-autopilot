# Architecture Explorer — CUI Panel Specification

## Vision

Ein interaktives, filterbares Architektur-Diagramm-Tool als CUI Panel.
Ein einziger **Master-Graph** beschreibt die gesamte WerkIngFlow-Architektur.
Durch **Filter** erzeugt man beliebige Teilansichten — Drill-Down ist kein Zoom,
sondern ein neuer Filter auf denselben Graphen.

**Kern-Idee:** Der Graph ist die Architektur-Dokumentation.
Kuratiert, nicht auto-generiert. Erklaert das "Warum", nicht das "Was".

---

## Herkunft: RLB Mermaid Tool

Portierung der Core-Logik aus `/root/tools/rlb-mermaid/tool/EnergyMermaidTool.py`.
Das Original ist ein PyQt5-Desktop-Tool fuer Energiekonzept-Diagramme (RLB Campus Linz).
Die Graph-Datenstruktur und `filter_graph()` werden nach TypeScript portiert.

---

## Rendering-Architektur: Swappable Renderer

Das System trennt **Daten** (Graph-Datenstruktur + Filter-Logik) von **Darstellung** (Renderer).
Der Renderer ist austauschbar — die Graph-Engine bleibt gleich.

```
MASTER.yaml
    ↓ load_graph_from_yaml()
Graph-Datenstruktur (Node[], Edge[], Subfig[])
    ↓ filter_graph(graph, filterStr)
Gefilterter Graph
    ↓ Renderer (austauschbar!)
    ├── v1: MermaidRenderer  → graph_to_mermaid() → mermaid.render() → SVG
    └── v2: CustomSVGRenderer → React <svg> Elemente (spaeter)
```

### v1: Mermaid-Renderer (sofort)
- `graph_to_mermaid()` konvertiert den gefilterten Graphen in Mermaid-Syntax
- `mermaid.render()` erzeugt SVG (mermaid ^11.13.0 ist bereits installiert)
- Klick-Events via Mermaid `click` Callbacks oder SVG `onclick`
- Styling via Mermaid `classDef` + Theme-Config
- Mermaid v11 Features: Neo-Look, ELK-Layout, Dark Mode, Architecture-Diagrams

### v2: Custom SVG-Renderer (spaeter, wenn Mermaid-Look nicht reicht)
- React rendert `<svg>` direkt (`<rect>`, `<line>`, `<text>`, `<g>`)
- Volle Kontrolle ueber Styling (eigenes CUI Design-System)
- Layout via `dagre` (30KB, nur Berechnung) oder manuelle Positionen aus YAML
- Klick-Events trivial (`onClick` auf SVG-Elemente)
- Zoom/Pan via `transform` Matrix
- Keine externe Rendering-Dependency

### Warum nicht Cytoscape.js?
- Cytoscape ist ein generisches Netzwerk-Tool (Graph-Theorie, Force-Directed)
- Unser Case ist spezifisch: kuratierte Architektur mit Metaphern, ~20-50 Nodes
- Wir brauchen keine Graph-Theorie (shortest path, centrality etc.)
- Eigenes Rendering gibt volle Kontrolle ueber das Aussehen
- Weniger Dependency, weniger Bloat

### Renderer-Interface
```typescript
interface ArchitectureRenderer {
  render(graph: Graph, container: HTMLElement): void;
  onNodeClick(callback: (nodeId: string) => void): void;
  destroy(): void;
}
```
Beide Renderer implementieren dasselbe Interface.
Swap = eine Zeile aendern.

---

## Datenmodell

### Graph-Struktur (portiert aus EnergyMermaidTool.py)

```typescript
interface Node {
  id: string;           // Eindeutige ID: "engelmann", "infisical", "ai-bridge"
  label: string;        // Anzeigename: "Forschungszentrum", "TUeV-Pruefstelle"
  class_name: string;   // Typ/Kategorie → steuert Farbe via classDef
  figs: string;         // Subgraph-Zugehoerigkeit (Stadtviertel)
  metadata?: Record<string, any>;  // Beliebige Zusatzdaten (port, path, description)
}

interface Edge {
  source: string;       // Node-ID
  target: string;       // Node-ID
  label?: string;       // Beschreibung der Verbindung
  type: string;         // Mermaid-Connector: "-->" | "<-->" | "-.->" etc.
}

interface Subfig {
  annotation: string;   // Subgraph-Titel (z.B. "Produktion", "Infrastruktur")
  nodes: Node[];
  edges: Edge[];
  subfigs: Subfig[];    // Rekursiv verschachtelbar!
}

interface Graph {
  class_defs: ClassDef[];   // Farb-/Style-Definitionen pro Typ
  subfigs: Subfig[];        // Top-Level Subgraphs
}

interface ClassDef {
  class_name: string;       // z.B. "app", "infrastructure", "external"
  properties: {
    fill: string;           // Hintergrundfarbe
    stroke: string;         // Randfarbe
    color?: string;         // Textfarbe
    [key: string]: string | undefined;
  };
}
```

### Metaphern als class_name

| class_name | Metapher | Farbe | Beispiele |
|---|---|---|---|
| `app` | Produktionshalle | Blau #4a9eff | Engelmann, Report, Energy, Safety |
| `infrastructure` | Stadtwerk | Gruen #9ece6a | Orchestrator, CUI, Build-System |
| `external` | Zulieferer | Rot #f7768e | OpenAI, Anthropic, M365 |
| `database` | Speicher/Lager | Gelb #e0af68 | Supabase, Blob Storage |
| `tester` | TUeV-Pruefstelle | Lila #bb9af7 | Unified-Tester |
| `ci_cd` | Logistik | Orange #ff9e64 | Vercel, Railway, GitHub |
| `secret` | Tresor | Dunkelrot #914c54 | Infisical |
| `person` | Bewohner | Tuerkis #7dcfff | Rafael, David (Persona) |
| `workflow` | Fliesband | Rosa #c0a6db | Wizard-Engine, Manifest-Runner |

### Subgraphs als Stadtviertel (figs)

| figs | Stadtviertel | Inhalt |
|---|---|---|
| `produktion` | Industriegebiet | Alle Apps (Engelmann, Report, Energy, Safety, Noise, Platform) |
| `infrastruktur` | Stadtverwaltung | Orchestrator, CUI, Build-System, Port-Registry |
| `qualitaet` | TUeV-Gelaende | Unified-Tester, Szenarien, Validatoren |
| `zulieferer` | Aussenbereich | OpenAI, Anthropic, M365, Supabase |
| `deployment` | Logistikzentrum | Vercel, Railway, GitHub, Infisical |
| `forschung` | Forschungspark | AI-Bridge, Research-Endpoint |

---

## Kern-Operationen

### 1. filter_graph(graph, filterStr) — Das Herzstueck

Portiert aus `EnergyMermaidTool.py:408`. Filtert den Graphen nach Kriterien.

**Filter-Syntax:**
```
class_name=app                              → Alle Apps
figs=produktion                             → Alles im Produktionsviertel
id=engelmann                                → Nur Engelmann + Nachbarn
class_name=app AND figs=produktion          → Apps im Produktionsviertel
id=infisical OR id=vercel OR id=railway     → Secret-Flow
label=Forschungszentrum                     → Suche nach Name
```

**Verhalten (wie im Original):**
1. Finde alle Nodes die den Kriterien entsprechen
2. Finde alle Edges die diese Nodes verbinden
3. Finde alle Nachbar-Nodes dieser Edges (1 Hop)
4. Entferne leere Subfigs
5. Gib den gefilterten Graphen zurueck

### 2. graph_to_mermaid(graph) — Mermaid-Output (v1 Renderer)

Konvertiert den (gefilterten) Graphen in Mermaid-Syntax.
Erzeugt: graph direction, subgraphs, nodes mit classDef, edges mit labels.

### 3. load_graph_from_yaml(content) — YAML-Import

Laedt einen Master-Graphen aus YAML. Format kompatibel mit dem RLB-Tool.

### 4. load_graph_from_mmd(content) — MMD-Import (optional)

Parst `.mmd` Mermaid-Dateien zurueck in die Graph-Datenstruktur.
Niedrigere Prioritaet — YAML ist die primaere Quelle.

---

## CUI Panel: ArchitectureExplorer

### Layout

```
+------------------------------------------------------------------+
| Architecture Explorer                                            |
| [Filter: _______________] [Kriterium: v] [Apply] [Reset] [Undo] |
+------------------------------------------------------------------+
| Quick: [Apps] [Infra] [Deploy] [Tests] [External] [Secrets]     |
+------------------------------------------------------------------+
|                                                                  |
|  +------------------------------------------------------------+ |
|  |                                                            | |
|  |              Diagramm (Mermaid v1 / SVG v2)                | |
|  |                                                            | |
|  |     Zoom/Pan                                               | |
|  |     Klick auf Node → Filter auf diesen Node                | |
|  |                                                            | |
|  +------------------------------------------------------------+ |
|                                                                  |
| Gesamt > figs=produktion > id=engelmann                          |
+------------------------------------------------------------------+
```

### UI-Elemente

**Header:**
- **Filter-Textfeld**: Freie Eingabe oder Vorschlaege aus Autocomplete
- **Kriterium-Dropdown**: `figs` | `id` | `label` | `class_name` (wie im RLB-Tool)
- **Apply-Button**: Filter anwenden
- **Reset-Button**: Zurueck zur Gesamtansicht
- **Undo-Button**: Letzten Filter rueckgaengig machen

**Quick-Filter-Leiste:**
- Vordefinierte Filter als klickbare Chips/Buttons
- Konfigurierbar (Quick-Filter werden aus MASTER.yaml geladen)

**Hauptbereich:**
- Diagramm, gerendert via aktuellem Renderer (v1=Mermaid, v2=CustomSVG)
- Zoom/Pan (Mermaid-nativ in v1, eigene transform-Matrix in v2)
- **Klick auf Node**: Wendet `filter_graph(graph, "id=<clicked-node>")` an
  → Zeigt den geklickten Node + alle seine direkten Nachbarn
  → Breadcrumb wird aktualisiert

**Footer / Breadcrumb:**
- **Filter-History**: Zeigt den Filterpfad
  - `Gesamtansicht > figs=produktion > id=engelmann`
  - Klick auf fruehere Stufe → springt zurueck

### Interaktionen

| Aktion | Ergebnis |
|---|---|
| Panel oeffnen | Master-Graph wird geladen, Gesamtansicht gerendert |
| Filter eingeben + Apply | `filter_graph()` wird aufgerufen, neues Diagramm gerendert |
| Klick auf Node | Filter `id=<node>` wird angewendet (Drill-Down) |
| Quick-Filter klicken | Vordefinierter Filter wird angewendet |
| Reset | Zurueck zur ungefilterten Gesamtansicht |
| Undo | Letzter Filter wird entfernt |
| Breadcrumb-Klick | Springt zum entsprechenden Filter-Level zurueck |

### Vordefinierte Quick-Filter

| Label | Filter |
|---|---|
| Apps | `class_name=app` |
| Infra | `figs=infrastruktur` |
| Deploy | `figs=deployment` |
| Tests | `figs=qualitaet` |
| External | `class_name=external` |
| Secrets | `id=infisical OR id=vercel OR id=railway` |

---

## Master-Graph: MASTER.yaml

Lebt in: `/root/projekte/orchestrator/architecture/MASTER.yaml`

Wird vom CUI-Server geladen via `/api/architecture/graph`.
Gecached (30s TTL).

### Beispiel-Struktur (Ausschnitt)

```yaml
graph:
  class_defs:
    - class_name: app
      properties:
        fill: "#4a9eff"
        stroke: "#1a365d"
    - class_name: infrastructure
      properties:
        fill: "#9ece6a"
        stroke: "#2d5016"
    - class_name: external
      properties:
        fill: "#f7768e"
        stroke: "#7a1d2e"
    - class_name: tester
      properties:
        fill: "#bb9af7"
        stroke: "#5a3d7a"
    - class_name: secret
      properties:
        fill: "#914c54"
        stroke: "#5a2d33"
    - class_name: ci_cd
      properties:
        fill: "#ff9e64"
        stroke: "#7a4d30"
    - class_name: database
      properties:
        fill: "#e0af68"
        stroke: "#7a5d30"

  quick_filters:
    - label: Apps
      filter: "class_name=app"
    - label: Infra
      filter: "figs=infrastruktur"
    - label: Deploy
      filter: "figs=deployment"
    - label: Tests
      filter: "figs=qualitaet"
    - label: Secrets
      filter: "id=infisical OR id=vercel OR id=railway"

  subfigs:
    - annotation: "Produktion"
      nodes:
        - id: engelmann
          label: "Forschungszentrum\n(Engelmann AI Hub)"
          class_name: app
          metadata:
            port: 3009
            description: "KI-gestuetztes Dokumentenmanagement"
        - id: werking-report
          label: "Halle Gutachten\n(WerkING Report)"
          class_name: app
          metadata:
            port: 3008
            description: "Gutachten-Generator mit Wizard-Engine"
        - id: werking-energy
          label: "Halle Energie\n(WerkING Energy)"
          class_name: app
          metadata:
            port: 3007
        - id: werking-safety
          label: "Halle Sicherheit\n(WerkING Safety)"
          class_name: app
          metadata:
            port: 3006
        - id: werking-noise
          label: "Halle Laerm\n(WerkING Noise)"
          class_name: app
          metadata:
            port: 3005
        - id: platform
          label: "Hauptgebaeude\n(WerkING Platform)"
          class_name: app
          metadata:
            port: 3004
      edges:
        - source: engelmann
          target: supabase
          label: "Auth + Daten"
          type: "-->"
        - source: werking-report
          target: vercel
          label: "Deploy"
          type: "-->"
        - source: werking-energy
          target: railway
          label: "Backend"
          type: "-->"
        - source: werking-safety
          target: railway
          label: "Backend"
          type: "-->"

    - annotation: "Infrastruktur"
      nodes:
        - id: orchestrator
          label: "Rathaus\n(Orchestrator)"
          class_name: infrastructure
          metadata:
            description: "Zentrale Steuerung, Port-Registry, Build-System"
        - id: cui
          label: "Kommandozentrale\n(CUI)"
          class_name: infrastructure
          metadata:
            port: 4005
            description: "Virtual Office, Panel-System, Mission Control"
      edges:
        - source: orchestrator
          target: cui
          label: "steuert"
          type: "-->"

    - annotation: "Qualitaetskontrolle"
      nodes:
        - id: unified-tester
          label: "TUeV-Pruefstelle\n(Unified Tester)"
          class_name: tester
          metadata:
            description: "Autonomer 5-Layer Test-Runner"
      edges:
        - source: unified-tester
          target: ai-bridge
          label: "AI-Entscheidungen"
          type: "-->"
        - source: unified-tester
          target: engelmann
          label: "testet"
          type: "-.->"
        - source: unified-tester
          target: werking-report
          label: "testet"
          type: "-.->"

    - annotation: "Deployment & Secrets"
      nodes:
        - id: infisical
          label: "Tresor\n(Infisical)"
          class_name: secret
          metadata:
            description: "Self-hosted Secret Management"
        - id: vercel
          label: "Paketdienst Frontend\n(Vercel)"
          class_name: ci_cd
        - id: railway
          label: "Paketdienst Backend\n(Railway)"
          class_name: ci_cd
        - id: github
          label: "Bauplan-Archiv\n(GitHub)"
          class_name: ci_cd
      edges:
        - source: infisical
          target: vercel
          label: "Secrets sync"
          type: "-->"
        - source: infisical
          target: railway
          label: "Secrets sync"
          type: "-->"
        - source: github
          target: vercel
          label: "CI/CD trigger"
          type: "-->"
        - source: github
          target: railway
          label: "CI/CD trigger"
          type: "-->"

    - annotation: "Zulieferer"
      nodes:
        - id: supabase
          label: "Lagerhalle\n(Supabase)"
          class_name: database
          metadata:
            description: "Auth + PostgreSQL + Storage"
        - id: openai
          label: "KI-Labor\n(OpenAI)"
          class_name: external
        - id: anthropic
          label: "KI-Labor\n(Anthropic)"
          class_name: external

    - annotation: "Forschung"
      nodes:
        - id: ai-bridge
          label: "Forschungsbruecke\n(AI-Bridge)"
          class_name: infrastructure
          metadata:
            description: "Hetzner Server, Research-Endpoint, Claude SDK"
      edges:
        - source: ai-bridge
          target: anthropic
          label: "Claude API"
          type: "-->"
```

---

## Backend-API

### Endpoints

```
GET  /api/architecture/graph         → Master-Graph als JSON (30s Cache)
POST /api/architecture/refresh       → Cache invalidieren
```

Der Server liest `MASTER.yaml`, parst es, und liefert die Graph-Datenstruktur als JSON.

---

## Dateien (geplant)

```
cui/src/components/panels/ArchitectureExplorer/
├── SPEC.md                    # Diese Datei
├── ArchitectureExplorer.tsx   # Haupt-Panel (Header + DiagramView + Breadcrumb)
├── engine/
│   ├── types.ts               # Graph, Node, Edge, Subfig, ClassDef Interfaces
│   ├── filter.ts              # filter_graph() — Portierung aus Python
│   ├── mermaid-export.ts      # graph_to_mermaid() — Graph → Mermaid-String (v1)
│   └── yaml-import.ts         # load_graph_from_yaml() — YAML → Graph
├── renderers/
│   ├── renderer.ts            # ArchitectureRenderer Interface
│   ├── MermaidRenderer.tsx    # v1: Mermaid-basiertes Rendering
│   └── SVGRenderer.tsx        # v2: Custom React SVG Rendering (spaeter)
├── components/
│   ├── FilterBar.tsx          # Filter-Eingabe + Kriterium-Dropdown + Quick-Filter
│   └── Breadcrumb.tsx         # Filter-History / Navigation
└── hooks/
    └── useArchGraph.ts        # React Hook: Graph laden, filtern, History verwalten

cui/server/routes/
└── architecture.ts            # Backend: MASTER.yaml laden + cachen

orchestrator/architecture/
└── MASTER.yaml                # Single Source of Truth fuer die Architektur
```

---

## Abgrenzung

### Was dieses Tool IST
- Kuratiertes Architektur-Diagramm (manuell gepflegt)
- Filterbarer Master-Graph mit Drill-Down via Filter
- Swappable Rendering (Mermaid v1 → Custom SVG v2)
- Erklaerend: "Wie funktioniert X?" → Filter → Teilansicht

### Was dieses Tool NICHT IST
- Kein Code-Level-Graph (keine Dateien, keine Imports, keine AST-Analyse)
- Kein auto-generierter Graph (keine Scanner, keine Registries)
- Keine 3D-Stadt (kein PixiJS, kein ECS, keine Isometrie)
- Kein generisches Netzwerk-Tool (kein Cytoscape, kein D3)

### Verhaeltnis zu bestehenden Tools
- **generate-campus**: Bleibt als HTML-Generator fuer statische Karten
- **campus.json**: Bleibt als Datenquelle fuer generate-campus
- **MASTER.yaml**: Neues File, unabhaengig von campus.json, eigene Struktur
- **RLB Mermaid Tool**: Original bleibt in `/root/tools/rlb-mermaid/`, wir portieren nur die Core-Logik
- **Mermaid**: Bereits im CUI installiert, wird als v1 Renderer genutzt

---

## Validierung: Ansatz ist bestaetigt

Bridge-Recherche (Maerz 2026) hat bestaetigt:
- **"Filterable Master Graph"** Pattern validiert durch Structurizr (C4) und Ilograph
- **Stadt-Metaphern** akademisch abgesichert (Wettel & Lanza 2007, 1900+ Zitierungen)
- **Funktionale Metaphern** (Forschungszentrum, TUeV) sind ein valider neuer Twist
- **Mermaid v11** hat Neo-Look, ELK-Layout, Dark Mode — reicht fuer v1
- **Custom SVG** ist besser fuer spezifische Use-Cases als generische Graph-Libraries
- Volle Recherche: `/root/orchestrator/workspaces/engelmann-ai-hub/bridge-research-architecture-diagrams.md`

---

## Nicht in v1 (spaeter)

- Custom SVG Renderer (v2 — wenn Mermaid-Look nicht reicht)
- Branch/Merge (3-Way-Merge wie im RLB-Tool)
- Szenarien (abgeleitete Ansichten die mit Master synchron bleiben)
- Daten-Overlay (Live-Port-Status, Messwerte auf Nodes)
- YAML-Editor im Panel (Master-Graph inline bearbeiten)
- Auto-Sync mit campus.json (bidirektionale Synchronisation)
- Sub-Graphen pro App (App-interne Architektur als eigene YAML)
- Navigation zu Code-Dateien (Klick auf Node → oeffnet Datei im Preview)

---

## Verifikation

1. CUI starten, Panel "Architecture Explorer" ueber Dropdown hinzufuegen
2. Master-Graph wird geladen → Gesamtansicht mit allen Nodes sichtbar
3. Filter `class_name=app` → nur die 6 Apps sichtbar + deren Verbindungen
4. Klick auf "Engelmann" Node → Drill-Down: Engelmann + direkte Nachbarn
5. Breadcrumb zeigt: `Gesamt > class_name=app > id=engelmann`
6. Klick auf "Gesamt" in Breadcrumb → zurueck zur Gesamtansicht
7. Reset-Button → Gesamtansicht
8. Quick-Filter "Apps" → nur Produktionshallen sichtbar
9. Mermaid-Diagramm hat Dark-Mode Styling passend zum CUI
