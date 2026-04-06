import { useState, useCallback } from 'react';
import type { QuickFilter } from '../engine/types';

interface FilterBarProps {
  quickFilters: QuickFilter[];
  activeFilter: string;
  onApplyFilter: (filter: string) => void;
  onReset: () => void;
  onUndo: () => void;
  canUndo: boolean;
}

const CRITERIA_OPTIONS = [
  { value: '', label: 'Freitext' },
  { value: 'id', label: 'ID' },
  { value: 'label', label: 'Label' },
  { value: 'class_name', label: 'Typ' },
  { value: 'figs', label: 'Viertel' },
];

export default function FilterBar({ quickFilters, activeFilter, onApplyFilter, onReset, onUndo, canUndo }: FilterBarProps) {
  const [inputValue, setInputValue] = useState('');
  const [criterion, setCriterion] = useState('');

  const handleApply = useCallback(() => {
    if (!inputValue.trim()) return;
    const filter = criterion ? `${criterion}=${inputValue.trim()}` : inputValue.trim();
    onApplyFilter(filter);
    setInputValue('');
  }, [inputValue, criterion, onApplyFilter]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleApply();
  }, [handleApply]);

  const btnStyle: React.CSSProperties = {
    padding: '4px 10px',
    borderRadius: 4,
    fontSize: 11,
    cursor: 'pointer',
    border: '1px solid var(--tn-border)',
    background: 'var(--tn-bg)',
    color: 'var(--tn-text-muted)',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 10px', borderBottom: '1px solid var(--tn-border)' }}>
      {/* Filter input row */}
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <select
          value={criterion}
          onChange={e => setCriterion(e.target.value)}
          style={{
            background: 'var(--tn-bg-dark)',
            color: 'var(--tn-text)',
            border: '1px solid var(--tn-border)',
            borderRadius: 4,
            padding: '4px 6px',
            fontSize: 11,
            width: 80,
          }}
        >
          {CRITERIA_OPTIONS.map(o => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>

        <input
          type="text"
          value={inputValue}
          onChange={e => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={criterion ? `${criterion}=...` : 'z.B. class_name=app AND figs=Industriegebiet'}
          style={{
            flex: 1,
            background: 'var(--tn-bg-dark)',
            color: 'var(--tn-text)',
            border: '1px solid var(--tn-border)',
            borderRadius: 4,
            padding: '4px 8px',
            fontSize: 11,
            outline: 'none',
          }}
        />

        <button onClick={handleApply} style={{ ...btnStyle, background: 'var(--tn-blue)', color: '#fff', border: 'none' }}>
          Filter
        </button>
        <button onClick={onUndo} disabled={!canUndo} style={{ ...btnStyle, opacity: canUndo ? 1 : 0.4 }}>
          Undo
        </button>
        <button onClick={onReset} style={btnStyle}>
          Reset
        </button>
      </div>

      {/* Quick filter chips */}
      {quickFilters.length > 0 && (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {quickFilters.map(qf => (
            <button
              key={qf.label}
              onClick={() => onApplyFilter(qf.filter)}
              style={{
                padding: '2px 8px',
                borderRadius: 10,
                fontSize: 10,
                cursor: 'pointer',
                border: activeFilter === qf.filter ? '1px solid var(--tn-blue)' : '1px solid var(--tn-border)',
                background: activeFilter === qf.filter ? 'var(--tn-blue)' : 'var(--tn-bg)',
                color: activeFilter === qf.filter ? '#fff' : 'var(--tn-text-muted)',
              }}
            >
              {qf.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
