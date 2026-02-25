import { useState, useEffect, useCallback } from 'react';

interface ConfigEntry {
  key: string;
  value: unknown;
  type?: string;
  description?: string;
  updatedAt?: string;
}

export default function ConfigTab({ envMode }: { envMode?: string }) {
  const [configs, setConfigs] = useState<ConfigEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/admin/wr/config');
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      // Normalize: could be { configs: [...] } or { key: value, ... } or [...]
      if (Array.isArray(data)) {
        setConfigs(data);
      } else if (data.configs && Array.isArray(data.configs)) {
        setConfigs(data.configs);
      } else {
        // Object form -> convert to array
        setConfigs(Object.entries(data).filter(([k]) => k !== 'error').map(([key, value]) => ({
          key,
          value,
        })));
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchConfig(); }, [fetchConfig, envMode]);

  const handleSave = async (key: string, value: string) => {
    setSaving(true);
    setError('');
    try {
      let parsed: unknown;
      try { parsed = JSON.parse(value); } catch { parsed = value; }
      const res = await fetch('/api/admin/wr/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value: parsed }),
      });
      if (!res.ok) throw new Error(await res.text());
      setEditingKey(null);
      await fetchConfig();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleAdd = async () => {
    if (!newKey.trim()) return;
    await handleSave(newKey.trim(), newValue);
    setNewKey('');
    setNewValue('');
    setShowAdd(false);
  };

  const inputStyle: React.CSSProperties = {
    padding: '5px 8px', borderRadius: 3, fontSize: 11, background: 'var(--tn-bg)',
    border: '1px solid var(--tn-border)', color: 'var(--tn-text)', outline: 'none', width: '100%',
  };

  const formatValue = (v: unknown) => {
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') return String(v);
    if (typeof v === 'string') return v;
    return JSON.stringify(v);
  };

  const valueColor = (v: unknown) => {
    if (typeof v === 'boolean') return v ? 'var(--tn-green)' : 'var(--tn-red)';
    if (typeof v === 'number') return 'var(--tn-orange)';
    return 'var(--tn-text)';
  };

  return (
    <div style={{ padding: 12 }}>
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, alignItems: 'center' }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--tn-text)', flex: 1 }}>Platform Configuration</span>
        <button onClick={() => setShowAdd(!showAdd)} style={{
          padding: '4px 12px', borderRadius: 3, fontSize: 10, fontWeight: 600, cursor: 'pointer',
          background: showAdd ? 'var(--tn-red)' : 'var(--tn-green)', border: 'none', color: '#fff',
        }}>
          {showAdd ? 'Cancel' : '+ Add Config'}
        </button>
        <button onClick={fetchConfig} style={{
          padding: '3px 10px', borderRadius: 3, fontSize: 10, cursor: 'pointer',
          background: 'var(--tn-bg)', border: '1px solid var(--tn-border)', color: 'var(--tn-text-muted)',
        }}>Refresh</button>
      </div>

      {error && <div style={{ padding: '4px 8px', fontSize: 11, color: 'var(--tn-red)', background: 'rgba(247,118,142,0.1)', borderRadius: 3, marginBottom: 8 }}>{error}</div>}

      {showAdd && (
        <div style={{
          background: 'var(--tn-bg-dark)', border: '1px solid var(--tn-green)', borderRadius: 6,
          padding: 12, marginBottom: 12,
        }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr auto', gap: 8, alignItems: 'end' }}>
            <div>
              <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', marginBottom: 3 }}>Key</div>
              <input value={newKey} onChange={e => setNewKey(e.target.value)} placeholder="config.key" style={inputStyle} />
            </div>
            <div>
              <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', marginBottom: 3 }}>Value (string or JSON)</div>
              <input value={newValue} onChange={e => setNewValue(e.target.value)} placeholder='true / 42 / "text" / {"obj": 1}' style={inputStyle} />
            </div>
            <button onClick={handleAdd} disabled={saving || !newKey.trim()} style={{
              padding: '5px 14px', borderRadius: 3, fontSize: 10, fontWeight: 600,
              cursor: saving ? 'not-allowed' : 'pointer',
              background: 'var(--tn-green)', border: 'none', color: '#fff', opacity: saving ? 0.5 : 1,
            }}>Save</button>
          </div>
        </div>
      )}

      {loading && <div style={{ padding: 20, textAlign: 'center', color: 'var(--tn-text-muted)', fontSize: 12 }}>Loading...</div>}

      {!loading && configs.length === 0 && (
        <div style={{ padding: 20, textAlign: 'center', color: 'var(--tn-text-muted)', fontSize: 11 }}>No configuration entries found</div>
      )}

      {!loading && configs.length > 0 && (
        <div>
          {configs.map(cfg => {
            const isEditing = editingKey === cfg.key;
            return (
              <div key={cfg.key} style={{
                padding: '10px 12px', borderBottom: '1px solid var(--tn-border)',
                background: isEditing ? 'rgba(122,162,247,0.05)' : 'transparent',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <code style={{
                    fontSize: 11, color: 'var(--tn-blue)', fontWeight: 600,
                    padding: '2px 6px', background: 'rgba(122,162,247,0.1)', borderRadius: 3,
                  }}>{cfg.key}</code>
                  {cfg.type && <span style={{ fontSize: 9, color: 'var(--tn-text-muted)' }}>({cfg.type})</span>}
                  <div style={{ flex: 1 }} />
                  {cfg.updatedAt && <span style={{ fontSize: 9, color: 'var(--tn-text-muted)' }}>{new Date(cfg.updatedAt).toLocaleDateString('de-DE')}</span>}
                  <button onClick={() => {
                    if (isEditing) { setEditingKey(null); } else { setEditingKey(cfg.key); setEditValue(formatValue(cfg.value)); }
                  }} style={{
                    padding: '2px 8px', borderRadius: 3, fontSize: 9, cursor: 'pointer',
                    background: isEditing ? 'var(--tn-red)' : 'rgba(122,162,247,0.15)',
                    border: 'none', color: isEditing ? '#fff' : 'var(--tn-blue)', fontWeight: 600,
                  }}>
                    {isEditing ? 'Cancel' : 'Edit'}
                  </button>
                </div>

                {cfg.description && (
                  <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', marginTop: 3 }}>{cfg.description}</div>
                )}

                {isEditing ? (
                  <div style={{ display: 'flex', gap: 6, marginTop: 6, alignItems: 'center' }}>
                    <input
                      value={editValue}
                      onChange={e => setEditValue(e.target.value)}
                      style={{ ...inputStyle, flex: 1 }}
                      onKeyDown={e => { if (e.key === 'Enter') handleSave(cfg.key, editValue); }}
                    />
                    <button onClick={() => handleSave(cfg.key, editValue)} disabled={saving} style={{
                      padding: '5px 12px', borderRadius: 3, fontSize: 10, fontWeight: 600,
                      cursor: saving ? 'not-allowed' : 'pointer',
                      background: 'var(--tn-green)', border: 'none', color: '#fff',
                    }}>{saving ? 'Saving...' : 'Save'}</button>
                  </div>
                ) : (
                  <div style={{ marginTop: 4 }}>
                    {typeof cfg.value === 'object' ? (
                      <pre style={{
                        margin: 0, fontSize: 10, color: 'var(--tn-text)', background: 'var(--tn-bg-dark)',
                        padding: '4px 8px', borderRadius: 3, overflow: 'auto', maxHeight: 100,
                      }}>{JSON.stringify(cfg.value, null, 2)}</pre>
                    ) : (
                      <span style={{ fontSize: 12, fontWeight: 600, color: valueColor(cfg.value) }}>
                        {formatValue(cfg.value)}
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
