import { useState, useMemo, useCallback, type JSX } from 'react';
import type { IJsonModel } from 'flexlayout-react';

// --- Panel options for cell assignment ---
const PANEL_OPTIONS = [
  { value: 'cui:rafael', label: 'CUI: Rafael' },
  { value: 'cui:engelmann', label: 'CUI: Engelmann' },
  { value: 'cui:office', label: 'CUI: Office' },
  { value: 'cui:local', label: 'CUI: Local' },
  { value: 'chat:rafael', label: 'Chat: Rafael 🖼️' },
  { value: 'chat:engelmann', label: 'Chat: Engelmann 🖼️' },
  { value: 'chat:office', label: 'Chat: Office 🖼️' },
  { value: 'chat:local', label: 'Chat: Local 🖼️' },
  { value: 'images', label: 'Images' },
  { value: 'browser', label: 'Browser' },
  { value: 'preview', label: 'File Preview' },
  { value: 'notes', label: 'Notes' },
  { value: 'mission', label: 'Mission Control' },
  { value: 'office', label: 'Virtual Office 👥' },
  { value: 'admin-wr', label: 'Werking Report Admin' },
  { value: 'linkedin', label: 'LinkedIn Marketing 🔗' },
  { value: 'bridge-monitor', label: 'Bridge Monitor' },
];

const CELL_DEFAULTS = [
  'cui:rafael', 'cui:engelmann', 'preview', 'browser',
  'notes', 'cui:office', 'cui:local', 'browser',
  'preview', 'notes', 'cui:rafael', 'cui:engelmann',
  'browser', 'preview', 'notes', 'cui:office',
];

// --- Grid templates ---
interface LayoutTemplate {
  id: string;
  label: string;
  group: string;
  grid: string[][];
  cellCount: number;
  spec?: { rows: number; cols: number }; // regular grid → generic builder
}

