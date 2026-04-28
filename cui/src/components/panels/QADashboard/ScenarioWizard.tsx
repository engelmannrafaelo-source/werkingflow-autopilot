import React, { useState } from 'react';

interface PoScenario {
  id: string;
  system: string;
  name: string;
  description: string;
  tester: { perspektive: string; erfahrung: string };
  auftrag: string;
  ziele: string[];
  qualitaetsfrage: string;
}

interface Props {
  initialData: PoScenario | null;
  scopeApps: string[] | 'all';
  onClose: () => void;
  onSuccess: () => void;
}

interface FormData {
  system: string;
  name: string;
  description: string;
  perspektive: string;
  erfahrung: string;
  auftrag: string;
  ziele: string[];
  qualitaetsfrage: string;
}

const STEPS = [
  'Was soll getestet werden?',
  'Aus welcher Sicht?',
  'Was soll der Tester tun?',
  'Woran erkennst du Erfolg?',
];

export default function ScenarioWizard({ initialData, scopeApps, onClose, onSuccess }: Props) {
  const isEdit = initialData !== null;
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState<FormData>({
    system: initialData?.system ?? (scopeApps !== 'all' && scopeApps.length === 1 ? scopeApps[0] : ''),
    name: initialData?.name ?? '',
    description: initialData?.description ?? '',
    perspektive: initialData?.tester?.perspektive ?? '',
    erfahrung: initialData?.tester?.erfahrung ?? '',
    auftrag: initialData?.auftrag ?? '',
    ziele: initialData?.ziele ?? [''],
    qualitaetsfrage: initialData?.qualitaetsfrage ?? '',
  });

  function set(field: keyof FormData, value: string | string[]) {
    setForm(f => ({ ...f, [field]: value }));
    setError(null);
  }

  function validateStep(): string | null {
    if (step === 0) {
      if (!form.system) return 'Bitte App auswählen';
      if (!form.name.trim()) return 'Titel ist erforderlich';
      if (!form.description.trim()) return 'Kurzbeschreibung ist erforderlich';
    }
    if (step === 1) {
      if (!form.perspektive.trim()) return 'Persona-Name ist erforderlich';
    }
    if (step === 2) {
      if (!form.auftrag.trim()) return 'Auftrag ist erforderlich';
    }
    if (step === 3) {
      if (form.ziele.filter(z => z.trim()).length === 0) return 'Mindestens ein Ziel erforderlich';
      if (!form.qualitaetsfrage.trim()) return 'Qualitätsfrage ist erforderlich';
    }
    return null;
  }

  function next() {
    const err = validateStep();
    if (err) { setError(err); return; }
    setError(null);
    setStep(s => s + 1);
  }

  function back() {
    setError(null);
    setStep(s => s - 1);
  }

  async function save() {
    const err = validateStep();
    if (err) { setError(err); return; }

    setSaving(true);
    setError(null);

    const body = {
      system: form.system,
      name: form.name.trim(),
      description: form.description.trim(),
      tester: { perspektive: form.perspektive.trim(), erfahrung: form.erfahrung.trim() },
      auftrag: form.auftrag.trim(),
      ziele: form.ziele.filter(z => z.trim()),
      qualitaetsfrage: form.qualitaetsfrage.trim(),
    };

    try {
      let res: Response;
      if (isEdit && initialData) {
        res = await fetch(`/api/qa/po-scenarios/${initialData.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } else {
        res = await fetch('/api/qa/po-scenarios', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      }

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Server error' }));
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      onSuccess();
    } catch (e: any) {
      setError(e.message || 'Speichern fehlgeschlagen');
    } finally {
      setSaving(false);
    }
  }

  const appOptions = scopeApps === 'all'
    ? ['engelmann', 'werking-report', 'werking-energy', 'werking-safety', 'werking-noise', 'platform']
    : scopeApps;

  const locked = isEdit || (scopeApps !== 'all' && scopeApps.length === 1);

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      background: 'rgba(0,0,0,0.65)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        background: 'var(--tn-bg)',
        border: '1px solid var(--tn-border)',
        borderRadius: 12,
        width: 560,
        maxWidth: '95vw',
        maxHeight: '90vh',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--tn-border)', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--tn-text)' }}>
              {isEdit ? 'Test bearbeiten' : 'Neuer Test'}
            </div>
            <div style={{ fontSize: 11, color: 'var(--tn-text-muted)', marginTop: 2 }}>
              Schritt {step + 1} von {STEPS.length}: {STEPS[step]}
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--tn-text-muted)', cursor: 'pointer', fontSize: 18, padding: 4 }}>✕</button>
        </div>

        {/* Step indicator */}
        <div style={{ display: 'flex', padding: '8px 20px', gap: 4, borderBottom: '1px solid var(--tn-border)' }}>
          {STEPS.map((_, i) => (
            <div key={i} style={{
              flex: 1, height: 3, borderRadius: 2,
              background: i <= step ? 'var(--tn-blue)' : 'var(--tn-border)',
              transition: 'background 0.2s',
            }} />
          ))}
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
          {step === 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <Field label="App">
                <select
                  value={form.system}
                  disabled={locked}
                  onChange={e => set('system', e.target.value)}
                  style={selectStyle}
                >
                  <option value="">— App wählen —</option>
                  {appOptions.map(a => <option key={a} value={a}>{a}</option>)}
                </select>
              </Field>
              <Field label="Titel">
                <input
                  value={form.name}
                  onChange={e => set('name', e.target.value)}
                  placeholder="z.B. Login-Flow als Neukunde"
                  style={inputStyle}
                />
              </Field>
              <Field label="Kurzbeschreibung (1–2 Sätze)">
                <textarea
                  value={form.description}
                  onChange={e => set('description', e.target.value)}
                  rows={3}
                  placeholder="Was soll dieser Test prüfen?"
                  style={{ ...inputStyle, resize: 'vertical' }}
                />
              </Field>
            </div>
          )}

          {step === 1 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <Field label="Persona-Name / Rolle">
                <input
                  value={form.perspektive}
                  onChange={e => set('perspektive', e.target.value)}
                  placeholder="z.B. Max Müller - Neukunde ohne Vorkenntnisse"
                  style={inputStyle}
                />
              </Field>
              <Field label="Erfahrung / Hintergrund (optional)">
                <textarea
                  value={form.erfahrung}
                  onChange={e => set('erfahrung', e.target.value)}
                  rows={4}
                  placeholder="Was weiß diese Person? Wie technik-affin ist sie? Was sind ihre Erwartungen?"
                  style={{ ...inputStyle, resize: 'vertical' }}
                />
              </Field>
            </div>
          )}

          {step === 2 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <Field label="Auftrag — Was soll der Tester tun?">
                <textarea
                  value={form.auftrag}
                  onChange={e => set('auftrag', e.target.value)}
                  rows={8}
                  placeholder="Beschreibe Schritt für Schritt was der Tester durchführen soll. Je konkreter, desto besser."
                  style={{ ...inputStyle, resize: 'vertical', fontFamily: 'monospace', fontSize: 12 }}
                />
              </Field>
            </div>
          )}

          {step === 3 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <Field label="Ziele — Woran erkennst du Erfolg?">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {form.ziele.map((z, i) => (
                    <div key={i} style={{ display: 'flex', gap: 6 }}>
                      <input
                        value={z}
                        onChange={e => {
                          const updated = [...form.ziele];
                          updated[i] = e.target.value;
                          set('ziele', updated);
                        }}
                        placeholder={`Ziel ${i + 1}`}
                        style={{ ...inputStyle, flex: 1 }}
                      />
                      {form.ziele.length > 1 && (
                        <button
                          onClick={() => set('ziele', form.ziele.filter((_, j) => j !== i))}
                          style={{ background: 'none', border: '1px solid var(--tn-border)', borderRadius: 4, color: 'var(--tn-text-muted)', cursor: 'pointer', padding: '4px 8px', fontSize: 12 }}
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  ))}
                  <button
                    onClick={() => set('ziele', [...form.ziele, ''])}
                    style={{ background: 'none', border: '1px dashed var(--tn-border)', borderRadius: 4, color: 'var(--tn-blue)', cursor: 'pointer', padding: '6px', fontSize: 12 }}
                  >
                    + Ziel hinzufügen
                  </button>
                </div>
              </Field>
              <Field label="Qualitätsfrage">
                <input
                  value={form.qualitaetsfrage}
                  onChange={e => set('qualitaetsfrage', e.target.value)}
                  placeholder="z.B. Kann ein Neukunde ohne Hilfe innerhalb von 5 Min einen Bericht erstellen?"
                  style={inputStyle}
                />
              </Field>
            </div>
          )}

          {error && (
            <div style={{ marginTop: 12, padding: '8px 12px', borderRadius: 6, background: 'rgba(236, 72, 153, 0.1)', border: '1px solid var(--tn-red)', color: 'var(--tn-red)', fontSize: 12 }}>
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: '12px 20px', borderTop: '1px solid var(--tn-border)', display: 'flex', justifyContent: 'space-between', gap: 8 }}>
          <button
            onClick={back}
            disabled={step === 0}
            style={{ ...footerBtnStyle, opacity: step === 0 ? 0.3 : 1 }}
          >
            ← Zurück
          </button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={onClose} style={footerBtnStyle}>Abbrechen</button>
            {step < STEPS.length - 1 ? (
              <button onClick={next} style={{ ...footerBtnStyle, background: 'var(--tn-blue)', color: '#fff', border: 'none' }}>
                Weiter →
              </button>
            ) : (
              <button onClick={save} disabled={saving} style={{ ...footerBtnStyle, background: 'var(--tn-blue)', color: '#fff', border: 'none', opacity: saving ? 0.6 : 1 }}>
                {saving ? 'Speichern…' : isEdit ? 'Speichern' : 'Test erstellen'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--tn-text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
        {label}
      </div>
      {children}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  background: 'var(--tn-bg-dark)',
  border: '1px solid var(--tn-border)',
  borderRadius: 6,
  padding: '8px 10px',
  fontSize: 13,
  color: 'var(--tn-text)',
  outline: 'none',
  boxSizing: 'border-box',
};

const selectStyle: React.CSSProperties = {
  ...inputStyle,
  cursor: 'pointer',
};

const footerBtnStyle: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid var(--tn-border)',
  borderRadius: 6,
  padding: '7px 14px',
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--tn-text-muted)',
  cursor: 'pointer',
};
