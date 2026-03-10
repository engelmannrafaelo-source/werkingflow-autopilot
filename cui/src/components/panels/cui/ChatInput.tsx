import { useState, useEffect, useCallback } from 'react';
import type { PromptTemplate } from './types';

interface LoopConfig {
  intervalMin: number;
  setIntervalMin: (v: number) => void;
  message: string;
  setMessage: (v: string) => void;
  lastInjectTime: string | null;
  onSave: () => void;
}

interface ChatInputProps {
  input: string;
  setInput: (v: string) => void;
  onSend: (overrideMessage?: string) => void;
  isLoading: boolean;
  planMode: boolean;
  setPlanMode: (v: boolean) => void;
  loopEnabled: boolean;
  onToggleLoop: (enable: boolean) => void;
  loopConfig: LoopConfig;
  onStop: () => void;
  convStatus: 'ongoing' | 'completed';
  attention: 'idle' | 'working' | 'needs_attention';
  selectedId: string;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
}

export default function ChatInput({
  input, setInput, onSend, isLoading,
  planMode, setPlanMode, loopEnabled, onToggleLoop, loopConfig,
  onStop, convStatus, attention, selectedId, textareaRef,
}: ChatInputProps) {
  // --- Internal state: templates ---
  const [replyTemplates, setReplyTemplates] = useState<PromptTemplate[]>([]);
  const [showTemplateForm, setShowTemplateForm] = useState(false);
  const [newTplLabel, setNewTplLabel] = useState('');
  const [newTplMessage, setNewTplMessage] = useState('');
  const [editingTemplate, setEditingTemplate] = useState<PromptTemplate | null>(null);
  const [showLoopConfig, setShowLoopConfig] = useState(false);

  // Fetch templates on mount
  const loadTemplates = useCallback(() => {
    if ((window as any).__cuiServerAlive !== true) return;
    fetch('/api/prompt-templates', { signal: AbortSignal.timeout(10000) })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data) return;
        const reply = (data.templates || []).filter((t: PromptTemplate) => t.category === 'reply');
        reply.sort((a: PromptTemplate, b: PromptTemplate) => a.order - b.order);
        setReplyTemplates(reply);
      })
      .catch(() => {});
  }, []);

  useEffect(() => { loadTemplates(); }, [loadTemplates]);

  const handleSaveTemplate = useCallback(async () => {
    if (!newTplLabel.trim() || !newTplMessage.trim()) return;
    if ((window as any).__cuiServerAlive === false) return;
    try {
      if (editingTemplate) {
        const resp = await fetch(`/api/prompt-templates/${editingTemplate.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: newTplLabel, message: newTplMessage }),
          signal: AbortSignal.timeout(20000),
        });
        if (resp.ok) {
          const data = await resp.json().catch(() => null);
          if (data?.template) setReplyTemplates(prev => prev.map(t => t.id === data.template.id ? data.template : t));
        }
      } else {
        const resp = await fetch('/api/prompt-templates', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: newTplLabel, message: newTplMessage, category: 'reply' }),
          signal: AbortSignal.timeout(20000),
        });
        if (resp.ok) {
          const data = await resp.json().catch(() => null);
          if (data?.template) setReplyTemplates(prev => [...prev, data.template]);
        }
      }
    } catch (err) { console.warn('[ChatInput] Save template error:', (err as Error).message); }
    setShowTemplateForm(false);
    setEditingTemplate(null);
    setNewTplLabel('');
    setNewTplMessage('');
  }, [newTplLabel, newTplMessage, editingTemplate]);

  const handleDeleteTemplate = useCallback(async (id: string) => {
    if ((window as any).__cuiServerAlive === false) return;
    try {
      const resp = await fetch(`/api/prompt-templates/${id}`, { method: 'DELETE', signal: AbortSignal.timeout(20000) });
      if (resp.ok) setReplyTemplates(prev => prev.filter(t => t.id !== id));
    } catch (err) { console.warn('[ChatInput] Delete template error:', (err as Error).message); }
  }, []);

  return (
    <div style={{
      padding: '8px 12px', borderTop: '1px solid var(--tn-border)',
      background: 'var(--tn-bg-dark)', flexShrink: 0,
    }}>
      {/* Action Buttons Row */}
      <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 4 }}>
        <button
          onClick={() => setPlanMode(!planMode)}
          title={`Plan-Modus: ${selectedId === 'gemini' ? 'Gemini' : 'Claude'} plant zuerst`}
          style={{
            padding: '4px 8px', borderRadius: 4, cursor: 'pointer', flexShrink: 0,
            background: planMode ? 'rgba(245,158,11,0.15)' : 'var(--tn-bg)',
            border: `1px solid ${planMode ? '#F59E0B' : 'var(--tn-border)'}`,
            color: planMode ? '#F59E0B' : 'var(--tn-text-muted)',
            fontSize: 11, fontWeight: planMode ? 700 : 400,
          }}
        >
          Plan
        </button>
        <button
          onClick={() => { if (loopEnabled) { onToggleLoop(false); } else { setShowLoopConfig(!showLoopConfig); } }}
          title={loopEnabled ? "Loop stoppen" : "Auto-Inject Loop konfigurieren"}
          style={{
            padding: "4px 8px", borderRadius: 4, cursor: "pointer", flexShrink: 0,
            background: loopEnabled ? "rgba(16,185,129,0.15)" : "var(--tn-bg)",
            border: `1px solid ${loopEnabled ? "#10B981" : "var(--tn-border)"}`,
            color: loopEnabled ? "#10B981" : "var(--tn-text-muted)",
            fontSize: 11, fontWeight: loopEnabled ? 700 : 400,
          }}
        >
          {loopEnabled ? "Loop \u25CF" : "Loop"}
        </button>
        <button
          onClick={onStop}
          title="Konversation stoppen"
          style={{
            padding: '4px 8px', borderRadius: 4, fontSize: 11, cursor: 'pointer', flexShrink: 0,
            background: (convStatus === 'ongoing' || attention === 'working') ? '#EF4444' : 'var(--tn-bg)',
            border: `1px solid ${(convStatus === 'ongoing' || attention === 'working') ? '#EF4444' : 'var(--tn-border)'}`,
            color: (convStatus === 'ongoing' || attention === 'working') ? '#fff' : 'var(--tn-text-muted)',
            fontWeight: 600,
          }}
        >
          Stop
        </button>
        <button
          onClick={() => { setShowTemplateForm(true); setEditingTemplate(null); setNewTplLabel(''); setNewTplMessage(''); }}
          title="Neues Template erstellen"
          style={{ padding: '4px 8px', borderRadius: 4, fontSize: 11, cursor: 'pointer', background: 'transparent', border: '1px dashed var(--tn-border)', color: 'var(--tn-text-muted)', opacity: 0.6 }}
        >
          ...
        </button>
        {planMode && (
          <span style={{ fontSize: 10, color: '#F59E0B', fontWeight: 600, marginLeft: 4 }}>
            Plan-Modus
          </span>
        )}
      </div>

      {/* Loop Config Panel */}
      {showLoopConfig && (
        <div style={{ marginBottom: 4, padding: 6, background: "var(--tn-bg)", border: "1px solid #10B981", borderRadius: 4 }}>
          <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4 }}>
            <span style={{ fontSize: 10, color: "#10B981", fontWeight: 600 }}>Loop Config</span>
            <label style={{ fontSize: 10, color: "var(--tn-text-muted)" }}>Interval:</label>
            <select value={loopConfig.intervalMin} onChange={e => loopConfig.setIntervalMin(Number(e.target.value))} style={{ padding: "2px 4px", fontSize: 10, background: "var(--tn-bg-dark)", color: "var(--tn-text)", border: "1px solid var(--tn-border)", borderRadius: 3 }}>
              <option value={1}>1 min</option>
              <option value={2}>2 min</option>
              <option value={3}>3 min</option>
              <option value={5}>5 min</option>
              <option value={10}>10 min</option>
              <option value={15}>15 min</option>
            </select>
            <div style={{ flex: 1 }} />
            <button onClick={() => { onToggleLoop(true); setShowLoopConfig(false); }} style={{ padding: "3px 10px", borderRadius: 3, fontSize: 10, cursor: "pointer", background: "#10B981", border: "none", color: "#fff", fontWeight: 600 }}>Start</button>
            <button onClick={() => setShowLoopConfig(false)} style={{ padding: "3px 6px", borderRadius: 3, fontSize: 10, cursor: "pointer", background: "transparent", border: "1px solid var(--tn-border)", color: "var(--tn-text-muted)" }}>X</button>
          </div>
          <textarea value={loopConfig.message} onChange={e => loopConfig.setMessage(e.target.value)} placeholder="Auto-Inject Nachricht..." rows={2} style={{ width: "100%", padding: "4px 6px", fontSize: 10, background: "var(--tn-bg-dark)", color: "var(--tn-text)", border: "1px solid var(--tn-border)", borderRadius: 3, fontFamily: "inherit", resize: "vertical", minHeight: 36, boxSizing: "border-box", lineHeight: "1.3" }} />
          {loopConfig.lastInjectTime && <div style={{ fontSize: 9, color: "var(--tn-text-muted)", marginTop: 2 }}>Letzter Inject: {new Date(loopConfig.lastInjectTime).toLocaleTimeString("de-DE")}</div>}
        </div>
      )}

      {/* Prompt Template Cards */}
      {replyTemplates.length > 0 && !showTemplateForm && (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 4, maxHeight: 80, overflowY: 'auto' }}>
          {replyTemplates.map(tpl => (
            <div key={tpl.id} style={{ display: 'flex', alignItems: 'stretch', borderRadius: 4, border: '1px solid var(--tn-border)', overflow: 'hidden', maxWidth: '48%' }}>
              <button
                onClick={() => onSend(tpl.message)}
                title={tpl.message}
                style={{ padding: '4px 8px', fontSize: 10, cursor: 'pointer', background: 'var(--tn-bg)', border: 'none', color: 'var(--tn-text)', textAlign: 'left', fontFamily: 'inherit', lineHeight: '1.3', flex: 1, minWidth: 0 }}
              >
                <div style={{ fontWeight: 600, color: 'var(--tn-text)', marginBottom: 1 }}>{tpl.label}</div>
                <div style={{ color: 'var(--tn-text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 180 }}>{tpl.message.slice(0, 60)}{tpl.message.length > 60 ? '...' : ''}</div>
              </button>
              <button
                onClick={() => { setEditingTemplate(tpl); setNewTplLabel(tpl.label); setNewTplMessage(tpl.message); setShowTemplateForm(true); }}
                title="Bearbeiten"
                style={{ padding: '2px 5px', fontSize: 9, cursor: 'pointer', background: 'var(--tn-bg-dark)', border: 'none', borderLeft: '1px solid var(--tn-border)', color: 'var(--tn-text-muted)', fontFamily: 'inherit', flexShrink: 0, display: 'flex', alignItems: 'center' }}
              >
                &#9998;
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Template Form */}
      {showTemplateForm && (
        <div style={{ marginBottom: 4, padding: 6, background: 'var(--tn-bg)', border: '1px solid var(--tn-blue)', borderRadius: 4 }}>
          <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
            <input value={newTplLabel} onChange={e => setNewTplLabel(e.target.value)} placeholder="Label (kurz)" style={{ width: 100, padding: '4px 6px', fontSize: 11, background: 'var(--tn-bg-dark)', color: 'var(--tn-text)', border: '1px solid var(--tn-border)', borderRadius: 3, fontFamily: 'inherit' }} />
            <div style={{ flex: 1 }} />
            <button onClick={handleSaveTemplate} disabled={!newTplLabel.trim() || !newTplMessage.trim()} style={{ padding: '4px 10px', borderRadius: 3, fontSize: 11, cursor: 'pointer', background: newTplLabel.trim() && newTplMessage.trim() ? 'var(--tn-blue)' : 'var(--tn-border)', border: 'none', color: '#fff', fontWeight: 600 }}>{editingTemplate ? 'Update' : 'Speichern'}</button>
            {editingTemplate && <button onClick={() => { if (confirm(`"${editingTemplate.label}" loeschen?`)) { handleDeleteTemplate(editingTemplate.id); setShowTemplateForm(false); setEditingTemplate(null); } }} style={{ padding: '4px 8px', borderRadius: 3, fontSize: 11, cursor: 'pointer', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#EF4444', fontWeight: 600 }}>Loeschen</button>}
            <button onClick={() => { setShowTemplateForm(false); setEditingTemplate(null); }} style={{ padding: '4px 8px', borderRadius: 3, fontSize: 11, cursor: 'pointer', background: 'transparent', border: '1px solid var(--tn-border)', color: 'var(--tn-text-muted)' }}>X</button>
          </div>
          <textarea value={newTplMessage} onChange={e => setNewTplMessage(e.target.value)} placeholder="Prompt-Text eingeben..." rows={3} onKeyDown={e => { if (e.key === 'Escape') { setShowTemplateForm(false); setEditingTemplate(null); } }} style={{ width: '100%', padding: '4px 6px', fontSize: 11, background: 'var(--tn-bg-dark)', color: 'var(--tn-text)', border: '1px solid var(--tn-border)', borderRadius: 3, fontFamily: 'inherit', resize: 'vertical', minHeight: 50, boxSizing: 'border-box', lineHeight: '1.4' }} />
        </div>
      )}

      {/* Input Row - Textarea + Send */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}>
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
          placeholder={planMode ? 'Aufgabe beschreiben... (Plan-Modus)' : 'Nachricht... (Enter = Senden)'}
          rows={2}
          style={{
            flex: 1, resize: 'vertical', padding: '6px 10px', fontSize: 13,
            background: 'var(--tn-bg)', color: 'var(--tn-text)',
            border: `1px solid ${planMode ? '#F59E0B' : 'var(--tn-border)'}`, borderRadius: 4,
            fontFamily: 'inherit', maxHeight: 120, minHeight: 48,
          }}
        />
        <button
          onClick={() => onSend()}
          disabled={!input.trim() || isLoading}
          style={{
            padding: '6px 14px', borderRadius: 4, fontSize: 12, cursor: 'pointer',
            background: input.trim() && !isLoading ? (planMode ? '#F59E0B' : '#3B82F6') : 'var(--tn-border)',
            border: 'none', color: '#fff', fontWeight: 600,
            opacity: input.trim() && !isLoading ? 1 : 0.5,
            alignSelf: 'stretch',
          }}
        >
          {isLoading ? '...' : planMode ? 'Planen' : 'Senden'}
        </button>
      </div>
    </div>
  );
}