const TEMPLATES: LayoutTemplate[] = [
  // --- Einfach ---
  { id: 'single',    label: 'Single',    group: 'Einfach', grid: [['A']],                                    cellCount: 1,  spec: { rows: 1, cols: 1 } },
  { id: 'cols-2',    label: '1×2',       group: 'Einfach', grid: [['A', 'B']],                               cellCount: 2,  spec: { rows: 1, cols: 2 } },
  { id: 'rows-2',    label: '2×1',       group: 'Einfach', grid: [['A'], ['B']],                             cellCount: 2,  spec: { rows: 2, cols: 1 } },
  { id: 'grid-2x2',  label: '2×2',       group: 'Einfach', grid: [['A', 'B'], ['C', 'D']],                   cellCount: 4,  spec: { rows: 2, cols: 2 } },

  // --- Focus ---
  { id: 'focus-left',   label: 'Focus L',  group: 'Focus', grid: [['A', 'B'], ['A', 'C']],                    cellCount: 3 },
  { id: 'focus-right',  label: 'Focus R',  group: 'Focus', grid: [['A', 'B'], ['C', 'B']],                    cellCount: 3 },
  { id: 'focus-top',    label: 'Focus O',  group: 'Focus', grid: [['A', 'A'], ['B', 'C']],                    cellCount: 3 },
  { id: 'focus-bottom', label: 'Focus U',  group: 'Focus', grid: [['A', 'B'], ['C', 'C']],                    cellCount: 3 },
  { id: 'focus-1h3',    label: '1+3H',     group: 'Focus', grid: [['A', 'A', 'A'], ['B', 'C', 'D']],          cellCount: 4 },
  { id: 'focus-3h1',    label: '3H+1',     group: 'Focus', grid: [['A', 'B', 'C'], ['D', 'D', 'D']],          cellCount: 4 },
  { id: 'focus-1v3',    label: '1+3V',     group: 'Focus', grid: [['A', 'B'], ['A', 'C'], ['A', 'D']],        cellCount: 4 },
  { id: 'focus-3v1',    label: '3V+1',     group: 'Focus', grid: [['A', 'B'], ['C', 'B'], ['D', 'B']],        cellCount: 4 },

  // --- Mittel ---
  { id: 'cols-3',    label: '1×3',    group: 'Mittel', grid: [['A', 'B', 'C']],                                            cellCount: 3,  spec: { rows: 1, cols: 3 } },
  { id: 'rows-3',    label: '3×1',    group: 'Mittel', grid: [['A'], ['B'], ['C']],                                        cellCount: 3,  spec: { rows: 3, cols: 1 } },
  { id: 'grid-2x3',  label: '2×3',    group: 'Mittel', grid: [['A', 'B', 'C'], ['D', 'E', 'F']],                           cellCount: 6,  spec: { rows: 2, cols: 3 } },
  { id: 'grid-3x2',  label: '3×2',    group: 'Mittel', grid: [['A', 'B'], ['C', 'D'], ['E', 'F']],                         cellCount: 6,  spec: { rows: 3, cols: 2 } },
  { id: 'grid-3x3',  label: '3×3',    group: 'Mittel', grid: [['A', 'B', 'C'], ['D', 'E', 'F'], ['G', 'H', 'I']],          cellCount: 9,  spec: { rows: 3, cols: 3 } },

  // --- Gross ---
  { id: 'cols-4',    label: '1×4',    group: 'Gross', grid: [['A', 'B', 'C', 'D']],                                                                cellCount: 4,  spec: { rows: 1, cols: 4 } },
  { id: 'rows-4',    label: '4×1',    group: 'Gross', grid: [['A'], ['B'], ['C'], ['D']],                                                           cellCount: 4,  spec: { rows: 4, cols: 1 } },
  { id: 'grid-2x4',  label: '2×4',    group: 'Gross', grid: [['A', 'B', 'C', 'D'], ['E', 'F', 'G', 'H']],                                          cellCount: 8,  spec: { rows: 2, cols: 4 } },
  { id: 'grid-4x2',  label: '4×2',    group: 'Gross', grid: [['A', 'B'], ['C', 'D'], ['E', 'F'], ['G', 'H']],                                      cellCount: 8,  spec: { rows: 4, cols: 2 } },
  { id: 'grid-3x4',  label: '3×4',    group: 'Gross', grid: [['A', 'B', 'C', 'D'], ['E', 'F', 'G', 'H'], ['I', 'J', 'K', 'L']],                    cellCount: 12, spec: { rows: 3, cols: 4 } },
  { id: 'grid-4x3',  label: '4×3',    group: 'Gross', grid: [['A', 'B', 'C'], ['D', 'E', 'F'], ['G', 'H', 'I'], ['J', 'K', 'L']],                  cellCount: 12, spec: { rows: 4, cols: 3 } },
  { id: 'grid-4x4',  label: '4×4',    group: 'Gross', grid: [['A', 'B', 'C', 'D'], ['E', 'F', 'G', 'H'], ['I', 'J', 'K', 'L'], ['M', 'N', 'O', 'P']], cellCount: 16, spec: { rows: 4, cols: 4 } },
];

const GROUPS = ['Einfach', 'Focus', 'Mittel', 'Gross'];

// --- Build flexlayout-react IJsonModel from template + panel configs ---

interface PanelConfig {
  component: string;
  name: string;
  config: Record<string, string>;
}

function panelFromValue(value: string, workDir: string): PanelConfig {
  if (value.startsWith('cui:')) {
    const accountId = value.split(':')[1];
    return { component: 'cui', name: accountId.charAt(0).toUpperCase() + accountId.slice(1), config: { accountId } };
  }
  if (value.startsWith('chat:')) {
    const accountId = value.split(':')[1];
    return { component: 'chat', name: `Chat: ${accountId.charAt(0).toUpperCase() + accountId.slice(1)}`, config: { accountId } };
  }
  switch (value) {
    case 'images':   return { component: 'images', name: 'Images', config: {} };
    case 'browser':  return { component: 'browser', name: 'Browser', config: { url: '' } };
    case 'preview':  return { component: 'preview', name: 'File Preview', config: { watchPath: workDir } };
    case 'notes':    return { component: 'notes', name: 'Notes', config: {} };
    case 'mission':  return { component: 'mission', name: 'Mission Control', config: {} };
    case 'office':   return { component: 'office', name: 'Virtual Office', config: {} };
    case 'admin-wr': return { component: 'admin-wr', name: 'Werking Report Admin', config: {} };
    case 'linkedin':        return { component: 'linkedin', name: 'LinkedIn Marketing 🔗', config: {} };
    case 'bridge-monitor': return { component: 'bridge-monitor', name: 'Bridge Monitor', config: {} };
    default:               throw new Error(`Unknown panel type: ${value}`);
  }
}

