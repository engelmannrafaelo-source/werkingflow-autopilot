import { useState, useRef, useEffect, memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ContentBlock, Message } from './types';

// --- Markdown Components (Tokyo Night) ---
export const markdownComponents = {
  h1: ({ ...props }) => <h1 style={{ fontSize: '20px', fontWeight: '700', color: 'var(--tn-text)', marginTop: '16px', marginBottom: '8px' }} {...props} />,
  h2: ({ ...props }) => <h2 style={{ fontSize: '17px', fontWeight: '600', color: 'var(--tn-text)', marginTop: '12px', marginBottom: '6px' }} {...props} />,
  h3: ({ ...props }) => <h3 style={{ fontSize: '15px', fontWeight: '600', color: 'var(--tn-blue)', marginTop: '10px', marginBottom: '5px' }} {...props} />,
  p: ({ ...props }) => <p style={{ marginBottom: '8px', lineHeight: '1.6' }} {...props} />,
  ul: ({ ...props }) => <ul style={{ marginLeft: '16px', marginBottom: '8px', listStyleType: 'disc' }} {...props} />,
  ol: ({ ...props }) => <ol style={{ marginLeft: '16px', marginBottom: '8px' }} {...props} />,
  li: ({ ...props }) => <li style={{ marginBottom: '3px' }} {...props} />,
  code: ({ className, children, ...props }: any) => {
    const isBlock = !!className;
    if (!isBlock) {
      return <code style={{ background: 'var(--tn-bg-highlight)', padding: '2px 5px', borderRadius: '3px', fontSize: '13px', fontFamily: 'monospace', color: 'var(--tn-cyan)' }} {...props}>{children}</code>;
    }
    const lang = className?.replace('language-', '') || '';
    return (
      <div style={{ position: 'relative', marginBottom: '10px' }}>
        {lang && <span style={{ position: 'absolute', top: 4, right: 8, fontSize: '10px', color: 'var(--tn-text-muted)', textTransform: 'uppercase' }}>{lang}</span>}
        <code style={{ display: 'block', background: 'var(--tn-bg-dark)', padding: '12px', borderRadius: '6px', fontSize: '13px', fontFamily: 'monospace', overflow: 'auto', border: '1px solid var(--tn-border)', lineHeight: '1.5' }} {...props}>{children}</code>
      </div>
    );
  },
  pre: ({ children, ...props }: any) => <pre style={{ margin: 0 }} {...props}>{children}</pre>,
  table: ({ ...props }) => <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '12px', fontSize: '13px' }} {...props} />,
  thead: ({ ...props }) => <thead style={{ background: 'var(--tn-bg-highlight)' }} {...props} />,
  th: ({ ...props }) => <th style={{ padding: '8px 10px', textAlign: 'left' as const, fontWeight: '600', borderBottom: '1px solid var(--tn-border)' }} {...props} />,
  td: ({ ...props }) => <td style={{ padding: '6px 10px', borderBottom: '1px solid var(--tn-border)' }} {...props} />,
  blockquote: ({ ...props }) => <blockquote style={{ borderLeft: '3px solid var(--tn-blue)', paddingLeft: '12px', marginBottom: '8px', color: 'var(--tn-text-muted)', fontStyle: 'italic' }} {...props} />,
  a: ({ ...props }) => <a style={{ color: 'var(--tn-blue)', textDecoration: 'none' }} {...props} />,
  strong: ({ ...props }) => <strong style={{ fontWeight: '600', color: 'var(--tn-text)' }} {...props} />,
  hr: ({ ...props }) => <hr style={{ border: 'none', borderTop: '1px solid var(--tn-border)', margin: '12px 0' }} {...props} />,
};

