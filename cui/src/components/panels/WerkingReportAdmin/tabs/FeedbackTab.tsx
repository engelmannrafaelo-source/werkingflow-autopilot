import { useState, useEffect, useCallback } from 'react';

interface Feedback {
  id: string;
  tenantId: string;
  userId: string;
  userEmail?: string;
  userName?: string;
  dataAiId: string;
  feedback: string;
  route: string;
  timestamp: string;
}

export default function FeedbackTab({ envMode }: { envMode?: string }) {
  const [feedbacks, setFeedbacks] = useState<Feedback[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const fetchFeedback = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/admin/wr/feedback');
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setFeedbacks(data.feedbacks || []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchFeedback();
  }, [fetchFeedback, envMode]);

  return (
    <div data-ai-id="wr-feedback-tab" style={{ padding: 12 }}>
      {/* Refresh Button */}
      <div data-ai-id="wr-feedback-header" style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <button
          data-ai-id="wr-feedback-refresh-btn"
          onClick={fetchFeedback}
          style={{
            padding: '3px 10px',
            borderRadius: 3,
            fontSize: 10,
            cursor: 'pointer',
            background: 'var(--tn-bg)',
            border: '1px solid var(--tn-border)',
            color: 'var(--tn-text-muted)',
          }}
        >
          Refresh
        </button>
      </div>

      {/* Error */}
      {error && (
        <div data-ai-id="wr-feedback-error" style={{
          padding: '4px 8px',
          fontSize: 11,
          color: 'var(--tn-red)',
          background: 'rgba(247,118,142,0.1)',
          borderRadius: 3,
          marginBottom: 8,
        }}>
          {error}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div data-ai-id="wr-feedback-loading" style={{
          padding: 20,
          textAlign: 'center',
          color: 'var(--tn-text-muted)',
          fontSize: 12,
        }}>
          Loading...
        </div>
      )}

      {/* Feedback List */}
      {!loading && feedbacks.length === 0 && (
        <div data-ai-id="wr-feedback-empty" style={{
          padding: 20,
          textAlign: 'center',
          color: 'var(--tn-text-muted)',
          fontSize: 11,
        }}>
          No feedback found
        </div>
      )}

      {!loading && feedbacks.length > 0 && (
        <div data-ai-id="wr-feedback-list">
          <div data-ai-id="wr-feedback-count" style={{
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--tn-text)',
            marginBottom: 8,
          }}>
            Beta Tester Feedback ({feedbacks.length} entries)
          </div>

          {/* Table Header */}
          <div data-ai-id="wr-feedback-table-header" style={{
            display: 'grid',
            gridTemplateColumns: '140px 120px 120px 120px 1fr',
            gap: 8,
            padding: '6px 10px',
            background: 'var(--tn-bg-dark)',
            borderRadius: 4,
            fontSize: 10,
            fontWeight: 600,
            color: 'var(--tn-text-muted)',
            marginBottom: 4,
          }}>
            <div>Timestamp</div>
            <div>User</div>
            <div>Element</div>
            <div>Page</div>
            <div>Feedback</div>
          </div>

          {/* Table Rows */}
          {feedbacks.map(fb => (
            <div
              key={fb.id}
              data-ai-id={`wr-feedback-row-${fb.id}`}
              style={{
                display: 'grid',
                gridTemplateColumns: '140px 120px 120px 120px 1fr',
                gap: 8,
                padding: '8px 10px',
                borderBottom: '1px solid var(--tn-border)',
                fontSize: 11,
                alignItems: 'start',
              }}
            >
              <div style={{ color: 'var(--tn-text-muted)', fontSize: 10 }}>
                {new Date(fb.timestamp).toLocaleString('de-DE', {
                  day: '2-digit',
                  month: '2-digit',
                  year: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </div>
              <div style={{ color: 'var(--tn-text-subtle)' }}>
                <div>{fb.userName || fb.userId}</div>
                {fb.userEmail && (
                  <div style={{ fontSize: 9, color: 'var(--tn-text-muted)' }}>{fb.userEmail}</div>
                )}
              </div>
              <div>
                <code style={{
                  fontSize: 9,
                  background: 'rgba(122,162,247,0.1)',
                  color: 'var(--tn-blue)',
                  padding: '2px 4px',
                  borderRadius: 2,
                }}>
                  {fb.dataAiId}
                </code>
              </div>
              <div style={{
                color: 'var(--tn-text-muted)',
                fontSize: 10,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {fb.route}
              </div>
              <div style={{ color: 'var(--tn-text)', lineHeight: 1.4 }}>
                {fb.feedback}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
