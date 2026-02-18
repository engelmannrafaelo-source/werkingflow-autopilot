import { useState, useEffect, useRef } from 'react';
import type { DocumentEdit } from '../../../server/document-manager';

const API = '/api';

export default function ReviewQueue() {
  const [reviews, setReviews] = useState<DocumentEdit[]>([]);
  const [selectedReview, setSelectedReview] = useState<DocumentEdit | null>(null);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    loadReviews();
    connectWebSocket();

    return () => {
      wsRef.current?.close();
    };
  }, []);

  function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

    ws.onopen = () => {
      console.log('[ReviewQueue] WebSocket connected');
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === 'document-edit-pending') {
          setReviews(prev => [...prev, data.edit]);
        } else if (data.type === 'document-edit-approved' || data.type === 'document-edit-rejected') {
          loadReviews(); // Refresh list
          if (selectedReview?.id === data.edit.id) {
            setSelectedReview(null); // Close detail view
          }
        }
      } catch (err) {
        console.error('[ReviewQueue] WebSocket message error:', err);
      }
    };

    ws.onerror = (err) => {
      console.error('[ReviewQueue] WebSocket error:', err);
    };

    ws.onclose = () => {
      console.log('[ReviewQueue] WebSocket closed - reconnecting in 5s');
      setTimeout(connectWebSocket, 5000);
    };

    wsRef.current = ws;
  }

  async function loadReviews() {
    try {
      setLoading(true);
      const response = await fetch(`${API}/team/reviews`);
      if (!response.ok) throw new Error('Failed to load reviews');
      const data = await response.json();
      setReviews(data);
    } catch (err: any) {
      console.error('[ReviewQueue] Load error:', err);
    } finally {
      setLoading(false);
    }
  }

  async function approveReview(id: string) {
    if (!confirm('Approve this document edit? This will write the file and create a git commit.')) {
      return;
    }

    try {
      setProcessing(true);
      const response = await fetch(`${API}/team/reviews/${id}/approve`, {
        method: 'POST'
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to approve');
      }

      // Success - list will auto-update via WebSocket
      setSelectedReview(null);
    } catch (err: any) {
      console.error('[ReviewQueue] Approve error:', err);
      alert(`Error approving review: ${err.message}`);
    } finally {
      setProcessing(false);
    }
  }

  async function rejectReview(id: string) {
    if (!confirm('Reject this document edit? This cannot be undone.')) {
      return;
    }

    try {
      setProcessing(true);
      const response = await fetch(`${API}/team/reviews/${id}/reject`, {
        method: 'POST'
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to reject');
      }

      // Success - list will auto-update via WebSocket
      setSelectedReview(null);
    } catch (err: any) {
      console.error('[ReviewQueue] Reject error:', err);
      alert(`Error rejecting review: ${err.message}`);
    } finally {
      setProcessing(false);
    }
  }

  function getRelativePath(fullPath: string): string {
    return fullPath.replace('/root/projekte/werkingflow/business/', '');
  }

  if (loading) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        color: 'var(--tn-text-muted)',
        fontSize: 12,
      }}>
        Loading reviews...
      </div>
    );
  }

  return (
    <div style={{
      display: 'flex',
      height: '100%',
      background: 'var(--tn-bg)',
      overflow: 'hidden',
    }}>
      {/* Review List */}
      <div style={{
        width: '300px',
        borderRight: '1px solid var(--tn-border)',
        display: 'flex',
        flexDirection: 'column',
      }}>
        <div style={{
          padding: '0.75rem 1rem',
          background: 'var(--tn-bg-dark)',
          borderBottom: '1px solid var(--tn-border)',
        }}>
          <h3 style={{ margin: 0, fontSize: 14, color: 'var(--tn-text)' }}>
            Pending Reviews ({reviews.length})
          </h3>
        </div>

        <div style={{
          flex: 1,
          overflowY: 'auto',
          padding: '0.5rem',
        }}>
          {reviews.length === 0 ? (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              color: 'var(--tn-text-muted)',
              fontSize: 11,
              textAlign: 'center',
              padding: '1rem',
            }}>
              No pending reviews.<br />All changes have been processed.
            </div>
          ) : (
            reviews.map(review => (
              <div
                key={review.id}
                onClick={() => setSelectedReview(review)}
                style={{
                  padding: '0.75rem',
                  background: selectedReview?.id === review.id ? 'var(--tn-bg-highlight)' : 'var(--tn-surface)',
                  border: `1px solid ${selectedReview?.id === review.id ? 'var(--tn-blue)' : 'var(--tn-border)'}`,
                  borderRadius: 6,
                  marginBottom: '0.5rem',
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                }}
                onMouseEnter={(e) => {
                  if (selectedReview?.id !== review.id) {
                    e.currentTarget.style.borderColor = 'var(--tn-blue)';
                  }
                }}
                onMouseLeave={(e) => {
                  if (selectedReview?.id !== review.id) {
                    e.currentTarget.style.borderColor = 'var(--tn-border)';
                  }
                }}
              >
                <div style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: 'var(--tn-blue)',
                  marginBottom: '0.25rem',
                }}>
                  {review.personaId}
                </div>
                <div style={{
                  fontSize: 12,
                  color: 'var(--tn-text)',
                  marginBottom: '0.25rem',
                  fontFamily: "'JetBrains Mono', monospace",
                }}>
                  {getRelativePath(review.documentPath).split('/').pop()}
                </div>
                <div style={{
                  fontSize: 10,
                  color: 'var(--tn-text-muted)',
                  lineHeight: 1.4,
                }}>
                  {review.reason.slice(0, 60)}{review.reason.length > 60 ? '...' : ''}
                </div>
                <div style={{
                  fontSize: 9,
                  color: 'var(--tn-text-muted)',
                  marginTop: '0.5rem',
                }}>
                  {new Date(review.createdAt).toLocaleString()}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Detail View */}
      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}>
        {selectedReview ? (
          <>
            {/* Header */}
            <div style={{
              padding: '0.75rem 1rem',
              background: 'var(--tn-bg-dark)',
              borderBottom: '1px solid var(--tn-border)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}>
              <div>
                <h4 style={{ margin: 0, fontSize: 13, color: 'var(--tn-text)' }}>
                  {getRelativePath(selectedReview.documentPath)}
                </h4>
                <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginTop: '0.25rem' }}>
                  Proposed by <strong>{selectedReview.personaId}</strong> • {new Date(selectedReview.createdAt).toLocaleString()}
                </div>
              </div>
              <button
                onClick={() => setSelectedReview(null)}
                style={{
                  padding: '4px 8px',
                  background: 'transparent',
                  color: 'var(--tn-text-muted)',
                  border: '1px solid var(--tn-border)',
                  borderRadius: 4,
                  cursor: 'pointer',
                  fontSize: 12,
                }}
              >
                ✕
              </button>
            </div>

            {/* Reason */}
            <div style={{
              padding: '1rem',
              background: 'var(--tn-bg-highlight)',
              borderBottom: '1px solid var(--tn-border)',
            }}>
              <div style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginBottom: '0.25rem' }}>
                Reason:
              </div>
              <div style={{ fontSize: 12, color: 'var(--tn-text)', lineHeight: 1.6 }}>
                {selectedReview.reason}
              </div>
            </div>

            {/* Validation Warnings */}
            {selectedReview.validationWarnings && selectedReview.validationWarnings.length > 0 && (
              <div style={{
                padding: '0.75rem 1rem',
                background: 'rgba(245, 158, 11, 0.1)',
                borderBottom: '1px solid var(--tn-border)',
              }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: '#f59e0b', marginBottom: '0.5rem' }}>
                  ⚠️ Validation Warnings
                </div>
                {selectedReview.validationWarnings.map((warning, i) => (
                  <div key={i} style={{ fontSize: 11, color: '#f59e0b', marginBottom: '0.25rem' }}>
                    {warning}
                  </div>
                ))}
              </div>
            )}

            {/* Diff Viewer */}
            <div style={{
              flex: 1,
              overflowY: 'auto',
              padding: '1rem',
              background: 'var(--tn-bg)',
            }}>
              <div style={{
                fontSize: 10,
                color: 'var(--tn-text-muted)',
                marginBottom: '0.5rem',
                fontWeight: 600,
              }}>
                Diff Preview:
              </div>
              <pre style={{
                fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
                fontSize: 11,
                lineHeight: 1.6,
                color: 'var(--tn-text)',
                background: 'var(--tn-surface)',
                padding: '1rem',
                borderRadius: 6,
                border: '1px solid var(--tn-border)',
                overflow: 'auto',
                margin: 0,
                whiteSpace: 'pre-wrap',
                wordWrap: 'break-word',
              }}>
                {selectedReview.diff}
              </pre>
            </div>

            {/* Actions */}
            <div style={{
              padding: '1rem',
              background: 'var(--tn-bg-dark)',
              borderTop: '1px solid var(--tn-border)',
              display: 'flex',
              gap: '0.5rem',
              justifyContent: 'flex-end',
            }}>
              <button
                onClick={() => rejectReview(selectedReview.id)}
                disabled={processing}
                style={{
                  padding: '0.5rem 1rem',
                  background: 'var(--tn-red)',
                  color: 'white',
                  border: 'none',
                  borderRadius: 6,
                  cursor: processing ? 'not-allowed' : 'pointer',
                  fontSize: 12,
                  fontWeight: 600,
                  opacity: processing ? 0.5 : 1,
                }}
              >
                ❌ Reject
              </button>
              <button
                onClick={() => approveReview(selectedReview.id)}
                disabled={processing}
                style={{
                  padding: '0.5rem 1rem',
                  background: 'var(--tn-green)',
                  color: 'white',
                  border: 'none',
                  borderRadius: 6,
                  cursor: processing ? 'not-allowed' : 'pointer',
                  fontSize: 12,
                  fontWeight: 600,
                  opacity: processing ? 0.5 : 1,
                }}
              >
                ✅ Approve & Commit
              </button>
            </div>
          </>
        ) : (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            color: 'var(--tn-text-muted)',
            fontSize: 12,
          }}>
            Select a review from the list to view details
          </div>
        )}
      </div>
    </div>
  );
}
