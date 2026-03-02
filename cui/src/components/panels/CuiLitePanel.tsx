import { useState, useRef, useEffect, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ACCOUNTS } from '../../types';
import QueueOverlay from './QueueOverlay';

// --- Types ---
const SWITCHABLE_ACCOUNTS = ACCOUNTS.filter(a => a.id !== 'local');

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
}

interface Message {
  role: 'user' | 'assistant' | 'system' | 'rate_limit';
  content: string | ContentBlock[];
  timestamp?: string;
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
  initialSessionId?: string;
  onLoadFailed?: (sessionId: string) => void;
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
  code: ({ className, children, ...props }: any) => {
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
function ToolUseBlock({ block, onRespond, workDir }: { block: ContentBlock; onRespond?: (text: string) => void; workDir?: string }) {
  const [planText, setPlanText] = useState<string | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [responded, setResponded] = useState(false);

  // Load plan text when ExitPlanMode block is rendered
  useEffect(() => {
    if (block.name !== 'ExitPlanMode' || !workDir || planText !== null) return;
    setPlanLoading(true);
    fetch(`/api/file-read?path=${encodeURIComponent(workDir + '/.claude/plan.md')}`, { signal: AbortSignal.timeout(5000) })
      .then(r => r.ok ? r.text() : Promise.reject('not found'))
      .then(text => setPlanText(text))
      .catch(() => setPlanText(''))
      .finally(() => setPlanLoading(false));
  }, [block.name, workDir, planText]);

  if (block.name === 'AskUserQuestion' && block.input?.questions) {
    const questions = block.input.questions as Array<{
      question: string;
      header?: string;
      options?: Array<{ label: string; description?: string }>;
      multiSelect?: boolean;
    }>;
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

// --- Message Row ---
function MessageRow({ msg, onRespond, isLast, workDir }: { msg: Message; onRespond?: (text: string) => void; isLast: boolean; workDir?: string }) {
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

  // Rate limit messages get special styling
  if (msg.role === 'rate_limit') {
    return (
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--tn-border)', background: 'rgba(239,68,68,0.08)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: '#EF4444' }}>Rate Limit</span>
          {msg.timestamp && <span style={{ fontSize: 10, color: 'var(--tn-text-muted)' }}>{new Date(msg.timestamp).toLocaleTimeString()}</span>}
        </div>
        <div style={{ fontSize: 12, color: '#EF4444', lineHeight: 1.5 }}>
          {typeof msg.content === 'string' ? msg.content : 'Nutzungslimit erreicht. Bitte anderen Account verwenden oder warten.'}
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
          {msg.role === 'assistant' ? 'Claude' : msg.role === 'system' ? 'System' : 'User'}
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
        <ToolUseBlock key={i} block={block} onRespond={onRespond} workDir={workDir} />
      ))}
    </div>
  );
}

