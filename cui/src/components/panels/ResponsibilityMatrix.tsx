import { useState, useEffect } from 'react';

const API = '/api';

interface RACIEntry {
  task: string;
  owner: string;
  responsible: string[];
  approver: string[];
  consulted: string[];
}

export default function ResponsibilityMatrix() {
  const [matrix, setMatrix] = useState<RACIEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadMatrix();
  }, []);

  async function loadMatrix() {
    try {
      const res = await fetch(`${API}/agents/team/structure`);
      if (!res.ok) throw new Error('Failed to load matrix');
      const data = await res.json();
      setMatrix(data.raciMatrix || []);
    } catch (err) {
      console.error('Failed to load matrix:', err);
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: 300,
        color: 'var(--tn-text-muted)',
        fontSize: 12
      }}>
        Loading responsibility matrix...
      </div>
    );
  }

  return (
    <div style={{
      padding: 20,
      overflow: 'auto'
    }}>
      {/* Header with Tooltip */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        marginBottom: 12
      }}>
        <div style={{
          fontSize: 14,
          fontWeight: 600,
          color: 'var(--tn-text)'
        }}>
          📊 Responsibility Matrix (RACI)
        </div>
        <div
          title="RACI Matrix shows who is Responsible, Accountable, Consulted, and Informed for each task. Use this to understand team ownership and collaboration patterns."
          style={{
            fontSize: 11,
            color: 'var(--tn-text-muted)',
            cursor: 'help',
            padding: '2px 6px',
            background: 'var(--tn-surface-alt)',
            borderRadius: 4,
            fontWeight: 600
          }}
        >
          ℹ️ What is this?
        </div>
      </div>

      {/* Detailed Legend */}
      <div style={{
        padding: 12,
        background: 'var(--tn-surface-alt)',
        borderRadius: 8,
        marginBottom: 16
      }}>
        <div style={{
          fontSize: 11,
          fontWeight: 600,
          color: 'var(--tn-text)',
          marginBottom: 8
        }}>
          Legend:
        </div>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, 1fr)',
          gap: 8,
          fontSize: 10,
          color: 'var(--tn-text)'
        }}>
          <div>
            <span style={{ fontWeight: 600, color: 'var(--tn-blue)' }}>O = Owner</span>
            <div style={{ color: 'var(--tn-text-muted)', fontSize: 9 }}>
              Owns the outcome, makes final decisions
            </div>
          </div>
          <div>
            <span style={{ fontWeight: 600, color: 'var(--tn-green)' }}>R = Responsible</span>
            <div style={{ color: 'var(--tn-text-muted)', fontSize: 9 }}>
              Does the actual work
            </div>
          </div>
          <div>
            <span style={{ fontWeight: 600, color: 'var(--tn-orange)' }}>A = Approver</span>
            <div style={{ color: 'var(--tn-text-muted)', fontSize: 9 }}>
              Must approve before completion
            </div>
          </div>
          <div>
            <span style={{ fontWeight: 600, color: 'var(--tn-text-muted)' }}>C = Consulted</span>
            <div style={{ color: 'var(--tn-text-muted)', fontSize: 9 }}>
              Provides input and expertise
            </div>
          </div>
        </div>
      </div>

      <div style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12
      }}>
        {matrix.map((entry, index) => (
          <div
            key={index}
            style={{
              padding: 12,
              background: 'var(--tn-surface)',
              border: '1px solid var(--tn-border)',
              borderRadius: 8
            }}
          >
            {/* Task Name */}
            <div style={{
              fontSize: 12,
              fontWeight: 600,
              color: 'var(--tn-text)',
              marginBottom: 8
            }}>
              {entry.task}
            </div>

            {/* Roles */}
            <div style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 8,
              fontSize: 11
            }}>
              {/* Owner */}
              <div style={{
                padding: '4px 8px',
                background: 'rgba(0, 122, 255, 0.1)',
                color: 'var(--tn-blue)',
                borderRadius: 4,
                fontWeight: 600
              }}>
                O: {entry.owner}
              </div>

              {/* Responsible */}
              {entry.responsible.filter(r => r !== entry.owner).map(person => (
                <div
                  key={person}
                  style={{
                    padding: '4px 8px',
                    background: 'rgba(52, 199, 89, 0.1)',
                    color: 'var(--tn-green)',
                    borderRadius: 4
                  }}
                >
                  R: {person}
                </div>
              ))}

              {/* Approver */}
              {entry.approver.map(person => (
                <div
                  key={person}
                  style={{
                    padding: '4px 8px',
                    background: 'rgba(255, 149, 0, 0.1)',
                    color: 'var(--tn-orange)',
                    borderRadius: 4
                  }}
                >
                  A: {person}
                </div>
              ))}

              {/* Consulted */}
              {entry.consulted.map(person => (
                <div
                  key={person}
                  style={{
                    padding: '4px 8px',
                    background: 'var(--tn-surface-alt)',
                    color: 'var(--tn-text-muted)',
                    borderRadius: 4
                  }}
                >
                  C: {person}
                </div>
              ))}
            </div>
          </div>
        ))}

        {matrix.length === 0 && (
          <div style={{
            padding: 40,
            textAlign: 'center',
            color: 'var(--tn-text-muted)',
            fontSize: 12
          }}>
            No responsibilities defined yet
          </div>
        )}
      </div>
    </div>
  );
}