// --- Tool Use Block (interactive) ---
export function ToolUseBlock({ block, onRespond, workDir, serverPlanText, sessionCwd }: { block: ContentBlock; onRespond?: (text: string) => void; workDir?: string; serverPlanText?: string; sessionCwd?: string }) {
  const [planText, setPlanText] = useState<string | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [responded, setResponded] = useState(false);

  // Load plan text: prefer server-provided, then inline input, then file fallback
  useEffect(() => {
    if (block.name !== 'ExitPlanMode' || planText !== null) return;
    if (serverPlanText && serverPlanText.trim()) {
      setPlanText(serverPlanText);
      return;
    }
    const inlinePlan = block.input?.plan as string | undefined;
    if (inlinePlan && inlinePlan.trim()) {
      setPlanText(inlinePlan);
      return;
    }
    const effectiveDir = sessionCwd || workDir;
    if (!effectiveDir) { setPlanText(''); return; }
    setPlanLoading(true);
    if ((window as any).__cuiServerAlive === false) { setPlanLoading(false); return; }
    fetch(`/api/file-read?path=${encodeURIComponent(effectiveDir + '/.claude/plan.md')}`, { signal: AbortSignal.timeout(5000) })
      .then(r => r.ok ? r.text() : Promise.reject('not found'))
      .then(text => setPlanText(text))
      .catch((err) => { if (err !== 'not found') console.warn('[CuiLite] Load plan error:', err); setPlanText(''); })
      .finally(() => setPlanLoading(false));
  }, [block.name, workDir, sessionCwd, serverPlanText, planText]);

  if (block.name === 'AskUserQuestion') {
    const questions = (block.input?.questions || []) as Array<{
      question: string;
      header?: string;
      options?: Array<{ label: string; description?: string }>;
      multiSelect?: boolean;
    }>;
    if (questions.length === 0) {
      const rawText = block.input ? JSON.stringify(block.input, null, 2) : 'Frage ohne Inhalt';
      return (
        <div style={{ margin: '8px 0', padding: '10px 14px', background: 'rgba(59,130,246,0.08)', borderRadius: 6, border: '1px solid rgba(59,130,246,0.2)' }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#3B82F6', marginBottom: 8 }}>Frage von Claude</div>
          <pre style={{ fontSize: 11, color: 'var(--tn-text)', whiteSpace: 'pre-wrap', marginBottom: 8, background: 'var(--tn-bg)', padding: 8, borderRadius: 4 }}>{rawText}</pre>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              type="text"
              placeholder="Antwort eingeben..."
              style={{ flex: 1, padding: '6px 10px', fontSize: 12, background: 'var(--tn-bg)', border: '1px solid var(--tn-border)', borderRadius: 4, color: 'var(--tn-text)' }}
              onKeyDown={(e) => { if (e.key === 'Enter') { onRespond?.((e.target as HTMLInputElement).value); } }}
            />
          </div>
        </div>
      );
    }
    return (
      <div style={{ margin: '8px 0', padding: '10px 14px', background: 'rgba(59,130,246,0.08)', borderRadius: 6, border: '1px solid rgba(59,130,246,0.2)' }}>
        {questions.map((q, qi) => (
          <div key={qi} style={{ marginBottom: qi < questions.length - 1 ? 12 : 0 }}>
            {q.header && <span style={{ fontSize: 10, fontWeight: 700, color: '#3B82F6', textTransform: 'uppercase', marginBottom: 4, display: 'block' }}>{q.header}</span>}
            <p style={{ fontSize: 13, color: 'var(--tn-text)', marginBottom: 8, fontWeight: 500 }}>{q.question}</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {q.options?.map((opt) => (
                <button
                  key={opt.label}
                  onClick={() => onRespond?.(opt.label)}
                  style={{
                    padding: '6px 14px', borderRadius: 4, cursor: 'pointer',
                    background: 'var(--tn-bg)', border: '1px solid var(--tn-border)',
                    color: 'var(--tn-text)', fontSize: 12, textAlign: 'left' as const,
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--tn-bg-highlight)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'var(--tn-bg)')}
                  title={opt.description}
                >
                  <strong>{opt.label}</strong>
                  {opt.description && <span style={{ display: 'block', fontSize: 11, color: 'var(--tn-text-muted)', marginTop: 2 }}>{opt.description}</span>}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (block.name === 'ExitPlanMode') {
    const allowedPrompts = block.input?.allowedPrompts as Array<{ tool: string; prompt: string }> | undefined;
    const handleClick = (text: string) => {
      if (responded) return;
      setResponded(true);
      onRespond?.(text);
    };

    return (
      <div style={{ margin: '8px 0', padding: '10px 14px', background: 'rgba(245,158,11,0.08)', borderRadius: 6, border: '1px solid rgba(245,158,11,0.2)' }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: '#F59E0B', marginBottom: 8 }}>
          Plan bereit zur Freigabe
        </div>
        {planLoading && <div style={{ fontSize: 11, color: 'var(--tn-text-muted)', marginBottom: 8 }}>Plan wird geladen...</div>}
        {planText && (
          <details style={{ marginBottom: 8 }} open>
            <summary style={{ fontSize: 11, color: '#F59E0B', cursor: 'pointer', marginBottom: 4 }}>
              Plan anzeigen ({planText.length > 1000 ? `${Math.round(planText.length / 1000)}k Zeichen` : `${planText.length} Zeichen`})
            </summary>
            <div style={{ padding: '8px 10px', borderRadius: 4, background: 'var(--tn-bg)', border: '1px solid var(--tn-border)', fontSize: 12, lineHeight: 1.6, maxHeight: 300, overflow: 'auto', color: 'var(--tn-text)' }}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{planText}</ReactMarkdown>
            </div>
          </details>
        )}
        {allowedPrompts && allowedPrompts.length > 0 && (
          <details style={{ marginBottom: 8 }}>
            <summary style={{ fontSize: 11, color: 'var(--tn-text-muted)', cursor: 'pointer', marginBottom: 4 }}>
              Berechtigungen ({allowedPrompts.length})
            </summary>
            <div style={{ padding: '6px 8px', borderRadius: 4, background: 'var(--tn-bg)', border: '1px solid var(--tn-border)', fontSize: 11, lineHeight: 1.5 }}>
              {allowedPrompts.map((p, i) => (
                <div key={i} style={{ color: 'var(--tn-text-muted)', marginBottom: 2 }}>
                  <span style={{ color: 'var(--tn-text)', fontWeight: 600 }}>{p.tool}</span>: {p.prompt}
                </div>
              ))}
            </div>
          </details>
        )}
        {responded ? (
          <div style={{ fontSize: 12, color: '#10B981', fontWeight: 600, padding: '6px 0' }}>
            Freigegeben — wird ausgefuehrt...
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={() => handleClick('yes')}
              style={{ padding: '6px 16px', borderRadius: 4, cursor: 'pointer', background: '#10B981', border: 'none', color: '#fff', fontSize: 12, fontWeight: 600 }}
            >
              Freigeben
            </button>
            <button
              onClick={() => handleClick('no, please revise the plan')}
              style={{ padding: '6px 16px', borderRadius: 4, cursor: 'pointer', background: '#EF4444', border: 'none', color: '#fff', fontSize: 12, fontWeight: 600 }}
            >
              Ablehnen
            </button>
          </div>
        )}
      </div>
    );
  }

  if (block.name === 'EnterPlanMode') {
    return (
      <div style={{ margin: '8px 0', padding: '10px 14px', background: 'rgba(245,158,11,0.08)', borderRadius: 6, border: '1px solid rgba(245,158,11,0.2)' }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: '#F59E0B', marginBottom: 8 }}>
          Claude moechte in den Plan-Modus wechseln
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={() => onRespond?.('yes')}
            style={{ padding: '6px 16px', borderRadius: 4, cursor: 'pointer', background: '#10B981', border: 'none', color: '#fff', fontSize: 12, fontWeight: 600 }}
          >
            OK
          </button>
          <button
            onClick={() => onRespond?.('no, skip planning')}
            style={{ padding: '6px 16px', borderRadius: 4, cursor: 'pointer', background: 'var(--tn-bg)', border: '1px solid var(--tn-border)', color: 'var(--tn-text)', fontSize: 12, fontWeight: 600 }}
          >
            Nein
          </button>
        </div>
      </div>
    );
  }

  // Other tool_use blocks - show tool name + key detail
  const toolName = block.name || 'tool';
  const inp = block.input || {};
  let detail = '';
  if (toolName === 'Bash' && inp.command) {
    detail = String(inp.command).length > 80 ? String(inp.command).slice(0, 77) + '...' : String(inp.command);
  } else if ((toolName === 'Read' || toolName === 'Write') && inp.file_path) {
    detail = String(inp.file_path).split('/').slice(-2).join('/');
  } else if (toolName === 'Edit' && inp.file_path) {
    detail = String(inp.file_path).split('/').slice(-2).join('/');
  } else if ((toolName === 'Grep' || toolName === 'Glob') && inp.pattern) {
    detail = String(inp.pattern).slice(0, 50);
  } else if (toolName === 'WebSearch' && inp.query) {
    detail = String(inp.query).slice(0, 60);
  } else if (toolName === 'WebFetch' && inp.url) {
    detail = String(inp.url).slice(0, 60);
  } else if (toolName === 'Task' && inp.description) {
    detail = String(inp.description).slice(0, 50);
  } else if (inp.description) {
    detail = String(inp.description).slice(0, 50);
  }
  return (
    <div style={{ margin: '4px 0', padding: '4px 8px', fontSize: 11, color: 'var(--tn-text-muted)', background: 'var(--tn-bg-highlight)', borderRadius: 3, display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: '100%' }}>
      <span style={{ fontWeight: 600, flexShrink: 0 }}>{toolName}</span>
      {detail && <span style={{ opacity: 0.7, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{detail}</span>}
    </div>
  );
}

// --- Message Row (memoized) ---
export const MessageRow = memo(function MessageRow({ msg, onRespond, isLast, workDir, selectedId, serverPlanText, sessionCwd }: { msg: Message; onRespond?: (text: string) => void; isLast: boolean; workDir?: string; selectedId?: string; serverPlanText?: string; sessionCwd?: string }) {
  const blocks: ContentBlock[] = typeof msg.content === 'string'
    ? [{ type: 'text', text: msg.content }]
    : Array.isArray(msg.content) ? msg.content : [];

  const textBlocks = blocks.filter(b => b.type === 'text');
  const toolUseBlocks = blocks.filter(b => b.type === 'tool_use');

  const interactiveToolNames = ['AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode'];
  const interactiveBlocks = (isLast && msg.role === 'assistant')
    ? toolUseBlocks.filter(b => interactiveToolNames.includes(b.name || ''))
    : [];
  const infoBlocks = (isLast && msg.role === 'assistant')
    ? toolUseBlocks.filter(b => !interactiveToolNames.includes(b.name || ''))
    : toolUseBlocks;

  const text = textBlocks.map(b => b.text || '').join('\n');
  if (!text.trim() && toolUseBlocks.length === 0) return null;

  if (msg.role === 'rate_limit' || msg.role === 'api_error') {
    const isRateLimit = msg.role === 'rate_limit';
    return (
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--tn-border)', background: isRateLimit ? 'rgba(239,68,68,0.08)' : 'rgba(245,158,11,0.08)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: isRateLimit ? '#EF4444' : '#F59E0B' }}>
            {isRateLimit ? 'Rate Limit' : 'API Fehler'}
          </span>
          {msg.timestamp && <span style={{ fontSize: 10, color: 'var(--tn-text-muted)' }}>{new Date(msg.timestamp).toLocaleTimeString()}</span>}
        </div>
        <div style={{ fontSize: 12, color: isRateLimit ? '#EF4444' : '#F59E0B', lineHeight: 1.5 }}>
          {typeof msg.content === 'string' ? msg.content : isRateLimit ? 'Nutzungslimit erreicht. Bitte anderen Account verwenden oder warten.' : 'API Fehler aufgetreten.'}
        </div>
      </div>
    );
  }

  const hasExitPlan = toolUseBlocks.some(b => b.name === 'ExitPlanMode');

  return (
    <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--tn-border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{
          fontSize: 11, fontWeight: 600, textTransform: 'uppercase',
          color: msg.role === 'assistant' ? 'var(--tn-green)' : msg.role === 'system' ? 'var(--tn-orange)' : 'var(--tn-blue)',
        }}>
          {msg.role === 'assistant' ? (selectedId === 'gemini' ? 'Gemini' : 'Claude') : msg.role === 'system' ? 'System' : 'User'}
        </span>
        {msg.timestamp && (
          <span style={{ fontSize: 10, color: 'var(--tn-text-muted)' }}>
            {new Date(msg.timestamp).toLocaleTimeString()}
          </span>
        )}
      </div>
      {text.trim() && (
        <div style={hasExitPlan ? {
          padding: '10px 14px',
          background: 'rgba(245,158,11,0.04)',
          borderRadius: 6,
          border: '1px solid rgba(245,158,11,0.1)',
          marginBottom: 8
        } : undefined}>
          {hasExitPlan && (
            <div style={{ fontSize: 10, fontWeight: 700, color: '#F59E0B', textTransform: 'uppercase', marginBottom: 6 }}>
              Plan
            </div>
          )}
          <div style={{ fontSize: 14, color: 'var(--tn-text-subtle)', lineHeight: '1.6' }}>
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
              {text}
            </ReactMarkdown>
          </div>
        </div>
      )}
      {infoBlocks.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
          {infoBlocks.map((block, i) => (
            <span key={i} style={{ padding: '2px 8px', fontSize: 10, color: 'var(--tn-text-muted)', background: 'var(--tn-bg-highlight)', borderRadius: 3 }}>
              {block.name || 'tool'}
            </span>
          ))}
        </div>
      )}
      {interactiveBlocks.map((block, i) => (
        <ToolUseBlock key={i} block={block} onRespond={onRespond} workDir={workDir} serverPlanText={serverPlanText} sessionCwd={sessionCwd} />
      ))}
    </div>
  );
});

// --- Loading state with timeout + retry ---
export function LoadingConversation({ sessionId, onBack, onRetry, onLoadFailed }: { sessionId: string | null; onBack: () => void; onRetry: () => void; onLoadFailed?: (sessionId: string) => void }) {
  const [elapsed, setElapsed] = useState(0);
  const failedRef = useRef(false);
  const retriedOnReconnectRef = useRef(false);
  useEffect(() => {
    const t = setInterval(() => {
      if ((window as any).__cuiServerAlive === false) return;
      setElapsed(s => s + 1);
    }, 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if ((window as any).__cuiServerAlive === true && !retriedOnReconnectRef.current && elapsed > 0) {
      retriedOnReconnectRef.current = true;
      onRetry();
    }
  });
  useEffect(() => {
    if (elapsed >= 20 && !failedRef.current && onLoadFailed && sessionId) {
      failedRef.current = true;
      onLoadFailed(sessionId);
    }
  }, [elapsed, onLoadFailed, sessionId]);
  const serverDown = (window as any).__cuiServerAlive === false;
  return (
    <div style={{ textAlign: 'center', color: 'var(--tn-text-muted)', marginTop: 40, fontSize: 13 }}>
      {serverDown ? (
        'Server startet neu...'
      ) : elapsed < 15 ? (
        'Lade Konversation...'
      ) : (
        <>
          <div>Konversation konnte nicht geladen werden.</div>
          <div style={{ marginTop: 12, display: 'flex', gap: 8, justifyContent: 'center' }}>
            <button onClick={() => { failedRef.current = false; setElapsed(0); retriedOnReconnectRef.current = false; onRetry(); }} style={{
              padding: '6px 16px', fontSize: 12, border: '1px solid var(--tn-border)',
              borderRadius: 4, background: 'var(--tn-surface)', color: 'var(--tn-text)', cursor: 'pointer',
            }}>Retry</button>
            <button onClick={onBack} style={{
              padding: '6px 16px', fontSize: 12, border: 'none',
              borderRadius: 4, background: 'var(--tn-blue, #3B82F6)', color: '#fff', cursor: 'pointer',
            }}>Zurueck</button>
          </div>
          {sessionId && <div style={{ marginTop: 8, fontSize: 10, opacity: 0.5, fontFamily: 'monospace' }}>{sessionId.slice(0, 12)}...</div>}
        </>
      )}
    </div>
  );
}

// --- Chat Messages Container ---
interface ChatMessagesProps {
  messages: Message[];
  showAllMessages: boolean;
  onShowAll: () => void;
  onRespond: (text: string) => void;
  workDir?: string;
  selectedId: string;
  sessionId: string | null;
  onBack: () => void;
  onRetry: () => void;
  onLoadFailed?: (sessionId: string) => void;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
  userScrolledUpRef: React.MutableRefObject<boolean>;
  serverPlanText?: string;
  sessionCwd?: string;
}

export default function ChatMessages({
  messages, showAllMessages, onShowAll, onRespond,
  workDir, selectedId, sessionId, onBack, onRetry, onLoadFailed,
  scrollContainerRef, messagesEndRef, userScrolledUpRef,
  serverPlanText, sessionCwd,
}: ChatMessagesProps) {
  return (
    <div
      ref={scrollContainerRef}
      onScroll={() => {
        const el = scrollContainerRef.current;
        if (!el) return;
        userScrolledUpRef.current = el.scrollTop + el.clientHeight < el.scrollHeight - 150;
      }}
      style={{ flex: 1, overflow: 'auto', minHeight: 0 }}
    >
      {messages.length === 0 && (
        <LoadingConversation sessionId={sessionId} onBack={onBack} onRetry={onRetry} onLoadFailed={onLoadFailed} />
      )}
      {messages.length > 15 && !showAllMessages && (
        <button onClick={onShowAll} style={{
          display: 'block', width: '100%', padding: '8px', background: 'var(--tn-bg-highlight)',
          border: 'none', color: 'var(--tn-blue)', cursor: 'pointer', fontSize: 11,
        }}>
          {messages.length - 15} aeltere Nachrichten laden...
        </button>
      )}
      {(showAllMessages ? messages : messages.slice(-15)).map((msg, i, arr) => (
        <MessageRow key={msg.timestamp || i} msg={msg} onRespond={onRespond} isLast={i === arr.length - 1} workDir={workDir} selectedId={selectedId} serverPlanText={serverPlanText} sessionCwd={sessionCwd} />
      ))}
      <div ref={messagesEndRef} />
    </div>
  );
}
