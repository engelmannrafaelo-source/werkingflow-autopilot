import { useState, useRef, useEffect, useCallback, memo } from 'react';
import type React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ACCOUNTS } from '../../types';
import { useAuth } from '../../contexts/AuthContext';
import QueueOverlay from './QueueOverlay';
import { validateApiResponse } from '../../lib/validateApiResponse';

// --- Types ---
interface AgentSessionState {
  accountId?: string;
  state: 'idle' | 'working' | 'needs_attention';
  reason?: string;
}

const SWITCHABLE_ACCOUNTS = ACCOUNTS.filter(a => a.id !== 'local');

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
}

interface Message {
  role: 'user' | 'assistant' | 'system' | 'rate_limit' | 'api_error';
  content: string | ContentBlock[];
  timestamp?: string;
  _streaming?: boolean;
}

interface Permission {
  id: string;
  type: string;
  toolName?: string;
  title?: string;
  toolInput?: Record<string, unknown>;
}

interface CuiLitePanelProps {
  accountId?: string;
  projectId?: string;
  workDir?: string;
  panelId?: string;
  isTabVisible?: boolean;
  onRouteChange?: (route: string) => void;
  initialRoute?: string;
  initialSessionId?: string;
  onLoadFailed?: (sessionId: string) => void;
  onFinish?: (sessionId: string) => void;
  onStateChange?: (state: 'idle' | 'working' | 'needs_attention') => void;
  compactInputBar?: boolean;
}