function makeTabset(panel: PanelConfig, weight: number) {
  return {
    type: 'tabset' as const,
    weight,
    children: [{
      type: 'tab' as const,
      name: panel.name,
      component: panel.component,
      config: panel.config,
    }],
  };
}

// Generic builder for regular NxM grids
function buildRegularGrid(rows: number, cols: number, panels: PanelConfig[]) {
  const ts = (i: number, w: number) => makeTabset(panels[i], w);
  const colW = Math.round(100 / cols);
  const rowW = Math.round(100 / rows);

  if (rows === 1 && cols === 1) {
    return { type: 'row', weight: 100, children: [ts(0, 100)] };
  }

  if (rows === 1) {
    return { type: 'row', weight: 100, children: Array.from({ length: cols }, (_, c) => ts(c, colW)) };
  }

  if (cols === 1) {
    return { type: 'row', weight: 100, children: [
      { type: 'row', weight: 100, children: Array.from({ length: rows }, (_, r) => ts(r, rowW)) },
    ]};
  }

  // NxM: root splits horizontal (columns), each column splits vertical (rows)
  // Cell at visual (row, col) has index: row * cols + col
  return { type: 'row', weight: 100, children: Array.from({ length: cols }, (_, c) => ({
    type: 'row' as const,
    weight: colW,
    children: Array.from({ length: rows }, (_, r) => ts(r * cols + c, rowW)),
  }))};
}

// Focus layout builder (non-regular grids with merged cells)
function buildFocusLayout(templateId: string, panels: PanelConfig[]) {
  const ts = (i: number, w: number) => makeTabset(panels[i], w);

  switch (templateId) {
    case 'focus-left': // A spans left, B top-right, C bottom-right
      return { type: 'row', weight: 100, children: [
        ts(0, 50),
        { type: 'row', weight: 50, children: [ts(1, 50), ts(2, 50)] },
      ]};

    case 'focus-right': // A top-left, C bottom-left, B spans right
      return { type: 'row', weight: 100, children: [
        { type: 'row', weight: 50, children: [ts(0, 50), ts(2, 50)] },
        ts(1, 50),
      ]};

    case 'focus-top': // A spans top, B bottom-left, C bottom-right
      return { type: 'row', weight: 100, children: [
        { type: 'row', weight: 100, children: [
          ts(0, 50),
          { type: 'row', weight: 50, children: [ts(1, 50), ts(2, 50)] },
        ]},
      ]};

    case 'focus-bottom': // A top-left, B top-right, C spans bottom
      return { type: 'row', weight: 100, children: [
        { type: 'row', weight: 100, children: [
          { type: 'row', weight: 50, children: [ts(0, 50), ts(1, 50)] },
          ts(2, 50),
        ]},
      ]};

    case 'focus-1h3': // A spans top, B/C/D bottom columns
      return { type: 'row', weight: 100, children: [
        { type: 'row', weight: 100, children: [
          ts(0, 50),
          { type: 'row', weight: 50, children: [ts(1, 33), ts(2, 34), ts(3, 33)] },
        ]},
      ]};

    case 'focus-3h1': // A/B/C top columns, D spans bottom
      return { type: 'row', weight: 100, children: [
        { type: 'row', weight: 100, children: [
          { type: 'row', weight: 50, children: [ts(0, 33), ts(1, 34), ts(2, 33)] },
          ts(3, 50),
        ]},
      ]};

    case 'focus-1v3': // A spans left, B/C/D stacked right
      return { type: 'row', weight: 100, children: [
        ts(0, 50),
        { type: 'row', weight: 50, children: [ts(1, 33), ts(2, 34), ts(3, 33)] },
      ]};

    case 'focus-3v1': // A/C/D stacked left, B spans right
      return { type: 'row', weight: 100, children: [
        { type: 'row', weight: 50, children: [ts(0, 33), ts(2, 34), ts(3, 33)] },
        ts(1, 50),
      ]};

    default:
      return { type: 'row', weight: 100, children: [ts(0, 100)] };
  }
}