// --- Loading state with timeout + retry ---
// Only counts elapsed time when server is alive — pauses during server restarts
function LoadingConversation({ sessionId, onBack, onRetry, onLoadFailed }: { sessionId: string | null; onBack: () => void; onRetry: () => void; onLoadFailed?: (sessionId: string) => void }) {
  const [elapsed, setElapsed] = useState(0);
  const failedRef = useRef(false);
  const retriedOnReconnectRef = useRef(false);
  useEffect(() => {
    const t = setInterval(() => {
      // Pause timeout while server is down — session is likely fine, just can't reach it
      if ((window as any).__cuiServerAlive === false) return;
      setElapsed(s => s + 1);
    }, 1000);
    return () => clearInterval(t);
  }, []);
  // Auto-retry when server comes back alive
  useEffect(() => {
    if ((window as any).__cuiServerAlive === true && !retriedOnReconnectRef.current && elapsed > 0) {
      retriedOnReconnectRef.current = true;
      onRetry();
    }
  });
  useEffect(() => {
    if (elapsed >= 12 && !failedRef.current && onLoadFailed && sessionId) {
      failedRef.current = true;
      onLoadFailed(sessionId);
    }
  }, [elapsed, onLoadFailed, sessionId]);
  const serverDown = (window as any).__cuiServerAlive === false;
  return (
    <div style={{ textAlign: 'center', color: 'var(--tn-text-muted)', marginTop: 40, fontSize: 13 }}>
      {serverDown ? (
        'Server startet neu...'
      ) : elapsed < 8 ? (
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
export default function CuiLitePanel({ accountId, projectId, workDir, panelId, isTabVisible = true, onRouteChange, initialSessionId, onLoadFailed }: CuiLitePanelProps) {
  const storageKey = `cui-lite-account-${panelId || projectId || 'default'}`;
  const persistSession = !initialSessionId; // Don't persist to localStorage for AllChats panels

  const getSessionKey = (acctId: string) => `cui-lite-session-${panelId || projectId || 'default'}-${acctId}`;

  // Resolve initial account: localStorage > prop > first account (user's switch must survive reload)
  const initialAccount = (() => { try { return localStorage.getItem(storageKey) || accountId || ACCOUNTS[0].id; } catch { return accountId || ACCOUNTS[0].id; } })();

  const [selectedId, setSelectedId] = useState(initialAccount);
  const [sessionId, setSessionId] = useState<string | null>(() => {
    if (initialSessionId) return initialSessionId;
    try { return localStorage.getItem(getSessionKey(initialAccount)); } catch { return null; }
  });
  const [messages, setMessages] = useState<Message[]>([]);
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
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [rateLimitMessage, setRateLimitMessage] = useState<string | null>(null);
  const [convName, setConvName] = useState('');
  const [planMode, setPlanMode] = useState(false);
  const [liveMode, setLiveMode] = useState(false);
  const [isAgentDone, setIsAgentDone] = useState(false);

  // --- Prompt Templates ---
  interface PromptTemplate { id: string; label: string; message: string; category: "reply" | "start"; subject?: string; order: number; createdAt: string; }
  const [replyTemplates, setReplyTemplates] = useState<PromptTemplate[]>([]);
  const [showTemplateForm, setShowTemplateForm] = useState(false);
  const [newTplLabel, setNewTplLabel] = useState("");
  const [newTplMessage, setNewTplMessage] = useState("");
  const [editingTemplate, setEditingTemplate] = useState<PromptTemplate | null>(null);

  // --- Auto-Inject (Loop Mode) ---
  const [loopEnabled, setLoopEnabled] = useState(false);
  const [loopIntervalMin, setLoopIntervalMin] = useState(5);
  const [loopMessage, setLoopMessage] = useState("Schau dir die aktuellen Test-Logs an und entscheide selbst: Wenn Probleme sichtbar sind, behebe sie (defensive coding, fail fast) und committe. Wenn Tests noch laufen oder alles passt, sage kurz Bescheid und warte.");
  const [showLoopConfig, setShowLoopConfig] = useState(false);
  const [lastInjectTime, setLastInjectTime] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const userScrolledUpRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollFailCountRef = useRef(0);
  const circuitOpenRef = useRef(false); // Circuit breaker: stops polling after persistent failures

  const account = ACCOUNTS.find(a => a.id === selectedId) || ACCOUNTS[0];
  const pollInterval = liveMode ? 2000 : 15000;

  // --- Polling (conversation only — states come via WebSocket) ---
  const pollNow = useCallback(async () => {
    if (!sessionId) return;
    // Skip if server is known to be down (WS disconnected)
    if ((window as any).__cuiServerAlive === false) return;
    // Skip if circuit breaker is open (persistent 502s for this conversation)
    if (circuitOpenRef.current) return;
    try {
      const convResp = await fetch(`/api/mission/conversation/${selectedId}/${sessionId}?tail=50`, { signal: AbortSignal.timeout(8000) });
      if (convResp.ok) {
        const data = await convResp.json();
        setMessages(data.messages || []);
        setConvStatus(data.status === 'ongoing' ? 'ongoing' : 'completed');
        setPermissions(data.permissions || []);
        setConvName(data.summary || '');
        setIsAgentDone(!!data.isAgentDone);
        if (data.rateLimited) {
          setAttention('needs_attention');
          setAttentionReason('rate_limit');
        }
        pollFailCountRef.current = 0;
        circuitOpenRef.current = false;
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
    } catch {
      // Network error (server down, connection refused)
      pollFailCountRef.current++;
    }
  }, [sessionId, selectedId]);

  // Fetch states once on mount/account change (WS handles updates after that)
  useEffect(() => {
    if ((window as any).__cuiServerAlive === false) return;
    fetch('/api/mission/states', { signal: AbortSignal.timeout(5000) })
      .then(r => r.ok ? r.json() : null)
      .then(states => {
        if (!states) return;
        const myState = states[selectedId];
        if (myState) {
          setAttention(myState.state || 'idle');
          setAttentionReason(myState.reason);
        }
      })
      .catch(() => {}); // Server may be restarting
  }, [selectedId]);

  // Adaptive polling with recursive setTimeout (interval adjusts to failure count)
  useEffect(() => {
    if (!sessionId || !isTabVisible) {
      if (!isTabVisible && liveMode) setLiveMode(false);
      return;
    }
    let cancelled = false;
    const schedulePoll = () => {
      if (cancelled) return;
      // Adaptive delay: backs off on failures, pauses when circuit is open
      const fails = pollFailCountRef.current;
      const delay = circuitOpenRef.current ? 0 // stop scheduling (WS will re-trigger)
        : fails >= 5 ? 60000 // 1 min after 5+ fails
        : fails >= 3 ? 30000 // 30s after 3 fails
        : pollInterval; // normal: 2s (live) or 15s
      if (delay === 0) return; // circuit open — stop polling
      pollTimerRef.current = setTimeout(async () => {
        if (cancelled) return;
        await pollNow();
        schedulePoll();
      }, delay);
    };
    // Initial poll then start schedule
    pollNow().then(() => { if (!cancelled) schedulePoll(); });
    return () => {
      cancelled = true;
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, [sessionId, selectedId, isTabVisible, pollNow, pollInterval]);

  // --- Fetch Prompt Templates (retry on failure — server may be restarting) ---
  const loadTemplates = useCallback(() => {
    fetch('/api/prompt-templates', { signal: AbortSignal.timeout(5000) })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data) return;
        const reply = (data.templates || []).filter((t: PromptTemplate) => t.category === 'reply');
        reply.sort((a: PromptTemplate, b: PromptTemplate) => a.order - b.order);
        setReplyTemplates(reply);
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    if ((window as any).__cuiServerAlive === false) return;
    loadTemplates();
  }, [loadTemplates]);

  // --- WS for realtime attention events (auto-reconnect) ---
  useEffect(() => {
    if (!isTabVisible) return;
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let backoff = 1000; // start at 1s, doubles up to 30s max

    const connect = () => {
      if (disposed) return;
      // Don't hammer WS when server is down — wait for App WS to restore __cuiServerAlive
      if ((window as any).__cuiServerAlive === false) {
        reconnectTimer = setTimeout(connect, Math.min(backoff, 10000));
        return;
      }
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${protocol}://${window.location.host}/ws`);
      ws.onerror = () => {}; // Suppress console noise during server restarts

      ws.onopen = () => {
        backoff = 1000; // reset backoff on successful connection
        console.log('[CuiLite WS] Connected');
        // Server is back — reset circuit breaker and poll immediately
        circuitOpenRef.current = false;
        pollFailCountRef.current = 0;
        if (sessionId) setTimeout(pollNow, 300);
        // Re-fetch templates (may have failed during server restart)
        loadTemplates();
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
          if (!raw.includes(selectedId)) return;
          const msg = JSON.parse(raw);
          if (msg.type === 'conv-attention' && (msg.accountId === selectedId || msg.key === selectedId)) {
            setAttention(msg.state);
            setAttentionReason(msg.reason);
            if (msg.state === 'needs_attention' && sessionId) {
              // Reset circuit breaker + poll immediately on attention change
              circuitOpenRef.current = false;
              pollFailCountRef.current = 0;
              setTimeout(pollNow, 500);
            }
          }
          if (msg.type === 'cui-state' && msg.cuiId === selectedId) {
            // Any state change from WS means binary is alive — reset circuit breaker
            circuitOpenRef.current = false;
            pollFailCountRef.current = 0;
            if (msg.state === 'processing') {
              setAttention('working');
              setAttentionReason(undefined);
              setRateLimitMessage(null);
            }
            if (msg.state === 'done') {
              // Don't overwrite rate_limit state — user needs to see it
              setAttention(prev => prev === 'needs_attention' ? prev : 'idle');
              setAttentionReason(prev => prev === 'rate_limit' ? prev : 'done');
              if (sessionId) {
                setTimeout(pollNow, 500);
              }
            }
            if (msg.state === "error" && msg.message) {
              setAttention("needs_attention");
              setAttentionReason("rate_limit");
              setRateLimitMessage(msg.message);
              if (sessionId) setTimeout(pollNow, 1000);
            }
          }
          // Queue refresh on state changes
          if ((msg.type === 'cui-state' || msg.type === 'cui-response-ready') && msg.cuiId === selectedId) {
            setQueueRefresh(n => n + 1);
          }
        } catch (err) {
          console.warn('[CuiLite] WS parse error:', (err as Error).message);
        }
      };
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, [selectedId, isTabVisible, sessionId, pollNow, loadTemplates]);

  // Auto-scroll only when user is near bottom (not scrolled up reading)
  useEffect(() => {
    if (!userScrolledUpRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  // Listen for "All Live" broadcast from workspace toolbar
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.live !== undefined) setLiveMode(detail.live);
    };
    window.addEventListener('cui-all-live', handler);
    return () => window.removeEventListener('cui-all-live', handler);
  }, []);

  // --- Handlers ---

  // --- Auto-Inject (Loop) Sync ---
  const syncLoopState = useCallback(async () => {
    if ((window as any).__cuiServerAlive === false) return;
    try {
      const r = await fetch("/api/auto-inject", { signal: AbortSignal.timeout(5000) });
      const state = await r.json();
      const cfg = state.configs?.[selectedId || ""];
      if (cfg) {
        setLoopEnabled(cfg.enabled);
        setLoopIntervalMin(Math.round(cfg.intervalMs / 60000));
        setLoopMessage(cfg.message);
      } else {
        setLoopEnabled(false);
      }
      const lastTs = state.lastInject?.[selectedId || ""];
      setLastInjectTime(lastTs || null);
    } catch {}
  }, [selectedId]);

  useEffect(() => { syncLoopState(); }, [syncLoopState]);

  const toggleLoop = useCallback(async (enable: boolean) => {
    if (!selectedId || !sessionId) return;
    try {
      if (enable) {
        await fetch("/api/auto-inject", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(8000),
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
          signal: AbortSignal.timeout(8000),
          body: JSON.stringify({ accountId: selectedId, enabled: false }),
        });
      }
      setLoopEnabled(enable);
      syncLoopState();
    } catch (err) { console.warn('[CuiLite] Loop toggle error:', (err as Error).message); }
  }, [selectedId, sessionId, workDir, loopMessage, loopIntervalMin, syncLoopState]);

  const saveLoopConfig = useCallback(async () => {
    if (!selectedId) return;
    try {
      await fetch("/api/auto-inject", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(8000),
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
    try {
      if (editingTemplate) {
        const resp = await fetch(`/api/prompt-templates/${editingTemplate.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: newTplLabel, message: newTplMessage }),
          signal: AbortSignal.timeout(8000),
        });
        if (resp.ok) {
          const data = await resp.json();
          setReplyTemplates(prev => prev.map(t => t.id === data.template.id ? data.template : t));
        }
      } else {
        const resp = await fetch('/api/prompt-templates', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: newTplLabel, message: newTplMessage, category: 'reply' }),
          signal: AbortSignal.timeout(8000),
        });
        if (resp.ok) {
          const data = await resp.json();
          setReplyTemplates(prev => [...prev, data.template]);
        }
      }
    } catch (err) { console.warn('[CuiLite] Save template error:', (err as Error).message); }
    setShowTemplateForm(false);
    setEditingTemplate(null);
    setNewTplLabel('');
    setNewTplMessage('');
  }, [newTplLabel, newTplMessage, editingTemplate]);

  const handleDeleteTemplate = useCallback(async (id: string) => {
    try {
      const resp = await fetch(`/api/prompt-templates/${id}`, { method: 'DELETE', signal: AbortSignal.timeout(8000) });
      if (resp.ok) setReplyTemplates(prev => prev.filter(t => t.id !== id));
    } catch (err) { console.warn('[CuiLite] Delete template error:', (err as Error).message); }
  }, []);

  const handleSend = useCallback(async (overrideMessage?: string) => {
    const rawMsg = overrideMessage || input.trim();
    if (!rawMsg || !sessionId) return;
    if ((window as any).__cuiServerAlive === false) {
      setMessages(prev => [...prev, { role: 'system', content: 'Server nicht erreichbar — bitte warten bis Verbindung wiederhergestellt ist.', timestamp: new Date().toISOString() }]);
      return;
    }
    setIsLoading(true);
    const msg = (!overrideMessage && planMode) ? `Bitte verwende Plan-Modus: ${rawMsg}` : rawMsg;
    if (!overrideMessage) setInput('');
    if (!overrideMessage && planMode) setPlanMode(false);
    setMessages(prev => [...prev, { role: 'user', content: msg, timestamp: new Date().toISOString() }]);
    setIsAgentDone(false);
    setAttentionReason(undefined);
            setRateLimitMessage(null);
    try {
      const resp = await fetch('/api/mission/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: selectedId, sessionId, message: msg, workDir }),
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
        setMessages(prev => [...prev, { role: 'system', content: `Fehler: ${errData.error || 'Senden fehlgeschlagen'}`, timestamp: new Date().toISOString() }]);
      } else {
        const data = await resp.json().catch(() => ({}));
        // Server auto-recovered from broken resume → switch to new session
        if (data.resumeFailed && data.sessionId) {
          console.log(`[CuiLite] Resume failed, switched to new session: ${data.sessionId}`);
          setSessionId(data.sessionId);
          if (persistSession) try { localStorage.setItem(getSessionKey(selectedId), data.sessionId); } catch {}
          onRouteChange?.(`/c/${data.sessionId}`);
          setMessages([{ role: 'system', content: 'Neue Session gestartet (alte Session konnte nicht fortgesetzt werden)', timestamp: new Date().toISOString() }, { role: 'user', content: msg, timestamp: new Date().toISOString() }]);
        }
      }
    } catch (err) {
      console.error('[CuiLite] Send error:', err);
      const errMsg = err instanceof DOMException && err.name === 'TimeoutError' ? 'Timeout — Server antwortet nicht' : String(err);
      setMessages(prev => [...prev, { role: 'system', content: `Netzwerkfehler: ${errMsg}`, timestamp: new Date().toISOString() }]);
    }
    setIsLoading(false);
    // Single delayed poll — WS will handle the rest via cui-state/done events
    setTimeout(pollNow, 2000);
  }, [input, sessionId, selectedId, workDir, planMode, pollNow, onRouteChange]);

  // Respond to tool_use blocks (AskUserQuestion, ExitPlanMode, EnterPlanMode)
  const handleRespond = useCallback(async (text: string) => {
    if (!sessionId) return;
    setIsLoading(true);
    setMessages(prev => [...prev, { role: 'user', content: text, timestamp: new Date().toISOString() }]);
    try {
      const resp = await fetch('/api/mission/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: selectedId, sessionId, message: text, workDir }),
        signal: AbortSignal.timeout(15000),
      });
      if (resp.ok) {
        const data = await resp.json().catch(() => ({}));
        if (data.resumeFailed && data.sessionId) {
          console.log(`[CuiLite] Respond: resume failed, new session: ${data.sessionId}`);
          setSessionId(data.sessionId);
          if (persistSession) try { localStorage.setItem(getSessionKey(selectedId), data.sessionId); } catch {}
          onRouteChange?.(`/c/${data.sessionId}`);
        }
      }
    } catch (err) {
      console.error('[CuiLite] Respond error:', err);
    }
    setIsLoading(false);
    setTimeout(pollNow, 1000);
  }, [sessionId, selectedId, workDir, pollNow, onRouteChange]);

  const handlePermission = useCallback(async (permId: string, action: 'approve' | 'deny') => {
    try {
      await fetch(`/api/mission/permissions/${selectedId}/${permId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
        signal: AbortSignal.timeout(10000),
      });
      setTimeout(pollNow, 500);
    } catch (err) {
      console.error('[CuiLite] Permission error:', err);
    }
  }, [selectedId, pollNow]);

  const handleStop = useCallback(async () => {
    if (!sessionId) return;
    try {
      const resp = await fetch(`/api/mission/conversation/${selectedId}/${sessionId}/stop`, { method: 'POST', signal: AbortSignal.timeout(10000) });
      const data = await resp.json().catch(() => ({}));
      setAttention('idle');
      setAttentionReason('done');
      setConvStatus('completed');
      if (!data.apiStopOk && !data.childrenKilled) {
        console.warn('[CuiLite] Stop: API stop failed and no children killed — agent may still be running');
      }
      console.log(`[CuiLite] Stop: apiStopOk=${data.apiStopOk}, streamingId=${data.streamingId?.slice(0,8)}, killed=${data.childrenKilled}`);
      setTimeout(pollNow, 500);
    } catch (err) {
      console.error('[CuiLite] Stop error:', err);
    }
  }, [sessionId, selectedId, pollNow]);

  const handleQueueNavigate = useCallback((sid: string) => {
    setSessionId(sid);
    setShowQueue(false);
    setMessages([]);
    setPermissions([]);
    setAttention('idle');
    setAttentionReason(undefined);
            setRateLimitMessage(null);
    if (persistSession) try { localStorage.setItem(getSessionKey(selectedId), sid); } catch {}
    onRouteChange?.(`/c/${sid}`);
  }, [onRouteChange, selectedId, persistSession]);

  const handleStartNew = useCallback(async (subject: string, message: string) => {
    try {
      const resp = await fetch('/api/mission/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: selectedId, message, workDir, subject }),
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) return false;
      const data = await resp.json();
      setSessionId(data.sessionId);
      setShowQueue(false);
      setMessages([]);
      if (persistSession) try { localStorage.setItem(getSessionKey(selectedId), data.sessionId); } catch {}
      onRouteChange?.(`/c/${data.sessionId}`);
      return true;
    } catch {
      return false;
    }
  }, [selectedId, workDir, onRouteChange, persistSession]);

  const handleBack = useCallback(() => {
    setSessionId(null);
    setShowQueue(true);
    setMessages([]);
    setPermissions([]);
    setConvName('');
    setAttention('idle');
    setAttentionReason(undefined);
            setRateLimitMessage(null);
    setLiveMode(false);
    if (persistSession) try { localStorage.removeItem(getSessionKey(selectedId)); } catch {}
    onRouteChange?.('');
  }, [onRouteChange, persistSession]);

  // --- Render ---
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--tn-surface)', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px',
        background: 'var(--tn-bg-dark)', borderBottom: '1px solid var(--tn-border)',
        height: 30, flexShrink: 0,
      }}>
        <div style={{
          width: 8, height: 8, borderRadius: '50%',
          background: attention === 'working' ? '#3B82F6'
            : attention === 'needs_attention' ? '#F59E0B'
            : (isAgentDone && attentionReason === 'done') ? '#9ece6a'
            : convStatus === 'ongoing' ? '#9ece6a'
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
              fetch(`/api/mission/conversation/${sessionId}/assign`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ accountId: newAcct }),
              }).catch(() => {});
              // Save session for BOTH old and new account
              if (persistSession) {
                try { localStorage.setItem(getSessionKey(selectedId), sessionId); } catch {}
                try { localStorage.setItem(getSessionKey(newAcct), sessionId); } catch {}
              }
              setSelectedId(newAcct);
              // Keep sessionId, messages, and chat view — just switch account
              setMessages(prev => [...prev, { role: 'system', content: `Account gewechselt → ${ACCOUNTS.find(a => a.id === newAcct)?.label || newAcct}`, timestamp: new Date().toISOString() }]);
              setAttention('idle');
              setAttentionReason(undefined);
              setRateLimitMessage(null);
              try { localStorage.setItem(storageKey, newAcct); } catch {}
            } else {
              // No chat open (queue view) — normal switch
              let savedSession: string | null = null;
              try { savedSession = localStorage.getItem(getSessionKey(newAcct)); } catch {}
              setSelectedId(newAcct);
              setSessionId(savedSession);
              setShowQueue(!savedSession);
              setMessages([]);
              setAttention('idle');
              setAttentionReason(undefined);
              setRateLimitMessage(null);
              setLiveMode(false);
              try { localStorage.setItem(storageKey, newAcct); } catch {}
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
          <span style={{ fontSize: 9, color: '#3B82F6', fontWeight: 600, opacity: 0.8, display: 'flex', alignItems: 'center', gap: 3 }}>
            <span style={{ display: 'inline-block', width: 5, height: 5, borderRadius: '50%', background: '#3B82F6', animation: 'q-pulse 1s ease-in-out infinite' }} />
            arbeitet
          </span>
        )}
        {attention === 'idle' && isAgentDone && sessionId && attentionReason === 'done' && (
          <span style={{ fontSize: 9, color: '#9ece6a', fontWeight: 600 }}>Fertig</span>
        )}
        {attention === 'needs_attention' && sessionId && (
          <span style={{ fontSize: 9, color: '#F59E0B', fontWeight: 600 }}>
            {attentionReason === 'plan' ? 'Plan' : attentionReason === 'question' ? 'Frage' : attentionReason === 'rate_limit' ? 'Rate Limit' : attentionReason === 'error' ? 'Fehler' : attentionReason === 'done' ? 'Fertig' : 'Aktion'}
          </span>
        )}

        {/* Back to queue - prominent */}
        {sessionId && (
          <button onClick={handleBack} title="Zurück zur Konversationsliste" style={{
            background: 'var(--tn-bg)', color: 'var(--tn-text)',
            border: '1px solid var(--tn-border)', borderRadius: 4,
            padding: '1px 6px', fontSize: 12, cursor: 'pointer', fontWeight: 600,
          }}>
            &larr;
          </button>
        )}

        {/* Spacer - title moved below header */}
        <span style={{ flex: 1 }} />

        {/* Live toggle */}
        {sessionId && (
          <button
            onClick={() => setLiveMode(!liveMode)}
            title={liveMode ? 'Live-Modus aus (zurueck zu 15s)' : 'Live-Modus an (2s Polling)'}
            style={{
              background: liveMode ? 'rgba(239,68,68,0.15)' : 'var(--tn-bg)',
              color: liveMode ? '#EF4444' : 'var(--tn-text-muted)',
              border: `1px solid ${liveMode ? '#EF4444' : 'var(--tn-border)'}`,
              borderRadius: 4, padding: '1px 8px', fontSize: 10, cursor: 'pointer',
              fontWeight: liveMode ? 700 : 400,
            }}
          >
            {liveMode ? 'Live' : 'Live'}
          </button>
        )}

        {/* Manual refresh */}
        {sessionId && !liveMode && (
          <button onClick={() => pollNow()} style={{
            background: 'var(--tn-bg)', color: 'var(--tn-text-muted)',
            border: '1px solid var(--tn-border)', borderRadius: 4,
            padding: '1px 8px', fontSize: 10, cursor: 'pointer',
          }}>
            Refresh
          </button>
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
            : 'rgba(239,68,68,0.12)',
          borderBottom: '1px solid var(--tn-border)',
          display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0,
        }}>
          <span style={{
            fontSize: 12, fontWeight: 700,
            color: attentionReason === 'plan' ? '#F59E0B'
              : attentionReason === 'question' ? '#3B82F6'
              : attentionReason === 'rate_limit' ? '#EF4444'
              : '#EF4444',
          }}>
            {attentionReason === 'plan' ? 'Plan wartet auf Freigabe'
              : attentionReason === 'question' ? 'Claude hat eine Frage'
              : attentionReason === 'rate_limit' ? 'Rate Limit — Account hat das Nutzungslimit erreicht. Anderen Account verwenden!'
              : attentionReason === 'error' ? 'Fehler aufgetreten'
              : 'Aktion erforderlich'}
          </span>
          <span style={{ flex: 1 }} />
          <button onClick={() => pollNow()} style={{
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
              // "Near bottom" = within 80px of the end
              userScrolledUpRef.current = el.scrollTop + el.clientHeight < el.scrollHeight - 80;
            }}
            style={{ flex: 1, overflow: 'auto', minHeight: 0 }}
          >
            {messages.length === 0 && (
              <LoadingConversation sessionId={sessionId} onBack={() => { setSessionId(null); setShowQueue(true); }} onRetry={pollNow} onLoadFailed={onLoadFailed} />
            )}
            {messages.map((msg, i) => (
              <MessageRow key={i} msg={msg} onRespond={handleRespond} isLast={i === messages.length - 1} workDir={workDir} />
            ))}
            <div ref={messagesEndRef} />
          </div>

          {/* Input Bar */}
          <div style={{
            padding: '8px 12px', borderTop: '1px solid var(--tn-border)',
            background: 'var(--tn-bg-dark)', flexShrink: 0,
          }}>
            {planMode && (
              <div style={{ fontSize: 11, color: '#F59E0B', marginBottom: 4, fontWeight: 600 }}>
                Plan-Modus aktiv — Claude plant zuerst
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
                <button
                  onClick={() => { setShowTemplateForm(true); setEditingTemplate(null); setNewTplLabel(''); setNewTplMessage(''); }}
                  title="Neues Template erstellen"
                  style={{ padding: '4px 10px', borderRadius: 4, fontSize: 11, cursor: 'pointer', background: 'transparent', border: '1px dashed var(--tn-border)', color: 'var(--tn-text-muted)', opacity: 0.6, alignSelf: 'stretch', display: 'flex', alignItems: 'center' }}
                >
                  + Neu
                </button>
              </div>
            )}
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
                <textarea value={loopMessage} onChange={e => setLoopMessage(e.target.value)} placeholder="Auto-Inject Nachricht..." rows={2} style={{ width: "100%", padding: "4px 6px", fontSize: 10, background: "var(--tn-bg-dark)", color: "var(--tn-text)", border: "1px solid var(--tn-border)", borderRadius: 3, fontFamily: "inherit", resize: "vertical", minHeight: 36, boxSizing: "border-box", lineHeight: "1.3" }} />
                {lastInjectTime && <div style={{ fontSize: 9, color: "var(--tn-text-muted)", marginTop: 2 }}>Letzter Inject: {new Date(lastInjectTime).toLocaleTimeString("de-DE")}</div>}
              </div>
            )}
            <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}>
              <button
                onClick={() => setPlanMode(!planMode)}
                title="Plan-Modus: Claude plant zuerst"
                style={{
                  padding: '6px 8px', borderRadius: 4, cursor: 'pointer', flexShrink: 0,
                  background: planMode ? 'rgba(245,158,11,0.15)' : 'var(--tn-bg)',
                  border: `1px solid ${planMode ? '#F59E0B' : 'var(--tn-border)'}`,
                  color: planMode ? '#F59E0B' : 'var(--tn-text-muted)',
                  fontSize: 11, fontWeight: planMode ? 700 : 400,
                }}
              >
                Plan
              </button>
              <button
                onClick={() => { if (loopEnabled) { toggleLoop(false); } else { setShowLoopConfig(!showLoopConfig); } }}
                title={loopEnabled ? "Loop stoppen" : "Auto-Inject Loop konfigurieren"}
                style={{
                  padding: "6px 8px", borderRadius: 4, cursor: "pointer", flexShrink: 0,
                  background: loopEnabled ? "rgba(16,185,129,0.15)" : "var(--tn-bg)",
                  border: `1px solid ${loopEnabled ? "#10B981" : "var(--tn-border)"}`,
                  color: loopEnabled ? "#10B981" : "var(--tn-text-muted)",
                  fontSize: 11, fontWeight: loopEnabled ? 700 : 400,
                }}
              >
                {loopEnabled ? "Loop u25CF" : "Loop"}
              </button>
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
                placeholder={planMode ? 'Aufgabe beschreiben... (Plan-Modus)' : 'Nachricht... (Enter = Senden)'}
                rows={1}
                style={{
                  flex: 1, resize: 'none', padding: '6px 10px', fontSize: 13,
                  background: 'var(--tn-bg)', color: 'var(--tn-text)',
                  border: `1px solid ${planMode ? '#F59E0B' : 'var(--tn-border)'}`, borderRadius: 4,
                  fontFamily: 'inherit', maxHeight: 120, minHeight: 32,
                }}
              />
              <button
                onClick={handleStop}
                title="Konversation stoppen"
                style={{
                  padding: '6px 8px', borderRadius: 4, fontSize: 12, cursor: 'pointer', flexShrink: 0,
                  background: (convStatus === 'ongoing' || attention === 'working') ? '#EF4444' : 'var(--tn-bg)',
                  border: `1px solid ${(convStatus === 'ongoing' || attention === 'working') ? '#EF4444' : 'var(--tn-border)'}`,
                  color: (convStatus === 'ongoing' || attention === 'working') ? '#fff' : 'var(--tn-text-muted)',
                  fontWeight: 600,
                }}
              >
                Stop
              </button>
              <button
                onClick={() => handleSend()}
                disabled={!input.trim() || isLoading}
                style={{
                  padding: '6px 14px', borderRadius: 4, fontSize: 12, cursor: 'pointer',
                  background: input.trim() && !isLoading ? (planMode ? '#F59E0B' : '#3B82F6') : 'var(--tn-border)',
                  border: 'none', color: '#fff', fontWeight: 600,
                  opacity: input.trim() && !isLoading ? 1 : 0.5,
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