// --- Markdown Components (Tokyo Night) ---
const markdownComponents = {
  h1: ({ ...props }) => <h1 style={{ fontSize: '20px', fontWeight: '700', color: 'var(--tn-text)', marginTop: '16px', marginBottom: '8px' }} {...props} />,
  h2: ({ ...props }) => <h2 style={{ fontSize: '17px', fontWeight: '600', color: 'var(--tn-text)', marginTop: '12px', marginBottom: '6px' }} {...props} />,
  h3: ({ ...props }) => <h3 style={{ fontSize: '15px', fontWeight: '600', color: 'var(--tn-blue)', marginTop: '10px', marginBottom: '5px' }} {...props} />,
  p: ({ ...props }) => <p style={{ marginBottom: '8px', lineHeight: '1.6' }} {...props} />,
  ul: ({ ...props }) => <ul style={{ marginLeft: '16px', marginBottom: '8px', listStyleType: 'disc' }} {...props} />,
  ol: ({ ...props }) => <ol style={{ marginLeft: '16px', marginBottom: '8px' }} {...props} />,
  li: ({ ...props }) => <li style={{ marginBottom: '3px' }} {...props} />,
  code: ({ className, children, ...props }: React.ComponentPropsWithoutRef<'code'>) => {
    // react-markdown v10: inline code has no className, block code gets className="language-xxx"
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
  pre: ({ children, ...props }: React.ComponentPropsWithoutRef<'pre'>) => <pre style={{ margin: 0 }} {...props}>{children}</pre>,
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
function ToolUseBlock({ block, onRespond, workDir, serverPlanText, sessionCwd }: { block: ContentBlock; onRespond?: (text: string) => void; workDir?: string; serverPlanText?: string; sessionCwd?: string }) {
  const [planText, setPlanText] = useState<string | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [responded, setResponded] = useState(false);

  // Load plan text: prefer server-provided, then inline input, then file fallback
  useEffect(() => {
    if (block.name !== 'ExitPlanMode' || planText !== null) return;
    // 1. Server already read the plan file for us
    if (serverPlanText && serverPlanText.trim()) {
      setPlanText(serverPlanText);
      return;
    }
    // 2. Plan content in tool_use input (future-proof)
    const inlinePlan = block.input?.plan as string | undefined;
    if (inlinePlan && inlinePlan.trim()) {
      setPlanText(inlinePlan);
      return;
    }
    // 3. Fallback: load from file using sessionCwd (actual session CWD) or workDir (project prop)
    const effectiveDir = sessionCwd || workDir;
    if (!effectiveDir) { setPlanText(''); return; }
    setPlanLoading(true);
    if (window.__cuiServerAlive === false) { setPlanLoading(false); return; }
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
    // Fallback: if questions array is empty/missing, show raw input as debug + text input
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
        {/* Plan text from .claude/plan.md */}
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
        {/* Permissions */}
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

// --- Message Row (memoized: prevents re-rendering 200+ ReactMarkdown instances on poll) ---
const MessageRow = memo(function MessageRow({ msg, onRespond, isLast, workDir, selectedId, serverPlanText, sessionCwd }: { msg: Message; onRespond?: (text: string) => void; isLast: boolean; workDir?: string; selectedId?: string; serverPlanText?: string; sessionCwd?: string }) {
  const blocks: ContentBlock[] = typeof msg.content === 'string'
    ? [{ type: 'text', text: msg.content }]
    : Array.isArray(msg.content) ? msg.content : [];

  const textBlocks = blocks.filter(b => b.type === 'text');
  const toolUseBlocks = blocks.filter(b => b.type === 'tool_use');

  // Only show interactive tool_use buttons on the last assistant message
  const interactiveToolNames = ['AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode'];
  const interactiveBlocks = (isLast && msg.role === 'assistant')
    ? toolUseBlocks.filter(b => interactiveToolNames.includes(b.name || ''))
    : [];
  const infoBlocks = (isLast && msg.role === 'assistant')
    ? toolUseBlocks.filter(b => !interactiveToolNames.includes(b.name || ''))
    : toolUseBlocks;

  const text = textBlocks.map(b => b.text || '').join('\n');
  if (!text.trim() && toolUseBlocks.length === 0) return null;

  // Streaming partial — render as plain text with pulsing cursor (no Markdown for perf)
  if (msg._streaming) {
    const streamText = typeof msg.content === 'string' ? msg.content : '';
    return (
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--tn-border)' }}>
        <pre style={{
          fontFamily: "'JetBrains Mono', monospace", fontSize: 12,
          color: 'var(--tn-text-subtle)', lineHeight: 1.6,
          whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0,
        }}>
          {streamText}
          <span style={{ animation: 'pulse 1s ease-in-out infinite', color: '#A855F7' }}>|</span>
        </pre>
      </div>
    );
  }

  // Rate limit and API error messages get special styling
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

  // Detect if message contains ExitPlanMode to style plan text
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
      {/* Non-interactive tool_use (past messages or non-interactive tools) */}
      {infoBlocks.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
          {infoBlocks.map((block, i) => (
            <span key={i} style={{ padding: '2px 8px', fontSize: 10, color: 'var(--tn-text-muted)', background: 'var(--tn-bg-highlight)', borderRadius: 3 }}>
              {block.name || 'tool'}
            </span>
          ))}
        </div>
      )}
      {/* Interactive tool_use blocks (last assistant message only) */}
      {interactiveBlocks.map((block, i) => (
        <ToolUseBlock key={i} block={block} onRespond={onRespond} workDir={workDir} serverPlanText={serverPlanText} sessionCwd={sessionCwd} />
      ))}
    </div>
  );
});

// --- Loading state with timeout + retry ---
// Only counts elapsed time when server is alive — pauses during server restarts
function LoadingConversation({ sessionId, onBack, onRetry, onLoadFailed }: { sessionId: string | null; onBack: () => void; onRetry: () => void; onLoadFailed?: (sessionId: string) => void }) {
  const [elapsed, setElapsed] = useState(0);
  const failedRef = useRef(false);
  const retriedOnReconnectRef = useRef(false);
  useEffect(() => {
    const t = setInterval(() => {
      // Pause timeout while server is down — session is likely fine, just can't reach it
      if (window.__cuiServerAlive === false) return;
      setElapsed(s => s + 1);
    }, 1000);
    return () => clearInterval(t);
  }, []);
  // Auto-retry when server comes back alive
  useEffect(() => {
    if (window.__cuiServerAlive === true && !retriedOnReconnectRef.current && elapsed > 0) {
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
  const serverDown = window.__cuiServerAlive === false;
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

// --- Main Component ---
export default function CuiLitePanel({ accountId, projectId, workDir, panelId, isTabVisible = true, onRouteChange, initialSessionId, onLoadFailed, onFinish, onStateChange }: CuiLitePanelProps) {
  const { user } = useAuth();
  const isAdvancedUser = !user || user.role === 'admin' || user.role === 'product-owner';
  const storageKey = `cui-lite-account-${panelId || projectId || 'default'}`;
  const persistSession = !initialSessionId; // Don't persist to localStorage for AllChats panels

  const getSessionKey = (acctId: string) => `cui-lite-session-${panelId || projectId || 'default'}-${acctId}`;

  // Resolve initial account: localStorage > prop > first account (user's switch must survive reload)
  const initialAccount = (() => { try { return localStorage.getItem(storageKey) || accountId || ACCOUNTS[0].id; } catch { return accountId || ACCOUNTS[0].id; } })(); // silent-ok: localStorage account read fails gracefully; defaults to prop value

  const [selectedId, setSelectedId] = useState(initialAccount);
  const [sessionId, setSessionId] = useState<string | null>(() => {
    if (initialSessionId) return initialSessionId;
    try { return localStorage.getItem(getSessionKey(initialAccount)); } catch { return null; }
  });
  const hadCachedMessagesRef = useRef(false);
  const [messages, setMessages] = useState<Message[]>(() => {
    if (initialSessionId || !sessionId) return [];
    try {
      const cached = localStorage.getItem(`cui-msgs-${sessionId}`);
      if (cached) { const parsed = JSON.parse(cached); if (parsed.length > 0) { hadCachedMessagesRef.current = true; return parsed; } }
    } catch {} // silent-ok: cached messages load failure; fresh poll renders messages
    return [];
  });
  const [isMountSyncing, setIsMountSyncing] = useState(() => hadCachedMessagesRef.current);
  const mountSyncDoneRef = useRef(false);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [convStatus, setConvStatus] = useState<'ongoing' | 'completed'>('completed');
  const [showQueue, setShowQueue] = useState(() => {
    if (initialSessionId) return false;
    return !localStorage.getItem(getSessionKey(initialAccount));
  });
  const [queueRefresh, setQueueRefresh] = useState(0);
  const [attention, setAttention] = useState<'idle' | 'working' | 'needs_attention'>('idle');
  const [attentionReason, setAttentionReason] = useState<string | undefined>();

  // Propagate attention state to parent (LayoutManager) for project-tab coloring
  useEffect(() => {
    onStateChange?.(attention);
  }, [attention, onStateChange]);

  const [currentTool, setCurrentTool] = useState<{ toolName: string; toolDetail?: string; startedAt: number } | null>(null);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [rateLimitMessage, setRateLimitMessage] = useState<string | null>(null);
  const [convName, setConvName] = useState('');
  const [sessionModel, setSessionModel] = useState('');
  const [isPaused, setIsPaused] = useState(false);
  const [manualFinished, setManualFinished] = useState(false);
  const [reviewState, setReviewState] = useState<'idle' | 'running' | 'done'>('idle');
  const [planMode, setPlanMode] = useState(false);
  const [liveMode, setLiveMode] = useState(false);
  const [isAgentDone, _setIsAgentDone] = useState(false);
  const isAgentDoneRef = useRef(false);
  const setIsAgentDone = useCallback((v: boolean) => { isAgentDoneRef.current = v; _setIsAgentDone(v); }, []);
  const [showAllMessages, setShowAllMessages] = useState(false);
  const [serverPlanText, setServerPlanText] = useState<string | undefined>();
  const [sessionCwd, setSessionCwd] = useState<string | undefined>();
  // Persistent system messages (errors, warnings) — survive poll overwrites
  const pendingSystemMsgsRef = useRef<Message[]>([]);

  // --- Prompt Templates ---
  interface PromptTemplate { id: string; label: string; message: string; category: "reply" | "start"; subject?: string; order: number; createdAt: string; }
  const [replyTemplates, setReplyTemplates] = useState<PromptTemplate[]>([]);
  const [showTemplateForm, setShowTemplateForm] = useState(false);
  const [newTplLabel, setNewTplLabel] = useState("");
  const [newTplMessage, setNewTplMessage] = useState("");
  const [editingTemplate, setEditingTemplate] = useState<PromptTemplate | null>(null);

  // --- Auto-Inject (Loop Mode) ---
  const LOOP_PRESETS: { label: string; message: string }[] = [
    {
      label: "Test-Pyramide (Fix-Loop)",
      message: "Weiter mit der Test-Pyramide (bottom-up: Layer 0 vor 1 vor 2 vor 3 vor 4). Fuehre IMMER eine konkrete Aktion aus — NIEMALS nur 'Idle' oder 'Warte' antworten. Ablauf: (1) Pruefe ob ein Test gerade laeuft → monitore bis Ergebnis da ist. (2) Test FAIL? → Lies den Report, finde den echten Bug im APP-Code, fixe ihn, git commit + push, teste erneut. (3) Layer komplett PASS? → Starte naechsten Layer. (4) Alles gruen? → Melde Erfolg mit Score-Zusammenfassung. VERBOTEN: Szenario-Dateien oder Tester-Code aendern. NUR App-Code fixen.",
    },
    {
      label: "Nur testen (kein Fix)",
      message: "Fuehre alle Tests dieser App durch (Unified Tester, bottom-up: Layer 0 vor 1 vor 2 vor 3 vor 4). Berichte die Ergebnisse pro Layer mit Score-Tabelle. Aendere KEINEN Code — nur testen und dokumentieren.",
    },
    {
      label: "Weiter arbeiten",
      message: "Fuehre den naechsten anstehenden Task aus. Antworte NIEMALS nur mit 'Idle' oder 'Warte' — fuehre IMMER eine konkrete Aktion aus. Wenn kein Task definiert: pruefe failing Tests und arbeite sie ab.",
    },
  ];
  const [loopEnabled, setLoopEnabled] = useState(false);
  const [loopIntervalMin, setLoopIntervalMin] = useState(5);
  const [loopMessage, setLoopMessage] = useState(LOOP_PRESETS[0].message);
  const [showLoopConfig, setShowLoopConfig] = useState(false);
  const [lastInjectTime, setLastInjectTime] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const userScrolledUpRef = useRef(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pasteZoneRef = useRef<HTMLDivElement>(null);
  const [pasteUploading, setPasteUploading] = useState(false);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollFailCountRef = useRef(0);
  const circuitOpenRef = useRef(false); // Circuit breaker: stops polling after persistent failures
  const panelWsRef = useRef<WebSocket | null>(null);
  const sessionIdRef = useRef<string | null>(sessionId);
  const selectedIdRef = useRef<string>(selectedId);
  // Track last poll data to skip redundant setState (avoids re-render + LCP shift)
  const lastPollHashRef = useRef('');
  const autoUnfinishedRef = useRef(false); // Track if we've already auto-unfinished for current session
  const manualFinishedRef = useRef(false); // Mirror for manualFinished state (accessible in callbacks)

  const account = ACCOUNTS.find(a => a.id === selectedId) || ACCOUNTS[0];
  const pollInterval = liveMode ? 3000 : 0; // STATIC=0 (no polling, WS only), LIVE=3s fallback

  // --- Polling (conversation only — states come via WebSocket) ---
  const pollNow = useCallback(async () => {
    if (!sessionId) return;
    // Skip if server is known to be down (WS disconnected)
    if (window.__cuiServerAlive !== true) return;
    // Skip if circuit breaker is open (persistent 502s for this conversation)
    if (circuitOpenRef.current) return;
    try {
      const convResp = await fetch(`/api/mission/conversation/${selectedId}/${sessionId}?tail=50`, { signal: AbortSignal.timeout(15000) });
      if (convResp.ok) {
        const data = await convResp.json().catch(() => null); // silent-ok: invalid JSON response logged as warn below; poll retries
        if (!data) { console.warn('[CuiLite] Poll: invalid JSON response'); return; }
        if (typeof data.manualFinished === 'boolean') { manualFinishedRef.current = data.manualFinished; setManualFinished(data.manualFinished); }
        const newMsgs: Message[] = data.messages || [];
        const newStatus = data.status === 'ongoing' ? 'ongoing' : 'completed';
        const newPerms: Permission[] = (data.permissions || []).map((item: unknown, i: number) =>
          validateApiResponse<Permission>(item, `/api/mission/conversation/permissions[${i}]`, {
            id: 'string',
            type: 'string',
          })
        );
        const newName = data.customName || data.summary || '';
        const newDone = !!data.isAgentDone;
        // Fast hash: skip redundant setState when nothing changed
        // Include content-length of last 3 messages to detect streaming appends within existing blocks
        const lastTs = newMsgs[newMsgs.length - 1]?.timestamp || '';
        const tailLens = newMsgs.slice(-3).map(m => (m.content || '').length).join(',');
        const hash = `${newMsgs.length}|${lastTs}|${newStatus}|${newPerms.length}|${newName}|${newDone}|${data.rateLimited || ''}|${tailLens}`;
        if (hash !== lastPollHashRef.current) {
          lastPollHashRef.current = hash;
          // Append any pending system messages (errors, warnings) that were added between polls
          const pending = pendingSystemMsgsRef.current;
          const merged = pending.length > 0 ? [...newMsgs, ...pending] : newMsgs;
          pendingSystemMsgsRef.current = []; // Clear after merge
          setMessages(merged);
          // Cache messages for instant load on next visit
          try { localStorage.setItem(`cui-msgs-${sessionId}`, JSON.stringify(newMsgs)); } catch {} // silent-ok: message cache write; localStorage may be disabled
          setConvStatus(newStatus as 'ongoing' | 'completed');
          setPermissions(newPerms);
          setConvName(newName);
          if (data.assignedModel) setSessionModel(data.assignedModel);
          if (typeof data.manualPaused === 'boolean') setIsPaused(data.manualPaused);
          setIsAgentDone(newDone);
          if (data.planText) setServerPlanText(data.planText);
          if (data.sessionCwd) setSessionCwd(data.sessionCwd);
          if (data.rateLimited) {
            setAttention('needs_attention');
            setAttentionReason('rate_limit');
          }
          // JSONL is source of truth: if agent is done or has pending permissions, override WS state
          if (newDone && !data.rateLimited) {
            setAttention(prev => prev === 'needs_attention' ? prev : 'idle');
            setAttentionReason(prev => prev === 'rate_limit' ? prev : 'done');
            setCurrentTool(null);
          } else if (newPerms.length > 0) {
            setAttention('needs_attention');
            setAttentionReason('permission');
          }
        }
        pollFailCountRef.current = 0;
        circuitOpenRef.current = false;
        if (!mountSyncDoneRef.current) { mountSyncDoneRef.current = true; setIsMountSyncing(false); }
      } else {
        // HTTP errors (502, 503, etc.) — count as failures
        pollFailCountRef.current++;
        if (pollFailCountRef.current === 1) {
          console.warn(`[CuiLite] Poll ${convResp.status} for ${selectedId}`);
        }
        // Circuit breaker: after 3 consecutive proxy errors, stop polling
        if (pollFailCountRef.current >= 3) {
          circuitOpenRef.current = true;
          console.warn(`[CuiLite] Circuit open for ${selectedId} after ${pollFailCountRef.current} failures — waiting for WS`);
        }
      }
    } catch (err) {
      pollFailCountRef.current++;
      // Silent: circuit breaker handles recovery, WS reconnect re-triggers polling
    }
  }, [sessionId, selectedId]);

  // Fetch states once on mount/account change (WS handles updates after that)
  useEffect(() => {
    if (window.__cuiServerAlive !== true) return;
    fetch('/api/mission/states', { signal: AbortSignal.timeout(10000) })
      .then(r => r.ok ? r.json() : null)
      .then((states: Record<string, AgentSessionState> | null) => {
        if (!states) return;
        // States are keyed by sessionId, not accountId — look up by current session or find by account
        const sid = sessionIdRef.current;
        const myState: AgentSessionState | undefined = sid ? states[sid]
          : Object.values(states).find((s) => s.accountId === selectedId && s.state === 'working');
        if (myState) {
          setAttention(myState.state || 'idle');
          setAttentionReason(myState.reason);
        }
      })
      .catch(() => { /* timeout expected on slow connections — WS will sync state */ });
  }, [selectedId]);

  // Adaptive polling with recursive setTimeout (interval adjusts to failure count)
  useEffect(() => {
    if (!sessionId || !isTabVisible) {
      if (!isTabVisible) { /* paused: tab not visible */ }
      return;
    }
    let cancelled = false;
    const schedulePoll = () => {
      if (cancelled) return;
      // Adaptive delay: backs off on failures, pauses when circuit is open
      const fails = pollFailCountRef.current;
      const delay = circuitOpenRef.current ? 0 // stop scheduling (WS will re-trigger)
        : pollInterval === 0 ? 0 // STATIC mode — no scheduled polling
        : fails >= 5 ? 60000 // 1 min after 5+ fails
        : fails >= 3 ? 30000 // 30s after 3 fails
        : pollInterval; // LIVE=3s fallback
      if (delay === 0) return; // circuit open — stop polling
      pollTimerRef.current = setTimeout(async () => {
        if (cancelled) return;
        await pollNow();
        schedulePoll();
      }, delay);
    };
    // Initial poll then start schedule
    pollNow().then(() => { if (!cancelled) schedulePoll(); }).catch((err) => { console.warn('[CuiLite] Initial poll error:', err); });
    return () => {
      cancelled = true;
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, [sessionId, selectedId, isTabVisible, pollNow, pollInterval]);

  // --- Fetch Prompt Templates (retry on failure — server may be restarting) ---
  const loadTemplates = useCallback(() => {
    fetch('/api/prompt-templates', { signal: AbortSignal.timeout(10000) })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data) return;
        const reply = (data.templates || []).filter((t: PromptTemplate) => t.category === 'reply');
        reply.sort((a: PromptTemplate, b: PromptTemplate) => a.order - b.order);
        setReplyTemplates(reply);
      })
      .catch(() => { /* timeout expected — templates load lazily on next attempt */ });
  }, []);
  useEffect(() => {
    if (window.__cuiServerAlive !== true) return;
    loadTemplates();
  }, [loadTemplates]);

  // Keep sessionIdRef in sync (avoids WS reconnection on every session change)
  useEffect(() => {
    sessionIdRef.current = sessionId;
    selectedIdRef.current = selectedId;
    autoUnfinishedRef.current = false; // Reset on session change so new session can be auto-unfinished
    manualFinishedRef.current = false;
    setManualFinished(false);
    // Report visibility change to server (session exclusivity)
    const ws = panelWsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'panel-visibility', panelId, projectId, accountId: selectedId, sessionId: sessionId || '', route: sessionId ? `/c/${sessionId}` : '' }));
    }
  }, [sessionId, selectedId, panelId, projectId]);

  // --- Notify server when tab becomes hidden (clear visibility immediately) ---
  useEffect(() => {
    if (!isTabVisible) {
      // Tab hidden — tell server to remove this panel from visibility registry
      fetch(`/api/mission/panel-removed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ panelId, projectId }),
      }).catch(() => {}); // silent-ok: panel-removed notification is best-effort
    }
  }, [isTabVisible, panelId, projectId]);

  // --- WS for realtime attention events (auto-reconnect) ---
  useEffect(() => {
    if (!isTabVisible) return;
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let backoff = 1000; // start at 1s, doubles up to 30s max

    const connect = () => {
      if (disposed) return;
      // Don't hammer WS when server is down — wait for App WS to restore __cuiServerAlive
      if (window.__cuiServerAlive === false) {
        reconnectTimer = setTimeout(connect, Math.min(backoff, 10000));
        return;
      }
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${protocol}://${window.location.host}/ws`);
      panelWsRef.current = ws;
      ws.onerror = () => {}; // Suppress console noise during server restarts

      ws.onopen = () => {
        backoff = 1000; // reset backoff on successful connection
        console.log('[CuiLite WS] Connected');
        // Server is back — reset circuit breaker and poll immediately
        circuitOpenRef.current = false;
        pollFailCountRef.current = 0;
        const sid = sessionIdRef.current;
        if (sid) setTimeout(pollNow, 300);
        // Re-fetch templates (may have failed during server restart)
        loadTemplates();
        // Report panel visibility to server (session exclusivity)
        ws.send(JSON.stringify({ type: 'panel-visibility', panelId, projectId, accountId: selectedId, sessionId: sid || '', route: sid ? `/c/${sid}` : '' }));
        // Re-sync state from server (handles server restarts where in-memory states are lost)
        if (sid) {
          fetch('/api/mission/states').then(r => r.ok ? r.json() : null).then(states => {
            if (!states || disposed) return;
            const serverState = states[sid];
            if (!serverState) {
              // Server doesn't know this session — stale state from before restart
              console.log(`[CuiLite WS] Session ${sid.slice(0, 8)} not in server states — resetting to idle`);
              setAttention('idle');
              setAttentionReason('done');
            } else if (serverState.state === 'working') {
              setAttention('working');
            } else if (serverState.state === 'needs_attention') {
              setAttention('needs_attention');
              setAttentionReason(serverState.reason);
            } else if (serverState.state === 'idle') {
              setAttention(prev => prev === 'needs_attention' ? prev : 'idle');
              setAttentionReason(serverState.reason || 'done');
            }
          }).catch(() => {}); // silent-ok: state re-sync on WS reconnect is non-critical; events will update state
        }
      };
      ws.onclose = () => {
        if (!disposed) {
          if (backoff <= 1000) console.log('[CuiLite WS] Disconnected, reconnecting...');
          reconnectTimer = setTimeout(() => {
            backoff = Math.min(backoff * 2, 30000);
            connect();
          }, backoff);
        }
      };

      ws.onmessage = (e) => {
        try {
          const raw = e.data as string;
          // Session exclusivity: check BEFORE accountId filter (message contains claiming panel's account, not ours)
          const currentSid = sessionIdRef.current;
          if (raw.includes('session-claimed') && currentSid) {
            const claimMsg = JSON.parse(raw);
            if (claimMsg.type === 'session-claimed' && claimMsg.evictPanelId === panelId && claimMsg.sessionId === currentSid) {
              console.log(`[CuiLite] Session ${currentSid.slice(0, 8)} claimed by ${claimMsg.claimedByPanelId} — closing chat`);
              setSessionId(null);
              setShowQueue(true);
              setMessages([]);
              setPermissions([]);
              setConvName('');
              setSessionModel('');
              setAttention('idle');
              setAttentionReason(undefined);
              setRateLimitMessage(null);
              setLiveMode(false);
              if (persistSession) try { localStorage.removeItem(getSessionKey(selectedId)); } catch {} // silent-ok: localStorage may be disabled
              onRouteChange?.('');
              return;
            }
          }
          // Navigate to conversation: handle before accountId filter (message may not contain our accountId)
          if (raw.includes('cui-navigate-conversation') && panelId) {
            const navMsg = JSON.parse(raw);
            if (navMsg.type === 'control:cui-navigate-conversation' && navMsg.panelId === panelId) {
              console.log(`[CuiLite] Navigate to session ${navMsg.sessionId?.slice(0, 8)} (panel=${panelId})`);
              setSessionId(navMsg.sessionId);
              setShowQueue(false);
              circuitOpenRef.current = false;
              pollFailCountRef.current = 0;
              setTimeout(pollNow, 300);
              return;
            }
          }
          // Handle account change from another panel (e.g. assign endpoint)
          if (raw.includes("conv-account-changed")) {
            const acMsg = JSON.parse(raw);
            if (acMsg.type === "conv-account-changed" && acMsg.sessionId === sessionIdRef.current && acMsg.accountId !== selectedIdRef.current) {
              console.log(`[CuiLite] Account changed externally: ${selectedIdRef.current} -> ${acMsg.accountId}`);
              setSelectedId(acMsg.accountId);
              try { localStorage.setItem(storageKey, acMsg.accountId); } catch {} // silent-ok: localStorage may be disabled
              setMessages(prev => [...prev, { role: "system", content: `Account gewechselt → ${acMsg.accountId}`, timestamp: new Date().toISOString() }]);
              return;
            }
          }
          // Allow messages for selected account OR for the current session (cross-account visibility)
          const currentSid2 = sessionIdRef.current;
          if (!raw.includes(selectedId) && !(currentSid2 && raw.includes(currentSid2))) return;
          const msg = JSON.parse(raw);
          if (msg.type === 'conv-review-started' && msg.sessionId === sessionIdRef.current) {
            setReviewState('running');
          } else if (msg.type === 'conv-review-complete' && msg.sessionId === sessionIdRef.current) {
            setReviewState('done');
            setTimeout(() => setReviewState('idle'), 8000);
          } else if (msg.type === 'conv-paused' && msg.sessionId === sessionIdRef.current) {
            setIsPaused(!!msg.paused);
          } else if (msg.type === 'conv-model-changed' && msg.sessionId === sessionIdRef.current) {
            setSessionModel(msg.model || '');
          } else if (msg.type === 'conv-attention' && (msg.accountId === selectedId || msg.key === selectedId || msg.sessionId === currentSid2)) {
            // JSONL poll (isAgentDone) is source of truth — don't let stale WS "working" override it
            if (msg.state === 'working' && isAgentDoneRef.current) {
              // Server thinks working, but JSONL says done — ignore, poll will correct
            } else {
              setAttention(msg.state);
              setAttentionReason(msg.reason);
            }
            if (msg.state === 'needs_attention' && sessionIdRef.current) {
              circuitOpenRef.current = false;
              pollFailCountRef.current = 0;
              setTimeout(pollNow, 500);
            }
            // If WS says working and agent was done, it might actually be working again — re-poll to verify
            if (msg.state === 'working' && isAgentDoneRef.current) {
              setTimeout(pollNow, 1000);
            }
          }
          if (msg.type === 'cui-state' && (msg.cuiId === selectedId || msg.sessionId === currentSid2)) {
            circuitOpenRef.current = false;
            pollFailCountRef.current = 0;
            if (msg.state === 'processing') {
              // Only trust "processing" if JSONL doesn't say done, OR trigger poll to verify
              if (!isAgentDoneRef.current) {
                setAttention('working');
                setAttentionReason(undefined);
                setRateLimitMessage(null);
              } else {
                // Agent was done but WS says processing — might be restarted, re-poll
                setTimeout(pollNow, 500);
              }
            }
            if (msg.state === 'done') {
              // Don't overwrite rate_limit state — user needs to see it
              setAttention(prev => prev === 'needs_attention' ? prev : 'idle');
              setAttentionReason(prev => prev === 'rate_limit' ? prev : 'done');
              setCurrentTool(null);
              // Agent finished → scroll to show new output
              userScrolledUpRef.current = false;
              if (liveMode) setLiveMode(false); // Auto-exit LIVE when done
              if (sessionIdRef.current) {
                setTimeout(pollNow, 500);
              }
            }
            if (msg.state === "error" && msg.message) {
              setAttention("needs_attention");
              const isRateLimit = msg.message.toLowerCase().includes('rate limit') || msg.message.toLowerCase().includes('nutzungslimit');
              setAttentionReason(isRateLimit ? "rate_limit" : "error");
              setRateLimitMessage(msg.message);
              if (sessionIdRef.current) setTimeout(pollNow, 1000);
            }
          }
          // Tool execution tracking
          if (msg.type === 'tool-executing' && msg.sessionId === currentSid2) {
            setCurrentTool({ toolName: msg.toolName, toolDetail: msg.toolDetail, startedAt: msg.startedAt });
          }
          if (msg.type === 'tool-done' && msg.sessionId === currentSid2) {
            setCurrentTool(null);
          }
          if (msg.type === 'tool-heartbeat' && msg.sessionId === currentSid2) {
            setCurrentTool(prev => prev || { toolName: msg.toolName, toolDetail: msg.toolDetail, startedAt: Date.now() - (msg.elapsedMs || 0) });
          }
          // Live character streaming (LIVE mode only)
          if (msg.type === 'cli-partial' && msg.sessionId === sessionIdRef.current && liveMode) {
            setMessages(prev => {
              const last = prev[prev.length - 1];
              if (last?.role === 'assistant' && last._streaming) {
                return [...prev.slice(0, -1), { ...last, content: msg.content }];
              }
              return [...prev, { role: 'assistant' as const, content: msg.content, _streaming: true, timestamp: new Date().toISOString() }];
            });
            userScrolledUpRef.current = false;
          }
          // Per-turn streaming: assistant message arrived via WS (real-time, no polling needed)
          if (msg.type === 'turn-update' && msg.sessionId === sessionIdRef.current) {
            setMessages(prev => {
              const last = prev[prev.length - 1];
              // Replace streaming partial with final turn
              if (last?._streaming) {
                return [...prev.slice(0, -1), msg.message];
              }
              // Dedup: skip if last message has identical content (poll may have already added it)
              if (last?.role === 'assistant') {
                const lastContent = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
                const newContent = typeof msg.message.content === 'string' ? msg.message.content : JSON.stringify(msg.message.content);
                if (lastContent === newContent) return prev;
              }
              return [...prev, msg.message];
            });
            userScrolledUpRef.current = false;
            lastPollHashRef.current = ''; // Invalidate so next poll re-applies ground truth
          }
          // Queue refresh on state changes
          if ((msg.type === 'cui-state' || msg.type === 'cui-response-ready' || msg.type === 'turn-update') && (msg.cuiId === selectedId || msg.accountId === selectedId || msg.sessionId === currentSid2)) {
            setQueueRefresh(n => n + 1);
          }
        } catch (err) {
          console.warn('[CuiLite] WS parse error:', (err as Error).message);
        }
      };
    };

    connect();

    // Listen for SessionStore reconnection — immediately reconnect this panel's WS
    const onServerReconnected = () => {
      if (disposed) return;
      console.log('[CuiLite WS] Server reconnected via SessionStore, immediate reconnect');
      if (reconnectTimer) clearTimeout(reconnectTimer);
      backoff = 1000;
      circuitOpenRef.current = false;
      pollFailCountRef.current = 0;
      const existing = panelWsRef.current;
      if (existing) { existing.onclose = null; existing.close(); panelWsRef.current = null; }
      connect();
    };
    window.addEventListener('cui-reconnected', onServerReconnected);

    return () => {
      disposed = true;
      window.removeEventListener('cui-reconnected', onServerReconnected);
      // CRITICAL: close the WebSocket to prevent connection leak
      const ws = panelWsRef.current;
      if (ws) { ws.onclose = null; ws.close(); }
      panelWsRef.current = null;
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, [selectedId, isTabVisible]); // sessionId via ref (no reconnection on navigate), pollNow/loadTemplates are stable callbacks

  // Auto-scroll only when user is near bottom (not scrolled up reading)
  useEffect(() => {
    if (!userScrolledUpRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      setUnreadCount(0);
    } else {
      setUnreadCount(c => c + 1);
    }
  }, [messages]);

  // Listen for "All Live" broadcast from workspace toolbar
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.live !== undefined) { setLiveMode(detail.live); }
    };
    window.addEventListener('cui-all-live', handler);
    return () => window.removeEventListener('cui-all-live', handler);
  }, []);

  // --- Handlers ---

  // --- Auto-Inject (Loop) Sync ---
  const syncLoopState = useCallback(async () => {
    if (window.__cuiServerAlive !== true || !sessionId) return;
    try {
      const r = await fetch(`/api/auto-inject/session/${sessionId}`, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) return;
      const data = await r.json().catch(() => null); // silent-ok: auto-inject config response parse failure; feature disabled until next poll
      if (!data) return;
      if (data.config) {
        setLoopEnabled(data.config.enabled);
        setLoopIntervalMin(Math.round(data.config.intervalMs / 60000));
        setLoopMessage(data.config.message);
      } else {
        setLoopEnabled(false);
      }
      setLastInjectTime(data.lastInject || null);
    } catch { /* timeout expected on slow connections */ }
  }, [sessionId]);

  useEffect(() => { syncLoopState(); }, [syncLoopState]);

  const toggleLoop = useCallback(async (enable: boolean) => {
    if (!selectedId || !sessionId) return;
    if (window.__cuiServerAlive === false) {
      console.warn('[CuiLite] Toggle loop blocked: server not alive');
      return;
    }
    try {
      if (enable) {
        await fetch("/api/auto-inject", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(20000),
          body: JSON.stringify({
            accountId: selectedId,
            sessionId,
            workDir,
            message: loopMessage,
            intervalMs: loopIntervalMin * 60000,
            enabled: true,
          }),
        });
      } else {
        await fetch("/api/auto-inject", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(20000),
          body: JSON.stringify({ accountId: selectedId, sessionId, enabled: false }),
        });
      }
      setLoopEnabled(enable);
      syncLoopState();
    } catch (err) { console.warn('[CuiLite] Loop toggle error:', (err as Error).message); }
  }, [selectedId, sessionId, workDir, loopMessage, loopIntervalMin, syncLoopState]);

  const saveLoopConfig = useCallback(async () => {
    if (!selectedId) return;
    if (window.__cuiServerAlive === false) {
      console.warn('[CuiLite] Save loop config blocked: server not alive');
      return;
    }
    try {
      await fetch("/api/auto-inject", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(20000),
        body: JSON.stringify({
          accountId: selectedId,
          sessionId,
          workDir,
          message: loopMessage,
          intervalMs: loopIntervalMin * 60000,
          enabled: loopEnabled,
        }),
      });
      syncLoopState();
    } catch (err) { console.warn('[CuiLite] Save loop config error:', (err as Error).message); }
    setShowLoopConfig(false);
  }, [selectedId, sessionId, workDir, loopMessage, loopIntervalMin, loopEnabled, syncLoopState]);

  const handleSaveTemplate = useCallback(async () => {
    if (!newTplLabel.trim() || !newTplMessage.trim()) return;
    if (window.__cuiServerAlive === false) {
      console.warn('[CuiLite] Save template blocked: server not alive');
      return;
    }
    try {
      if (editingTemplate) {
        const resp = await fetch(`/api/prompt-templates/${editingTemplate.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: newTplLabel, message: newTplMessage }),
          signal: AbortSignal.timeout(20000),
        });
        if (resp.ok) {
          const data = await resp.json().catch(() => null); // silent-ok: template response parse failure; outer catch logs the error
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
          const data = await resp.json().catch(() => null); // silent-ok: template response parse failure; outer catch logs the error
          if (data?.template) setReplyTemplates(prev => [...prev, data.template]);
        }
      }
    } catch (err) { console.warn('[CuiLite] Save template error:', (err as Error).message); }
    setShowTemplateForm(false);
    setEditingTemplate(null);
    setNewTplLabel('');
    setNewTplMessage('');
  }, [newTplLabel, newTplMessage, editingTemplate]);

  const handleDeleteTemplate = useCallback(async (id: string) => {
    if (window.__cuiServerAlive === false) {
      console.warn('[CuiLite] Delete template blocked: server not alive');
      return;
    }
    try {
      const resp = await fetch(`/api/prompt-templates/${id}`, { method: 'DELETE', signal: AbortSignal.timeout(20000) });
      if (resp.ok) setReplyTemplates(prev => prev.filter(t => t.id !== id));
    } catch (err) { console.warn('[CuiLite] Delete template error:', (err as Error).message); }
  }, []);

  const handleImagePaste = useCallback(async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageFiles: File[] = [];
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) imageFiles.push(file);
      }
    }
    if (imageFiles.length === 0) return;
    if (window.__cuiServerAlive === false) return;
    setPasteUploading(true);
    try {
      const imageData = await Promise.all(imageFiles.map(file =>
        new Promise<{ name: string; data: string }>((resolve) => {
          const reader = new FileReader();
          reader.onload = (ev) => resolve({ name: file.name, data: ev.target?.result as string });
          reader.readAsDataURL(file);
        })
      ));
      const resp = await fetch('/api/images', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: 'local', images: imageData }),
        signal: AbortSignal.timeout(60000),
      });
      if (!resp.ok) throw new Error(`Upload failed: HTTP ${resp.status}`);
      const data = await resp.json();
      if (data.readCommand) {
        setInput(prev => (prev ? prev + '\n' : '') + data.readCommand);
        setTimeout(() => textareaRef.current?.focus(), 50);
      }
    } catch (err: any) {
      console.warn('[CuiLitePanel] Paste image upload error:', err.message);
    } finally {
      setPasteUploading(false);
    }
  }, []);

  // Unfinish a manually-finished session (called on explicit user interaction only)
  const doUnfinish = useCallback((sid: string) => {
    if (!manualFinishedRef.current) return;
    manualFinishedRef.current = false;
    setManualFinished(false);
    fetch(`/api/mission/conversation/${sid}/finish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ finished: false }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {}); // silent-ok: unfinish API call is best-effort; WS turn event will restore working state
  }, []);

  const handleSend = useCallback(async (overrideMessage?: string) => {
    const rawMsg = overrideMessage || input.trim();
    if (!rawMsg || !sessionId) return;
    if (window.__cuiServerAlive === false) {
      setMessages(prev => [...prev, { role: 'system', content: 'Server nicht erreichbar — bitte warten bis Verbindung wiederhergestellt ist.', timestamp: new Date().toISOString() }]);
      return;
    }
    // User is actively sending — unfinish if session was manually finished
    doUnfinish(sessionId);
    setIsLoading(true);
    const msg = (!overrideMessage && planMode) ? `Bitte verwende Plan-Modus: ${rawMsg}` : rawMsg;
    if (!overrideMessage) setInput('');
    if (!overrideMessage && planMode) setPlanMode(false);
    setMessages(prev => [...prev, { role: 'user', content: msg, timestamp: new Date().toISOString() }]);
    // User action → always scroll to bottom
    userScrolledUpRef.current = false;
    setUnreadCount(0);
    setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
    setIsAgentDone(false);
    setAttentionReason(undefined);
            setRateLimitMessage(null);
    try {
      const resp = await fetch('/api/mission/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: selectedId, sessionId, message: msg, workDir, projectId }),
        signal: AbortSignal.timeout(65000),
      });
      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
        const errMsg: Message = { role: 'system', content: `Fehler: ${errData.error || 'Senden fehlgeschlagen'}`, timestamp: new Date().toISOString() };
        pendingSystemMsgsRef.current.push(errMsg); // Survives poll overwrites
        setMessages(prev => [...prev, errMsg]);
      } else {
        const data = await resp.json().catch(() => ({})); // silent-ok: send response parse failure uses empty object; resume-failed detection skipped
        // Server auto-recovered from broken resume → switch to new session
        if (data.resumeFailed && data.sessionId) {
          console.log(`[CuiLite] Resume failed, switched to new session: ${data.sessionId}`);
          setSessionId(data.sessionId);
          if (persistSession) try { localStorage.setItem(getSessionKey(selectedId), data.sessionId); } catch {} // silent-ok: localStorage may be disabled
          onRouteChange?.(`/c/${data.sessionId}`);
          setMessages([{ role: 'system', content: 'Neue Session gestartet (alte Session konnte nicht fortgesetzt werden)', timestamp: new Date().toISOString() }, { role: 'user', content: msg, timestamp: new Date().toISOString() }]);
        }
      }
    } catch (err) {
      console.error('[CuiLite] Send error:', err);
      const errText = err instanceof DOMException && err.name === 'TimeoutError' ? 'Timeout — Server antwortet nicht' : String(err);
      const errMsg: Message = { role: 'system', content: `Netzwerkfehler: ${errText}`, timestamp: new Date().toISOString() };
      pendingSystemMsgsRef.current.push(errMsg);
      setMessages(prev => [...prev, errMsg]);
      // Restore user input so the message is not lost
      if (!overrideMessage) setInput(msg);
    }
    setIsLoading(false);
    // Invalidate hash so next poll always applies state (user just sent a message)
    lastPollHashRef.current = '';
    // Mark as working immediately (WS turn-update will deliver content in real-time)
    setIsAgentDone(false); // Reset so WS events can set working again
    setAttention('working');
    setTimeout(pollNow, 1000);
  }, [input, sessionId, selectedId, workDir, planMode, pollNow, onRouteChange, doUnfinish]);

  // Respond to tool_use blocks (AskUserQuestion, ExitPlanMode, EnterPlanMode)
  const handleRespond = useCallback(async (text: string) => {
    if (!sessionId) return;
    if (window.__cuiServerAlive === false) {
      console.warn('[CuiLite] Respond blocked: server not alive');
      return;
    }
    setIsLoading(true);
    setMessages(prev => [...prev, { role: 'user', content: text, timestamp: new Date().toISOString() }]);
    try {
      const resp = await fetch('/api/mission/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: selectedId, sessionId, message: text, workDir, projectId }),
        signal: AbortSignal.timeout(65000),
      });
      if (resp.ok) {
        const data = await resp.json().catch(() => ({})); // silent-ok: respond response parse failure uses empty object; resume detection skipped
        if (data.resumeFailed && data.sessionId) {
          console.log(`[CuiLite] Respond: resume failed, new session: ${data.sessionId}`);
          setSessionId(data.sessionId);
          if (persistSession) try { localStorage.setItem(getSessionKey(selectedId), data.sessionId); } catch {} // silent-ok: localStorage may be disabled
          onRouteChange?.(`/c/${data.sessionId}`);
        }
      } else {
        const errData = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
        const errMsg: Message = { role: 'system', content: `Fehler: ${errData.error || 'Antwort fehlgeschlagen'}`, timestamp: new Date().toISOString() };
        pendingSystemMsgsRef.current.push(errMsg);
        setMessages(prev => [...prev, errMsg]);
      }
    } catch (err) {
      console.error('[CuiLite] Respond error:', err);
      const errMsg: Message = { role: 'system', content: `Netzwerkfehler: ${err instanceof Error ? err.message : String(err)}`, timestamp: new Date().toISOString() };
      pendingSystemMsgsRef.current.push(errMsg);
      setMessages(prev => [...prev, errMsg]);
    }
    setIsLoading(false);
    lastPollHashRef.current = '';
    setTimeout(pollNow, 1000);
  }, [sessionId, selectedId, workDir, pollNow, onRouteChange]);

  const handlePermission = useCallback(async (permId: string, action: 'approve' | 'deny') => {
    if (window.__cuiServerAlive === false) {
      console.warn('[CuiLite] Permission blocked: server not alive');
      return;
    }
    try {
      await fetch(`/api/mission/permissions/${selectedId}/${permId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
        signal: AbortSignal.timeout(10000),
      });
      lastPollHashRef.current = '';
      setTimeout(pollNow, 500);
    } catch (err) {
      console.error('[CuiLite] Permission error:', err);
    }
  }, [selectedId, pollNow]);

  const handleStop = useCallback(async () => {
    if (!sessionId) return;
    if (window.__cuiServerAlive === false) {
      console.warn('[CuiLite] Stop blocked: server not alive');
      return;
    }
    try {
      const resp = await fetch(`/api/mission/conversation/${selectedId}/${sessionId}/stop`, { method: 'POST', signal: AbortSignal.timeout(10000) });
      const data = await resp.json().catch(() => ({})); // silent-ok: stop response parse failure; stop status check uses falsy defaults
      setAttention('idle');
      setAttentionReason('done');
      setConvStatus('completed');
      lastPollHashRef.current = '';
      if (!data.apiStopOk && !data.childrenKilled) {
        console.warn('[CuiLite] Stop: API stop failed and no children killed — agent may still be running');
      }
      console.log(`[CuiLite] Stop: apiStopOk=${data.apiStopOk}, streamingId=${data.streamingId?.slice(0,8)}, killed=${data.childrenKilled}`);
      setTimeout(pollNow, 500);
    } catch (err) {
      console.error('[CuiLite] Stop error:', err);
    }
  }, [sessionId, selectedId, pollNow]);

  const handleHardKill = useCallback(async () => {
    if (!sessionId) return;
    if (window.__cuiServerAlive === false) return;
    if (!confirm('HARD KILL — Alle Prozesse dieser Session sofort beenden?')) return;
    try {
      const resp = await fetch(`/api/mission/conversation/${sessionId}/hard-kill`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(15000),
      });
      const data = await resp.json().catch(() => ({})); // silent-ok: hard-kill response parse failure; processes are killed regardless
      setAttention('idle');
      setAttentionReason('done');
      setConvStatus('completed');
      console.log(`[CuiLite] Hard-kill: ${data.killed} processes killed`);
      setTimeout(pollNow, 500);
    } catch (err) {
      console.error('[CuiLite] Hard-kill error:', err);
    }
  }, [sessionId, pollNow]);

  const handleQueueNavigate = useCallback((sid: string) => {
    setSessionId(sid);
    setShowQueue(false);
    setMessages([]);
    setPermissions([]);
    setAttention('idle');
    setAttentionReason(undefined);
            setRateLimitMessage(null);
    if (persistSession) try { localStorage.setItem(getSessionKey(selectedId), sid); } catch {} // silent-ok: localStorage may be disabled
    onRouteChange?.(`/c/${sid}`);
  }, [onRouteChange, selectedId, persistSession]);

  const handleStartNew = useCallback(async (subject: string, message: string, model: string = 'opus') => {
    if (window.__cuiServerAlive === false) {
      console.warn('[CuiLite] Start new blocked: server not alive');
      return false;
    }
    // Reserve panel immediately so auto-sync doesn't treat it as empty during POST
    onRouteChange?.('/c/_starting');
    try {
      const resp = await fetch('/api/mission/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: 'auto', message, workDir, subject, model, projectId }),
        signal: AbortSignal.timeout(65000),
      });
      if (!resp.ok) {
        console.warn('[CuiLite] Start new HTTP error:', resp.status);
        onRouteChange?.('');
        return false;
      }
      const data = await resp.json().catch(() => null); // silent-ok: start-new response parse failure returns null; warning logged and false returned
      if (!data || !data.sessionId) {
        console.warn('[CuiLite] Start new: invalid response (missing sessionId)');
        onRouteChange?.('');
        return false;
      }
      setSessionId(data.sessionId);
      setShowQueue(false);
      setMessages([]);
      if (persistSession) try { localStorage.setItem(getSessionKey(selectedId), data.sessionId); } catch {} // silent-ok: localStorage may be disabled
      onRouteChange?.(`/c/${data.sessionId}`);
      return true;
    } catch (err) {
      console.warn('[CuiLite] Start new error:', err);
      onRouteChange?.('');
      return false;
    }
  }, [selectedId, workDir, onRouteChange, persistSession]);

  // handleBack removed — conversations stay mounted until Finish

  const handlePause = useCallback(async () => {
    if (!sessionId) return;
    const newPaused = !isPaused;
    try {
      await fetch(`/api/mission/conversation/${sessionId}/pause`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paused: newPaused }),
        signal: AbortSignal.timeout(5000),
      });
      setIsPaused(newPaused);
    } catch (e) { console.warn('[CuiLite] Pause error:', e); }
  }, [sessionId, isPaused]);

  const handleReview = useCallback(async () => {
    if (!sessionId || reviewState === 'running') return;
    try {
      setReviewState('running');
      const resp = await fetch(`/api/mission/conversation/${sessionId}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: 'unknown' }));
        console.warn('[CuiLite] Review error:', err);
        setReviewState('idle');
      }
    } catch (e) {
      console.warn('[CuiLite] Review error:', e);
      setReviewState('idle');
    }
  }, [sessionId, reviewState]);

  const handleFinish = useCallback(async () => {
    if (!sessionId) return;
    try {
      const resp = await fetch(`/api/mission/conversation/${sessionId}/finish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ finished: true }),
        signal: AbortSignal.timeout(20000),
      });
      if (resp.status === 409) {
        // Session still has a live process — confirm and retry with force
        const data = await resp.json().catch(() => ({ message: 'Session laeuft noch.' }));
        if (confirm(`${data.message}\n\nTrotzdem finishen?`)) {
          const r2 = await fetch(`/api/mission/conversation/${sessionId}/finish`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ finished: true, confirm: true }),
            signal: AbortSignal.timeout(20000),
          });
          if (!r2.ok) { console.warn('[CuiLite] Finish confirm failed:', r2.status); return; }
        } else {
          return; // User cancelled — don't call onFinish
        }
      } else if (!resp.ok) {
        console.warn('[CuiLite] Finish failed:', resp.status);
        return;
      }
      // Server broadcasts control:conversation-finished -> LayoutManager deleteTab
      // onFinish as immediate local fallback
      onFinish?.(sessionId);
    } catch (e) { console.warn('[CuiLite] Finish error:', e); }
  }, [sessionId, onFinish]);

  // --- Render ---
  return (
    <div
      className={isPaused ? 'cui-panel-border--paused' : attention === 'working' ? 'cui-panel-border--working' : attention === 'needs_attention' ? 'cui-panel-border--attention' : ''}
      style={{ display: 'flex', flexDirection: 'column', height: '100%', background: isPaused ? 'rgba(122,162,247,0.13)' : 'var(--tn-surface)', overflow: 'hidden' }}
      onClick={sessionId ? () => doUnfinish(sessionId) : undefined}
    >
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px',
        background: (attention === 'working' && sessionId) ? '#1a2e1a' : (attention === 'needs_attention' && sessionId) ? (attentionReason === 'rate_limit' ? '#4a1515' : '#3d2a1a') : (attention === 'idle' && attentionReason === 'done' && sessionId) ? '#3d2a1a' : 'var(--tn-bg-dark)', borderBottom: (attention === 'working' && sessionId) ? '2px solid #9ece6a' : (attention === 'needs_attention' && sessionId) ? (attentionReason === 'rate_limit' ? '2px solid #EF4444' : '2px solid #ff9e64') : (attention === 'idle' && attentionReason === 'done' && sessionId) ? '2px solid #ff9e64' : '1px solid var(--tn-border)',
        height: 30, flexShrink: 0,
      }}>
        <div style={{
          width: 8, height: 8, borderRadius: '50%',
          background: attention === 'working' ? '#9ece6a'
            : attention === 'needs_attention' ? '#ff9e64'
            : (isAgentDone && attentionReason === 'done') ? '#ff9e64'
            : convStatus === 'ongoing' ? '#565f89'
            : account.color,
          animation: attention === 'working' ? 'q-pulse 2s ease-in-out infinite' : undefined,
        }} />
        <select
          value={selectedId}
          onChange={(e) => {
            const newAcct = e.target.value;
            // Cancel in-flight polling before switching
            if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null; }

            if (sessionId) {
              // Chat is open — reassign conversation to new account, stay in chat
              if (window.__cuiServerAlive !== false) {
                fetch(`/api/mission/conversation/${sessionId}/assign`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ accountId: newAcct }),
                  signal: AbortSignal.timeout(20000),
                }).catch((err) => { console.warn('[CuiLite] Assign conversation error:', err); });
              }
              // Save session for BOTH old and new account
              if (persistSession) {
                try { localStorage.setItem(getSessionKey(selectedId), sessionId); } catch {} // silent-ok: localStorage may be disabled
                try { localStorage.setItem(getSessionKey(newAcct), sessionId); } catch {} // silent-ok: localStorage may be disabled
              }
              setSelectedId(newAcct);
              // Keep sessionId, messages, and chat view — just switch account
              setMessages(prev => [...prev, { role: 'system', content: `Account gewechselt → ${ACCOUNTS.find(a => a.id === newAcct)?.label || newAcct}`, timestamp: new Date().toISOString() }]);
              setAttention('idle');
              setAttentionReason(undefined);
              setRateLimitMessage(null);
              try { localStorage.setItem(storageKey, newAcct); } catch {} // silent-ok: localStorage may be disabled
            } else {
              // No chat open (queue view) — normal switch
              let savedSession: string | null = null;
              try { savedSession = localStorage.getItem(getSessionKey(newAcct)); } catch {} // silent-ok: localStorage may be disabled
              setSelectedId(newAcct);
              setSessionId(savedSession);
              setShowQueue(!savedSession);
              setMessages([]);
              setAttention('idle');
              setAttentionReason(undefined);
              setRateLimitMessage(null);
              setLiveMode(false);
              try { localStorage.setItem(storageKey, newAcct); } catch {} // silent-ok: localStorage may be disabled
            }
          }}
          style={{
            background: 'var(--tn-bg)', color: 'var(--tn-text)',
            border: '1px solid var(--tn-border)', borderRadius: 4,
            padding: '2px 6px', fontSize: 11, cursor: 'pointer',
          }}
        >
          {SWITCHABLE_ACCOUNTS.map((a) => (
            <option key={a.id} value={a.id}>{a.label}</option>
          ))}
        </select>

        {/* Status badge */}
        {attention === 'working' && sessionId && (
          <span style={{ fontSize: 9, color: '#9ece6a', fontWeight: 600, opacity: 0.8, display: 'flex', alignItems: 'center', gap: 3, overflow: 'hidden', maxWidth: 220 }}>
            <span style={{ display: 'inline-block', width: 5, height: 5, borderRadius: '50%', background: '#9ece6a', animation: 'q-pulse 1s ease-in-out infinite', flexShrink: 0 }} />
            {currentTool ? (
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={currentTool.toolDetail || currentTool.toolName}>
                {currentTool.toolName}{currentTool.toolDetail ? `: ${currentTool.toolDetail}` : ''}
              </span>
            ) : 'arbeitet'}
          </span>
        )}
        {isPaused && sessionId && (
          <span style={{ fontSize: 9, color: '#7aa2f7', fontWeight: 600, letterSpacing: '0.3px' }}>Pausiert</span>
        )}
        {!isPaused && attention === 'idle' && isAgentDone && sessionId && attentionReason === 'done' && !manualFinished && (
          <span style={{ fontSize: 9, color: '#ff9e64', fontWeight: 600 }}>Wartet</span>
        )}
        {!isPaused && attention === 'needs_attention' && sessionId && (
          <span style={{ fontSize: 9, color: attentionReason === 'rate_limit' ? '#EF4444' : '#ff9e64', fontWeight: 600 }}>
            {attentionReason === 'plan' ? 'Plan' : attentionReason === 'question' ? 'Frage' : attentionReason === 'context_overflow' ? 'Zu lang' : attentionReason === 'rate_limit' ? 'Rate Limit' : attentionReason === 'error' || attentionReason === 'send_failed' ? 'Fehler' : attentionReason === 'done' ? 'Wartet' : 'Aktion'}
          </span>
        )}



        {/* Mount-sync indicator: shown until first poll clears stale cache */}
        {isMountSyncing && sessionId && (
          <span style={{ fontSize: 9, color: '#7aa2f7', fontWeight: 600, opacity: 0.75 }}>syncing…</span>
        )}

        {/* Spacer - title moved below header */}
        <span style={{ flex: 1 }} />

        {/* Live mode toggle */}
        {sessionId && (
          <button onClick={() => setLiveMode(prev => !prev)} style={{
            background: liveMode ? 'rgba(168,85,247,0.15)' : 'none',
            border: `1px solid ${liveMode ? '#A855F7' : 'var(--tn-border)'}`,
            color: liveMode ? '#A855F7' : 'var(--tn-text-muted)',
            borderRadius: 4, padding: '1px 8px', fontSize: 10,
            cursor: 'pointer', fontWeight: liveMode ? 700 : 400,
            transition: 'all 0.2s',
            animation: liveMode ? 'live-pulse 2s ease-in-out infinite' : undefined,
            boxShadow: liveMode ? '0 0 8px rgba(168,85,247,0.3)' : 'none',
          }}>
            {liveMode ? '\u25CF Live' : '\u23F8 Static'}
          </button>
        )}

        {/* Manual refresh */}
        {sessionId && (
          <button onClick={() => { lastPollHashRef.current = ''; pollNow(); }} style={{
            background: 'var(--tn-bg)', color: 'var(--tn-text-muted)',
            border: '1px solid var(--tn-border)', borderRadius: 4,
            padding: '1px 8px', fontSize: 10, cursor: 'pointer',
          }}>
            Refresh
          </button>
        )}

        {/* Review button — starts independent review session */}
        {sessionId && (
          <button onClick={handleReview} disabled={reviewState === 'running'}
            title="Unabhängige Review-Session starten — prüft ob Umsetzung den Anforderungen entspricht"
            style={{
              background: reviewState === 'done' ? 'rgba(158,206,106,0.15)' : reviewState === 'running' ? 'rgba(122,162,247,0.1)' : 'transparent',
              color: reviewState === 'done' ? '#9ece6a' : reviewState === 'running' ? '#7aa2f7' : 'var(--tn-text-muted)',
              border: `1px solid ${reviewState === 'done' ? '#9ece6a' : reviewState === 'running' ? '#7aa2f7' : 'var(--tn-border)'}`,
              borderRadius: 4, padding: '1px 8px', fontSize: 10, cursor: reviewState === 'running' ? 'default' : 'pointer', fontWeight: 600,
              opacity: reviewState === 'running' ? 0.8 : 1,
            }}>
            {reviewState === 'running' ? '⧖ Review...' : reviewState === 'done' ? '✓ Review' : 'Review'}
          </button>
        )}

        {/* Pause button — suppresses needs_attention without closing */}
        {sessionId && (
          <button onClick={handlePause} title={isPaused ? 'Pausierung aufheben' : 'Konversation pausieren'}
            style={{
              background: isPaused ? 'rgba(122,162,247,0.15)' : 'transparent',
              color: isPaused ? '#7aa2f7' : 'var(--tn-text-muted)',
              border: `1px solid ${isPaused ? '#7aa2f7' : 'var(--tn-border)'}`,
              borderRadius: 4, padding: '1px 8px', fontSize: 10, cursor: 'pointer', fontWeight: 600,
              boxShadow: isPaused ? '0 0 6px rgba(122,162,247,0.25)' : 'none',
            }}>
            ⏸ {isPaused ? 'Pausiert' : 'Pause'}
          </button>
        )}

        {/* Finish button — persistent close */}
        {sessionId && (
          <button onClick={handleFinish} title="Konversation abschließen"
            style={{
              background: 'transparent', color: '#EF4444',
              border: '1px solid #EF4444', borderRadius: 4,
              padding: '1px 6px', fontSize: 10, cursor: 'pointer', fontWeight: 600,
            }}>
            Finish
          </button>
        )}

        {/* Model badge */}
        {sessionId && sessionModel && (
          <span style={{
            fontSize: 9, fontWeight: 600, padding: '1px 5px', borderRadius: 3,
            background: sessionModel === 'opus' ? '#2d2040' : 'var(--tn-bg)',
            color: sessionModel === 'opus' ? '#bb9af7' : 'var(--tn-text-muted)',
            border: `1px solid ${sessionModel === 'opus' ? '#bb9af7' : 'var(--tn-border)'}`,
            textTransform: 'uppercase', letterSpacing: '0.5px',
          }}>
            {sessionModel}
          </span>
        )}
        {/* Lite badge */}
        <span style={{ fontSize: 8, color: 'var(--tn-text-muted)', opacity: 0.5 }}>LITE</span>
      </div>

      {/* Conversation Title Bar */}
      {sessionId && convName && (
        <div style={{
          padding: '4px 16px 6px',
          borderBottom: '1px solid var(--tn-border)',
          flexShrink: 0,
          overflow: 'hidden',
        }}>
          <div style={{
            fontSize: 13, fontWeight: 600, color: 'var(--tn-text)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            lineHeight: 1.3,
          }}>
            {convName}
          </div>
        </div>
      )}

      {/* Attention Banner */}
      {attention === 'needs_attention' && sessionId && attentionReason !== 'done' && (
        <div style={{
          padding: '6px 16px',
          background: attentionReason === 'plan' ? 'rgba(245,158,11,0.12)'
            : attentionReason === 'question' ? 'rgba(59,130,246,0.12)'
            : attentionReason === 'rate_limit' ? 'rgba(239,68,68,0.08)'
            : attentionReason === 'context_overflow' ? 'rgba(224,175,104,0.12)'
            : 'rgba(239,68,68,0.12)',
          borderBottom: '1px solid var(--tn-border)',
          display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0,
        }}>
          <span style={{
            fontSize: 12, fontWeight: 700,
            color: attentionReason === 'plan' ? '#ff9e64'
              : attentionReason === 'question' ? '#ff9e64'
              : attentionReason === 'context_overflow' ? '#ff9e64'
              : attentionReason === 'rate_limit' ? '#EF4444'
              : '#EF4444',
          }}>
            {attentionReason === 'plan' ? 'Plan wartet auf Freigabe'
              : attentionReason === 'question' ? `${selectedId === 'gemini' ? 'Gemini' : 'Claude'} hat eine Frage`
              : attentionReason === 'context_overflow' ? 'Kontext zu lang — Nachricht erneut senden, wird automatisch kompaktiert.'
              : attentionReason === 'rate_limit' ? 'Rate Limit — Account hat das Nutzungslimit erreicht. Anderen Account verwenden!'
              : (attentionReason === 'error' || attentionReason === 'send_failed') ? (rateLimitMessage || 'Nachricht konnte nicht zugestellt werden. Bitte erneut versuchen.')
              : 'Aktion erforderlich'}
          </span>
          <span style={{ flex: 1 }} />
          <button onClick={() => { lastPollHashRef.current = ''; pollNow(); }} style={{
            padding: '2px 10px', fontSize: 11, borderRadius: 3, cursor: 'pointer',
            background: 'var(--tn-bg)', border: '1px solid var(--tn-border)', color: 'var(--tn-text)',
          }}>
            Aktualisieren
          </button>
        </div>
      )}

      {/* Permission Bar */}
      {permissions.length > 0 && sessionId && (
        <div style={{
          padding: '6px 16px',
          background: 'rgba(245,158,11,0.08)',
          borderBottom: '1px solid var(--tn-border)',
          flexShrink: 0,
          maxHeight: '60vh', overflow: 'auto',
        }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#F59E0B', marginBottom: 4 }}>
            Genehmigungen ({permissions.length})
          </div>
          {permissions.map(perm => {
            const planText = perm.toolInput?.plan as string | undefined;
            const isPlanMode = perm.toolName === 'ExitPlanMode' || perm.toolName === 'EnterPlanMode';
            return (
              <div key={perm.id} style={{ marginBottom: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 12, color: 'var(--tn-text)', flex: 1 }}>
                    {perm.toolName || perm.type}: {perm.title || perm.id.slice(0, 8)}
                  </span>
                  <button onClick={() => handlePermission(perm.id, 'approve')} style={{
                    padding: '3px 10px', fontSize: 11, borderRadius: 3, cursor: 'pointer',
                    background: '#10B981', border: 'none', color: '#fff', fontWeight: 600,
                  }}>OK</button>
                  <button onClick={() => handlePermission(perm.id, 'deny')} style={{
                    padding: '3px 10px', fontSize: 11, borderRadius: 3, cursor: 'pointer',
                    background: '#EF4444', border: 'none', color: '#fff', fontWeight: 600,
                  }}>X</button>
                </div>
                {isPlanMode && planText && (
                  <details style={{ marginTop: 4 }}>
                    <summary style={{ fontSize: 11, color: '#F59E0B', cursor: 'pointer' }}>
                      Plan anzeigen ({planText.length > 1000 ? `${Math.round(planText.length / 1000)}k Zeichen` : `${planText.length} Zeichen`})
                    </summary>
                    <div style={{
                      marginTop: 4, padding: 8, borderRadius: 4,
                      background: 'var(--tn-bg)', border: '1px solid var(--tn-border)',
                      fontSize: 11, lineHeight: 1.5, whiteSpace: 'pre-wrap',
                      maxHeight: 300, overflow: 'auto', color: 'var(--tn-text)',
                    }}>
                      {planText}
                    </div>
                  </details>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Content: Queue or Messages */}
      {showQueue || !sessionId ? (
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <QueueOverlay
            accountId={selectedId}
            projectId={projectId}
            workDir={workDir}
            onNavigate={handleQueueNavigate}
            onStartNew={handleStartNew}
            refreshSignal={queueRefresh}
          />
        </div>
      ) : (
        <>
          {/* Message List */}
          <div
            ref={scrollContainerRef}
            onScroll={() => {
              const el = scrollContainerRef.current;
              if (!el) return;
              // "Near bottom" = within 150px of the end (80px was too tight, missed scroll)
              const isScrolledUp = el.scrollTop + el.clientHeight < el.scrollHeight - 150;
              userScrolledUpRef.current = isScrolledUp;
              if (!isScrolledUp) setUnreadCount(0);
            }}
            style={{ flex: 1, overflow: 'auto', minHeight: 0 }}
          >
            {messages.length === 0 && (
              <LoadingConversation sessionId={sessionId} onBack={() => { if (sessionId) onLoadFailed?.(sessionId); }} onRetry={pollNow} onLoadFailed={onLoadFailed} />
            )}
            {messages.length > 15 && !showAllMessages && (
              <button onClick={() => setShowAllMessages(true)} style={{
                display: 'block', width: '100%', padding: '8px', background: 'var(--tn-bg-highlight)',
                border: 'none', color: 'var(--tn-blue)', cursor: 'pointer', fontSize: 11,
              }}>
                {messages.length - 15} aeltere Nachrichten laden...
              </button>
            )}
            {(showAllMessages ? messages : messages.slice(-15)).map((msg, i, arr) => (
              <MessageRow key={msg.timestamp || i} msg={msg} onRespond={handleRespond} isLast={i === arr.length - 1} workDir={workDir} selectedId={selectedId} serverPlanText={serverPlanText} sessionCwd={sessionCwd} />
            ))}
            <div ref={messagesEndRef} />
          </div>

          {/* New-messages indicator — shown when user scrolled up and new messages arrived */}
          {unreadCount > 0 && (
            <div style={{ position: 'relative', flexShrink: 0, height: 0 }}>
              <button
                onClick={() => {
                  messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
                  userScrolledUpRef.current = false;
                  setUnreadCount(0);
                }}
                style={{
                  position: 'absolute', bottom: 8, left: '50%', transform: 'translateX(-50%)',
                  background: 'var(--tn-blue, #3B82F6)', color: '#fff',
                  border: 'none', borderRadius: 16, padding: '5px 14px',
                  fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
                  boxShadow: '0 2px 8px rgba(0,0,0,0.35)', zIndex: 10,
                }}
              >
                ↓ {unreadCount} neue Nachricht{unreadCount !== 1 ? 'en' : ''}
              </button>
            </div>
          )}

          {/* Input Bar */}
          <div style={{
            padding: '8px 12px', borderTop: '1px solid var(--tn-border)',
            background: 'var(--tn-bg-dark)', flexShrink: 0,
          }}>
            {/* Action Buttons Row - Plan, Loop, Stop, ... */}
            {/* Fachpartner role: only Stop visible (Plan/Loop/KILL/Templates are dev-tools). */}
            <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 4 }}>
              {isAdvancedUser && (
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
              )}
              {isAdvancedUser && (
                <button
                  onClick={() => { if (loopEnabled) { toggleLoop(false); } else { toggleLoop(true); } }}
                  onContextMenu={(e) => { e.preventDefault(); setShowLoopConfig(!showLoopConfig); }}
                  title={loopEnabled ? "Loop stoppen (Klick)" : "Loop starten (Klick) | Config (Rechtsklick)"}
                  style={{
                    padding: "4px 8px", borderRadius: 4, cursor: "pointer", flexShrink: 0,
                    background: loopEnabled ? "rgba(16,185,129,0.15)" : "var(--tn-bg)",
                    border: `1px solid ${loopEnabled ? "#10B981" : "var(--tn-border)"}`,
                    color: loopEnabled ? "#10B981" : "var(--tn-text-muted)",
                    fontSize: 11, fontWeight: loopEnabled ? 700 : 400,
                  }}
                >
                  {loopEnabled ? "Loop u25CF" : "Loop"}
                </button>
              )}
              <button
                onClick={handleStop}
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
              {isAdvancedUser && (
                <button
                  onClick={handleHardKill}
                  title="HARD KILL — Alle Prozesse sofort beenden (inkl. Zombies)"
                  style={{
                    padding: '4px 6px', borderRadius: 4, fontSize: 9, cursor: 'pointer', flexShrink: 0,
                    background: 'rgba(239,68,68,0.15)',
                    border: '1px solid rgba(239,68,68,0.5)',
                    color: '#EF4444', fontWeight: 700, letterSpacing: 0.5,
                  }}
                >
                  KILL
                </button>
              )}
              {isAdvancedUser && (
                <button
                  onClick={() => { setShowTemplateForm(true); setEditingTemplate(null); setNewTplLabel(''); setNewTplMessage(''); }}
                  title="Neues Template erstellen"
                  style={{ padding: '4px 8px', borderRadius: 4, fontSize: 11, cursor: 'pointer', background: 'transparent', border: '1px dashed var(--tn-border)', color: 'var(--tn-text-muted)', opacity: 0.6 }}
                >
                  ...
                </button>
              )}
              {planMode && isAdvancedUser && (
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
                  <select value={loopIntervalMin} onChange={e => setLoopIntervalMin(Number(e.target.value))} style={{ padding: "2px 4px", fontSize: 10, background: "var(--tn-bg-dark)", color: "var(--tn-text)", border: "1px solid var(--tn-border)", borderRadius: 3 }}>
                    <option value={1}>1 min</option>
                    <option value={2}>2 min</option>
                    <option value={3}>3 min</option>
                    <option value={5}>5 min</option>
                    <option value={10}>10 min</option>
                    <option value={15}>15 min</option>
                  </select>
                  <div style={{ flex: 1 }} />
                  <button onClick={() => { toggleLoop(true); setShowLoopConfig(false); }} style={{ padding: "3px 10px", borderRadius: 3, fontSize: 10, cursor: "pointer", background: "#10B981", border: "none", color: "#fff", fontWeight: 600 }}>Start</button>
                  <button onClick={() => setShowLoopConfig(false)} style={{ padding: "3px 6px", borderRadius: 3, fontSize: 10, cursor: "pointer", background: "transparent", border: "1px solid var(--tn-border)", color: "var(--tn-text-muted)" }}>X</button>
                </div>
                <div style={{ display: "flex", gap: 4, marginBottom: 4 }}>
                  {LOOP_PRESETS.map((preset, i) => (
                    <button key={i} onClick={() => setLoopMessage(preset.message)} title={preset.message.slice(0, 120)} style={{ padding: "2px 6px", borderRadius: 3, fontSize: 9, cursor: "pointer", background: loopMessage === preset.message ? "rgba(16,185,129,0.2)" : "var(--tn-bg-dark)", border: `1px solid ${loopMessage === preset.message ? "#10B981" : "var(--tn-border)"}`, color: loopMessage === preset.message ? "#10B981" : "var(--tn-text-muted)", fontWeight: loopMessage === preset.message ? 600 : 400 }}>
                      {preset.label}
                    </button>
                  ))}
                </div>
                <textarea value={loopMessage} onChange={e => setLoopMessage(e.target.value)} placeholder="Auto-Inject Nachricht..." rows={2} style={{ width: "100%", padding: "4px 6px", fontSize: 10, background: "var(--tn-bg-dark)", color: "var(--tn-text)", border: "1px solid var(--tn-border)", borderRadius: 3, fontFamily: "inherit", resize: "vertical", minHeight: 36, boxSizing: "border-box", lineHeight: "1.3" }} />
                {lastInjectTime && <div style={{ fontSize: 9, color: "var(--tn-text-muted)", marginTop: 2 }}>Letzter Inject: {new Date(lastInjectTime).toLocaleTimeString("de-DE")}</div>}
              </div>
            )}
            {/* Prompt Template Cards */}
            {replyTemplates.length > 0 && !showTemplateForm && (
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 4, maxHeight: 80, overflowY: 'auto' }}>
                {replyTemplates.map(tpl => (
                  <div key={tpl.id} style={{ display: 'flex', alignItems: 'stretch', borderRadius: 4, border: '1px solid var(--tn-border)', overflow: 'hidden', maxWidth: '48%' }}>
                    <button
                      onClick={() => handleSend(tpl.message)}
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
                  {editingTemplate && <button onClick={() => { if (confirm(`"${editingTemplate.label}" löschen?`)) { handleDeleteTemplate(editingTemplate.id); setShowTemplateForm(false); setEditingTemplate(null); } }} style={{ padding: '4px 8px', borderRadius: 3, fontSize: 11, cursor: 'pointer', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#EF4444', fontWeight: 600 }}>Löschen</button>}
                  <button onClick={() => { setShowTemplateForm(false); setEditingTemplate(null); }} style={{ padding: '4px 8px', borderRadius: 3, fontSize: 11, cursor: 'pointer', background: 'transparent', border: '1px solid var(--tn-border)', color: 'var(--tn-text-muted)' }}>X</button>
                </div>
                <textarea value={newTplMessage} onChange={e => setNewTplMessage(e.target.value)} placeholder="Prompt-Text eingeben..." rows={3} onKeyDown={e => { if (e.key === 'Escape') { setShowTemplateForm(false); setEditingTemplate(null); } }} style={{ width: '100%', padding: '4px 6px', fontSize: 11, background: 'var(--tn-bg-dark)', color: 'var(--tn-text)', border: '1px solid var(--tn-border)', borderRadius: 3, fontFamily: 'inherit', resize: 'vertical', minHeight: 50, boxSizing: 'border-box', lineHeight: '1.4' }} />
              </div>
            )}
            {/* Input Row - Paste Zone + Textarea + Send */}
            <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}>
              {/* Image paste zone — click then Cmd+V */}
              <div
                ref={pasteZoneRef}
                tabIndex={0}
                onPaste={handleImagePaste}
                onClick={() => pasteZoneRef.current?.focus()}
                onFocus={(e) => { e.currentTarget.style.borderColor = '#A855F7'; e.currentTarget.style.color = '#A855F7'; }}
                onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--tn-border)'; e.currentTarget.style.color = 'var(--tn-text-muted)'; }}
                title="Hier klicken, dann Cmd+V um Bild einzufuegen"
                style={{
                  width: 36, minHeight: 48, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: pasteUploading ? 'rgba(168,85,247,0.15)' : 'var(--tn-bg)',
                  border: `1px solid ${pasteUploading ? '#A855F7' : 'var(--tn-border)'}`,
                  borderRadius: 4, cursor: 'pointer', outline: 'none',
                  fontSize: 16, color: pasteUploading ? '#A855F7' : 'var(--tn-text-muted)',
                  transition: 'border-color 0.2s, color 0.2s',
                  flexShrink: 0,
                }}
              >
                {pasteUploading ? '\u23F3' : '\uD83D\uDDBC'}
              </div>
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                placeholder={pasteUploading ? 'Bild wird hochgeladen...' : planMode ? 'Aufgabe beschreiben... (Plan-Modus)' : 'Nachricht... (Enter = Senden)'}
                rows={2}
                style={{
                  flex: 1, resize: 'vertical', padding: '6px 10px', fontSize: 13,
                  background: 'var(--tn-bg)', color: 'var(--tn-text)',
                  border: `1px solid ${pasteUploading ? '#A855F7' : planMode ? '#F59E0B' : 'var(--tn-border)'}`, borderRadius: 4,
                  fontFamily: 'inherit', maxHeight: 120, minHeight: 48,
                }}
              />
              <button
                onClick={() => handleSend()}
                disabled={!input.trim() || isLoading}
                style={{
                  padding: '6px 14px', borderRadius: 4, fontSize: 12, cursor: 'pointer',
                  background: input.trim() && !isLoading ? (planMode ? '#ff9e64' : '#9ece6a') : 'var(--tn-border)',
                  border: 'none', color: '#fff', fontWeight: 600,
                  opacity: input.trim() && !isLoading ? 1 : 0.5,
                  alignSelf: 'stretch',
                }}
              >
                {isLoading ? '...' : planMode ? 'Planen' : 'Senden'}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