function buildLayout(template: LayoutTemplate, panels: PanelConfig[]) {
  if (template.spec) {
    return buildRegularGrid(template.spec.rows, template.spec.cols, panels);
  }
  return buildFocusLayout(template.id, panels);
}

function buildFullModel(template: LayoutTemplate, panels: PanelConfig[]): IJsonModel {
  return {
    global: {
      tabEnableClose: true,
      tabEnablePopout: false,
      tabSetEnableMaximize: true,
      tabSetEnableDrop: true,
      tabSetEnableDrag: true,
      tabSetEnableDivide: true,
      splitterSize: 4,
      tabSetMinWidth: 100,
      tabSetMinHeight: 80,
    },
    borders: [],
    layout: buildLayout(template, panels),
  };
}

// --- Mini grid preview for template buttons ---
function MiniGrid({ grid, selected }: { grid: string[][]; selected: boolean }) {
  const seen = new Set<string>();
  const cells: JSX.Element[] = [];
  for (const row of grid) {
    for (const letter of row) {
      if (!seen.has(letter)) {
        seen.add(letter);
        cells.push(
          <div
            key={letter}
            style={{
              gridArea: letter,
              background: selected ? 'var(--tn-blue)' : 'var(--tn-text-muted)',
              opacity: selected ? 0.7 : 0.3,
              borderRadius: 1,
            }}
          />
        );
      }
    }
  }

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: `repeat(${grid[0].length}, 1fr)`,
      gridTemplateRows: `repeat(${grid.length}, 1fr)`,
      gridTemplateAreas: grid.map(row => `"${row.join(' ')}"`).join(' '),
      gap: 1,
      width: 32,
      height: 24,
    }}>
      {cells}
    </div>
  );
}

// --- Cell color by panel type ---
function cellColor(value: string): string {
  if (value.startsWith('cui:')) return 'var(--tn-blue)';
  switch (value) {
    case 'browser': return 'var(--tn-green)';
    case 'preview': return 'var(--tn-yellow)';
    case 'notes':   return 'var(--tn-purple)';
    case 'mission': return 'var(--tn-orange)';
    case 'office':  return 'var(--tn-blue)';
    default:        return 'var(--tn-text-muted)';
  }
}

// --- Main component ---
interface LayoutBuilderProps {
  workDir: string;
  onApply: (layout: IJsonModel) => void;
  onClose: () => void;
}

