import React, { useState, useEffect, useCallback } from 'react';
import type { JourneyData, Journey, JourneyStep } from '../types';
import { resilientFetch } from '../../../../utils/resilientFetch';

export default function JourneyTab() {
  const [data, setData] = useState<JourneyData | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedJourney, setSelectedJourney] = useState<Journey | null>(null);

  const fetchData = useCallback(async () => {
    if ((window as any).__cuiServerAlive === false) return;
    try {
      const res = await resilientFetch('/api/qa/journey?latest=true');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
      // Auto-select first journey if none selected
      if (!selectedJourney && json.journeys?.length > 0) {
        setSelectedJourney(json.journeys[0]);
      }
    } catch (err) {
      console.warn('[QAJourney] fetch failed:', err);
    } finally {
      setLoading(false);
    }
  }, [selectedJourney]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (loading) {
    return (
      <div style={{ padding: 20, textAlign: 'center', color: 'var(--tn-text-muted)' }}>
        Loading journeys...
      </div>
    );
  }

  const journeys = data?.journeys ?? [];

  if (journeys.length === 0) {
    return (
      <div style={{ padding: 24, textAlign: 'center', color: 'var(--tn-text-muted)', fontSize: 12 }}>
        <div style={{ fontSize: 24, marginBottom: 8, opacity: 0.4 }}>
          No journey logs found
        </div>
        <div>Journey logs are created automatically during Playwright tests (Layer 2+).</div>
        <div style={{ marginTop: 4, fontSize: 10 }}>
          Run a frontend/visual/hybrid test to generate screenshot timelines.
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Journey Selector */}
      <div style={{
        padding: '8px 12px',
        borderBottom: '1px solid var(--tn-border)',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexShrink: 0,
        background: 'rgba(30,45,74,0.3)',
      }}>
        <label style={{ fontSize: 10, fontWeight: 700, color: 'var(--tn-text-muted)', whiteSpace: 'nowrap' }}>
          JOURNEY:
        </label>
        <select
          value={selectedJourney?.fileName ?? ''}
          onChange={e => {
            const j = journeys.find(j => j.fileName === e.target.value) ?? null;
            setSelectedJourney(j);
          }}
          style={{
            flex: 1,
            background: 'var(--tn-bg-dark)',
            border: '1px solid var(--tn-border)',
            color: 'var(--tn-text)',
            borderRadius: 4,
            padding: '4px 8px',
            fontSize: 11,
            fontFamily: 'monospace',
          }}
        >
          {journeys.map(j => (
            <option key={j.fileName} value={j.fileName}>
              {j.scenario} — {j.persona} ({j.totalSteps} steps, {formatDuration(j.duration)}) — {formatDate(j.startedAt)}
            </option>
          ))}
        </select>
        <button
          onClick={() => { setLoading(true); fetchData(); }}
          style={{
            background: 'rgba(122,162,247,0.15)',
            border: '1px solid var(--tn-blue)',
            borderRadius: 4,
            padding: '4px 10px',
            fontSize: 10,
            color: 'var(--tn-blue)',
            cursor: 'pointer',
            fontWeight: 600,
          }}
        >
          Refresh
        </button>
      </div>

      {/* Journey Meta */}
      {selectedJourney && (
        <div style={{
          padding: '6px 12px',
          borderBottom: '1px solid var(--tn-border)',
          display: 'flex',
          gap: 16,
          fontSize: 10,
          color: 'var(--tn-text-muted)',
          flexShrink: 0,
        }}>
          <span><strong style={{ color: 'var(--tn-text)' }}>Scenario:</strong> {selectedJourney.scenario}</span>
          <span><strong style={{ color: 'var(--tn-text)' }}>Persona:</strong> {selectedJourney.persona}</span>
          <span><strong style={{ color: 'var(--tn-text)' }}>Duration:</strong> {formatDuration(selectedJourney.duration)}</span>
          <span><strong style={{ color: 'var(--tn-text)' }}>Steps:</strong> {selectedJourney.totalSteps}</span>
        </div>
      )}

      {/* Timeline */}
      <div style={{ flex: 1, overflow: 'auto', padding: '16px 20px' }}>
        {selectedJourney && (
          <div style={{ position: 'relative', paddingLeft: 24 }}>
            {/* Vertical line */}
            <div style={{
              position: 'absolute',
              left: 7,
              top: 0,
              bottom: 0,
              width: 2,
              background: 'var(--tn-border)',
            }} />

            {selectedJourney.steps.map((step, idx) => (
              <StepCard
                key={step.nr}
                step={step}
                isLast={idx === selectedJourney.steps.length - 1}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StepCard({ step, isLast }: { step: JourneyStep; isLast: boolean }) {
  const [imgSrc, setImgSrc] = useState<string | null>(null);
  const [imgLoading, setImgLoading] = useState(false);
  const [imgError, setImgError] = useState(false);

  // Lazy-load screenshot via file-preview API
  useEffect(() => {
    if (!step.screenshotExists) return;
    setImgLoading(true);
    setImgError(false);

    resilientFetch(`/api/qa/file-preview?path=${encodeURIComponent(step.screenshotPath)}`)
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(data => {
        if (data.type === 'image' && data.base64) {
          setImgSrc(`data:${data.mimeType ?? 'image/png'};base64,${data.base64}`);
        }
      })
      .catch(() => setImgError(true))
      .finally(() => setImgLoading(false));
  }, [step.screenshotPath, step.screenshotExists]);

  const actionColor = step.action === 'navigate' ? 'var(--tn-blue)'
    : step.action === 'click' ? 'var(--tn-green)'
    : 'var(--tn-text-muted)';

  const time = step.timestamp ? new Date(step.timestamp).toLocaleTimeString('de-DE', {
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }) : '';

  return (
    <div style={{ position: 'relative', marginBottom: isLast ? 0 : 20 }}>
      {/* Dot on timeline */}
      <div style={{
        position: 'absolute',
        left: -24,
        top: 4,
        width: 16,
        height: 16,
        borderRadius: '50%',
        background: actionColor,
        border: '2px solid var(--tn-bg-dark)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 8,
        color: '#fff',
        fontWeight: 700,
        zIndex: 1,
      }}>
        {step.nr}
      </div>

      {/* Card */}
      <div style={{
        background: 'var(--tn-bg-dark)',
        border: '1px solid var(--tn-border)',
        borderRadius: 8,
        overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          padding: '8px 12px',
          borderBottom: '1px solid var(--tn-border)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}>
          <span style={{
            fontSize: 8,
            fontWeight: 700,
            padding: '2px 6px',
            borderRadius: 3,
            background: `${actionColor}22`,
            color: actionColor,
            textTransform: 'uppercase',
            letterSpacing: 0.5,
          }}>
            {step.action}
          </span>
          <span style={{
            flex: 1,
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--tn-text)',
            fontFamily: 'monospace',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {step.command}
          </span>
          <span style={{ fontSize: 9, color: 'var(--tn-text-muted)', whiteSpace: 'nowrap' }}>
            {time}
          </span>
        </div>

        {/* URL */}
        {step.url && (
          <div style={{
            padding: '3px 12px',
            fontSize: 9,
            fontFamily: 'monospace',
            color: 'var(--tn-blue)',
            borderBottom: '1px solid var(--tn-border)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {step.url}
          </div>
        )}

        {/* AI Note */}
        {step.note && (
          <div style={{
            padding: '4px 12px',
            fontSize: 10,
            color: 'var(--tn-text-muted)',
            borderBottom: '1px solid var(--tn-border)',
            fontStyle: 'italic',
            lineHeight: 1.4,
            background: 'rgba(122,162,247,0.05)',
          }}>
            {step.note}
          </div>
        )}

        {/* Screenshot */}
        <div style={{ padding: 8 }}>
          {!step.screenshotExists && (
            <div style={{
              padding: 16,
              textAlign: 'center',
              color: 'var(--tn-text-muted)',
              fontSize: 10,
              background: 'rgba(30,45,74,0.3)',
              borderRadius: 4,
            }}>
              Screenshot not available
            </div>
          )}

          {step.screenshotExists && imgLoading && (
            <div style={{
              padding: 16,
              textAlign: 'center',
              color: 'var(--tn-text-muted)',
              fontSize: 10,
            }}>
              Loading screenshot...
            </div>
          )}

          {step.screenshotExists && imgError && (
            <div style={{
              padding: 16,
              textAlign: 'center',
              color: 'var(--tn-red)',
              fontSize: 10,
            }}>
              Failed to load screenshot
            </div>
          )}

          {imgSrc && (
            <img
              src={imgSrc}
              alt={`Step ${step.nr}`}
              style={{
                width: '100%',
                borderRadius: 4,
                border: '1px solid var(--tn-border)',
              }}
            />
          )}
        </div>
      </div>

      {/* Arrow down */}
      {!isLast && (
        <div style={{
          position: 'absolute',
          left: -20,
          bottom: -16,
          fontSize: 10,
          color: 'var(--tn-text-muted)',
        }}>
          v
        </div>
      )}
    </div>
  );
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s}s`;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('de-DE', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
    });
  } catch {
    return iso;
  }
}