export default function LayoutBuilder({ workDir, onApply, onClose }: LayoutBuilderProps) {
  const [templateId, setTemplateId] = useState('grid-2x2');
  const [cells, setCells] = useState<string[]>(CELL_DEFAULTS.slice(0, 4));

  const template = TEMPLATES.find(t => t.id === templateId)!;

  const cellLetters = useMemo(() => {
    const letters: string[] = [];
    for (const row of template.grid) {
      for (const c of row) {
        if (!letters.includes(c)) letters.push(c);
      }
    }
    return letters;
  }, [template]);

  const handleTemplateSelect = useCallback((id: string) => {
    const t = TEMPLATES.find(t => t.id === id)!;
    setTemplateId(id);
    setCells(CELL_DEFAULTS.slice(0, t.cellCount));
  }, []);

  const handleCellChange = useCallback((index: number, value: string) => {
    setCells(prev => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
  }, []);

  const handleApply = useCallback(() => {
    const panels = cells.map(v => panelFromValue(v, workDir));
    const model = buildFullModel(template, panels);
    onApply(model);
  }, [cells, template, workDir, onApply]);

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        background: 'var(--tn-surface)',
        border: '1px solid var(--tn-border)',
        borderRadius: 8,
        padding: 20,
        width: 620,
        maxHeight: '90vh',
        overflow: 'auto',
        boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--tn-text)' }}>Layout Builder</span>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', color: 'var(--tn-text-muted)', cursor: 'pointer', fontSize: 16, padding: '2px 6px' }}
          >
            ✕
          </button>
        </div>

        {/* Template picker - grouped */}
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 11, color: 'var(--tn-text-muted)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>
            Grid Template
          </div>
          {GROUPS.map(group => (
            <div key={group} style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', marginBottom: 4, opacity: 0.6, textTransform: 'uppercase', letterSpacing: 1.5 }}>
                {group}
              </div>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {TEMPLATES.filter(t => t.group === group).map(t => {
                  const active = templateId === t.id;
                  return (
                    <button
                      key={t.id}
                      onClick={() => handleTemplateSelect(t.id)}
                      style={{
                        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
                        padding: '6px 5px', borderRadius: 5, cursor: 'pointer', minWidth: 48,
                        border: active ? '2px solid var(--tn-blue)' : '1px solid var(--tn-border)',
                        background: active ? 'var(--tn-bg-highlight)' : 'var(--tn-bg)',
                      }}
                    >
                      <MiniGrid grid={t.grid} selected={active} />
                      <span style={{ fontSize: 8, color: active ? 'var(--tn-blue)' : 'var(--tn-text-muted)', whiteSpace: 'nowrap' }}>
                        {t.label}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {/* Cell configurator */}
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 11, color: 'var(--tn-text-muted)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>
            Panels zuweisen ({template.cellCount} Zellen)
          </div>
          <div style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${template.grid[0].length}, 1fr)`,
            gridTemplateRows: `repeat(${template.grid.length}, minmax(56px, 1fr))`,
            gridTemplateAreas: template.grid.map(row => `"${row.join(' ')}"`).join(' '),
            gap: 4,
          }}>
            {cellLetters.map((letter, i) => (
              <div
                key={letter}
                style={{
                  gridArea: letter,
                  padding: '6px 8px',
                  background: 'var(--tn-bg)',
                  border: '1px solid var(--tn-border)',
                  borderRadius: 5,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 4,
                  borderLeft: `3px solid ${cellColor(cells[i] ?? CELL_DEFAULTS[i])}`,
                }}
              >
                <span style={{ fontSize: 10, color: 'var(--tn-text-muted)', fontWeight: 700 }}>{letter}</span>
                <select
                  value={cells[i] ?? CELL_DEFAULTS[i]}
                  onChange={(e) => handleCellChange(i, e.target.value)}
                  style={{
                    background: 'var(--tn-bg-dark)',
                    color: 'var(--tn-text)',
                    border: '1px solid var(--tn-border)',
                    borderRadius: 4,
                    padding: '3px 4px',
                    fontSize: 10,
                    width: '100%',
                    maxWidth: 130,
                    cursor: 'pointer',
                  }}
                >
                  <optgroup label="CUI">
                    {PANEL_OPTIONS.filter(o => o.value.startsWith('cui:')).map(o => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </optgroup>
                  <optgroup label="Tools">
                    {PANEL_OPTIONS.filter(o => !o.value.startsWith('cui:')).map(o => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </optgroup>
                </select>
              </div>
            ))}
          </div>
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            onClick={onClose}
            style={{
              padding: '6px 16px', borderRadius: 6, fontSize: 12, cursor: 'pointer',
              background: 'var(--tn-bg)', border: '1px solid var(--tn-border)', color: 'var(--tn-text-muted)',
            }}
          >
            Abbrechen
          </button>
          <button
            onClick={handleApply}
            style={{
              padding: '6px 20px', borderRadius: 6, fontSize: 12, cursor: 'pointer', fontWeight: 600,
              background: 'var(--tn-blue)', border: 'none', color: '#fff',
            }}
          >
            Layout anwenden
          </button>
        </div>
      </div>
    </div>
  );
}
