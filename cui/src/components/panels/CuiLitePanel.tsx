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
  role: 'user' | 'assistant' | 'system';
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
function ToolUseBlock({ block, onRespond }: { block: ContentBlock; onRespond?: (text: string) => void }) {
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
    // Extract allowed prompts if available
    const allowedPrompts = block.input?.allowedPrompts as Array<{ tool: string; prompt: string }> | undefined;

    return (
      <div style={{ margin: '8px 0', padding: '10px 14px', background: 'rgba(245,158,11,0.08)', borderRadius: 6, border: '1px solid rgba(245,158,11,0.2)' }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: '#F59E0B', marginBottom: 8 }}>
          Plan bereit zur Freigabe
        </div>
        {/* Show allowed prompts if available */}
        {allowedPrompts && allowedPrompts.length > 0 && (
          <details style={{ marginBottom: 8 }} open>
            <summary style={{ fontSize: 11, color: '#F59E0B', cursor: 'pointer', marginBottom: 4 }}>
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
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={() => onRespond?.('yes')}
            style={{ padding: '6px 16px', borderRadius: 4, cursor: 'pointer', background: '#10B981', border: 'none', color: '#fff', fontSize: 12, fontWeight: 600 }}
          >
            Freigeben
          </button>
          <button
            onClick={() => onRespond?.('no, please revise the plan')}
            style={{ padding: '6px 16px', borderRadius: 4, cursor: 'pointer', background: '#EF4444', border: 'none', color: '#fff', fontSize: 12, fontWeight: 600 }}
          >
            Ablehnen
          </button>
        </div>
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
function MessageRow({ msg, onRespond, isLast }: { msg: Message; onRespond?: (text: string) => void; isLast: boolean }) {
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

  // Detect if message contains ExitPlanMode to style plan text
  const hasExitPlan = toolUseBlocks.some(b => b.name === 'ExitPlanMode');

  return (
    <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--tn-border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{
          fontSize: 11, fontWeight: 600, textTransform: 'uppercase',
          color: msg.role === 'assistant' ? 'var(--tn-green)' : 'var(--tn-blue)',
        }}>
          {msg.role === 'assistant' ? 'Claude' : 'User'}
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
        <ToolUseBlock key={i} block={block} onRespond={onRespond} />
      ))}
    </div>
  );
}

// --- Main Component ---
export default function CuiLitePanel({ accountId, projectId, workDir, panelId, isTabVisible = true, onRouteChange }: CuiLitePanelProps) {
  const storageKey = `cui-lite-account-${panelId || projectId || 'default'}`;

  const getSessionKey = (acctId: string) => `cui-lite-session-${panelId || projectId || 'default'}-${acctId}`;

  // Resolve initial account: localStorage > prop > first account (user's switch must survive reload)
  const initialAccount = (() => { try { return localStorage.getItem(storageKey) || accountId || ACCOUNTS[0].id; } catch { return accountId || ACCOUNTS[0].id; } })();

  const [selectedId, setSelectedId] = useState(initialAccount);
  const [sessionId, setSessionId] = useState<string | null>(() => {
    try { return localStorage.getItem(getSessionKey(initialAccount)); } catch { return null; }
  });
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [convStatus, setConvStatus] = useState<'ongoing' | 'completed'>('completed');
  const [showQueue, setShowQueue] = useState(() => !localStorage.getItem(getSessionKey(initialAccount)));
  const [queueRefresh, setQueueRefresh] = useState(0);
  const [attention, setAttention] = useState<'idle' | 'working' | 'needs_attention'>('idle');
  const [attentionReason, setAttentionReason] = useState<string | undefined>();
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [convName, setConvName] = useState('');
  const [planMode, setPlanMode] = useState(false);
  const [liveMode, setLiveMode] = useState(false);
  const [isAgentDone, setIsAgentDone] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const userScrolledUpRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const account = ACCOUNTS.find(a => a.id === selectedId) || ACCOUNTS[0];
  const pollInterval = liveMode ? 2000 : 15000;

  // --- Polling ---
  const pollNow = useCallback(async () => {
    if (!sessionId) return;
    try {
      const [convResp, statesResp] = await Promise.all([
        fetch(`/api/mission/conversation/${selectedId}/${sessionId}?tail=50`),
        fetch('/api/mission/states'),
      ]);
      if (convResp.ok) {
        const data = await convResp.json();
        setMessages(data.messages || []);
        setConvStatus(data.status === 'ongoing' ? 'ongoing' : 'completed');
        setPermissions(data.permissions || []);
        setConvName(data.summary || '');
        setIsAgentDone(!!data.isAgentDone);
        // If server reports rateLimited but state doesn't reflect it yet, show it
        if (data.rateLimited && attention !== 'needs_attention') {
          setAttention('needs_attention');
          setAttentionReason('rate_limit');
        }
      }
      if (statesResp.ok) {
        const states = await statesResp.json();
        const myState = states[selectedId];
        if (myState) {
          setAttention(myState.state || 'idle');
          setAttentionReason(myState.reason);
        } else {
          setAttention('idle');
          setAttentionReason(undefined);
        }
      }
    } catch (err) {
      console.error('[CuiLite] Poll error:', err);
    }
  }, [sessionId, selectedId]);

  // Polling interval (2s live, 15s normal) — auto-off live when tab hidden
  useEffect(() => {
    if (!sessionId || !isTabVisible) {
      if (!isTabVisible && liveMode) setLiveMode(false);
      return;
    }
    pollNow();
    pollTimerRef.current = setInterval(pollNow, pollInterval);
    return () => { if (pollTimerRef.current) clearInterval(pollTimerRef.current); };
  }, [sessionId, selectedId, isTabVisible, pollNow, pollInterval]);

  // --- WS for realtime attention events ---
  useEffect(() => {
    if (!isTabVisible) return;
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${protocol}://${window.location.host}/ws`);

    ws.onmessage = (e) => {
      try {
        const raw = e.data as string;
        if (!raw.includes(selectedId)) return;
        const msg = JSON.parse(raw);
        if (msg.type === 'conv-attention' && (msg.accountId === selectedId || msg.key === selectedId)) {
          setAttention(msg.state);
          setAttentionReason(msg.reason);
          if (msg.state === 'needs_attention' && sessionId) {
            // Immediate poll on attention change
            setTimeout(pollNow, 500);
          }
        }
        if (msg.type === 'cui-state' && msg.cuiId === selectedId) {
          if (msg.state === 'processing') {
            setAttention('working');
            setAttentionReason(undefined);
          }
          if (msg.state === 'done') {
            setAttention('idle');
            setAttentionReason('done');
            if (sessionId) {
              // Triple-poll to reliably catch the final response
              setTimeout(pollNow, 500);
              setTimeout(pollNow, 2000);
              setTimeout(pollNow, 5000);
            }
          }
        }
        // Queue refresh on state changes
        if ((msg.type === 'cui-state' || msg.type === 'cui-response-ready') && msg.cuiId === selectedId) {
          setQueueRefresh(n => n + 1);
        }
      } catch { /* ignore */ }
    };

    return () => ws.close();
  }, [selectedId, isTabVisible, sessionId, pollNow]);

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
  const handleSend = useCallback(async () => {
    if (!input.trim() || !sessionId) return;
    setIsLoading(true);
    const rawMsg = input;
    const msg = planMode ? `Bitte verwende Plan-Modus: ${rawMsg}` : rawMsg;
    setInput('');
    if (planMode) setPlanMode(false);
    setMessages(prev => [...prev, { role: 'user', content: msg, timestamp: new Date().toISOString() }]);
    setIsAgentDone(false);
    setAttentionReason(undefined);
    try {
      const resp = await fetch('/api/mission/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: selectedId, sessionId, message: msg, workDir }),
      });
      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
        setMessages(prev => [...prev, { role: 'system', content: `Fehler: ${errData.error || 'Senden fehlgeschlagen'}`, timestamp: new Date().toISOString() }]);
      }
    } catch (err) {
      console.error('[CuiLite] Send error:', err);
      setMessages(prev => [...prev, { role: 'system', content: `Netzwerkfehler: ${err}`, timestamp: new Date().toISOString() }]);
    }
    setIsLoading(false);
    // Poll immediately to get response status (don't wait 15s)
    setTimeout(pollNow, 2000);
    setTimeout(pollNow, 5000);
    setTimeout(pollNow, 10000);
    setTimeout(pollNow, 20000);
  }, [input, sessionId, selectedId, workDir, planMode, pollNow]);

  // Respond to tool_use blocks (AskUserQuestion, ExitPlanMode, EnterPlanMode)
  const handleRespond = useCallback(async (text: string) => {
    if (!sessionId) return;
    setIsLoading(true);
    setMessages(prev => [...prev, { role: 'user', content: text, timestamp: new Date().toISOString() }]);
    try {
      await fetch('/api/mission/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: selectedId, sessionId, message: text, workDir }),
      });
    } catch (err) {
      console.error('[CuiLite] Respond error:', err);
    }
    setIsLoading(false);
    setTimeout(pollNow, 1000);
  }, [sessionId, selectedId, workDir, pollNow]);

  const handlePermission = useCallback(async (permId: string, action: 'approve' | 'deny') => {
    try {
      await fetch(`/api/mission/permissions/${selectedId}/${permId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      setTimeout(pollNow, 500);
    } catch (err) {
      console.error('[CuiLite] Permission error:', err);
    }
  }, [selectedId, pollNow]);

  const handleStop = useCallback(async () => {
    if (!sessionId) return;
    try {
      await fetch(`/api/mission/conversation/${selectedId}/${sessionId}/stop`, { method: 'POST' });
      setAttention('idle');
      setAttentionReason('done');
      setConvStatus('completed');
      setTimeout(pollNow, 1000);
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
    try { localStorage.setItem(getSessionKey(selectedId), sid); } catch {}
    onRouteChange?.(`/c/${sid}`);
  }, [onRouteChange, selectedId]);

  const handleStartNew = useCallback(async (subject: string, message: string) => {
    try {
      const resp = await fetch('/api/mission/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: selectedId, message, workDir, subject }),
      });
      if (!resp.ok) return false;
      const data = await resp.json();
      setSessionId(data.sessionId);
      setShowQueue(false);
      setMessages([]);
      try { localStorage.setItem(getSessionKey(selectedId), data.sessionId); } catch {}
      onRouteChange?.(`/c/${data.sessionId}`);
      return true;
    } catch {
      return false;
    }
  }, [selectedId, workDir, onRouteChange]);

  const handleBack = useCallback(() => {
    setSessionId(null);
    setShowQueue(true);
    setMessages([]);
    setPermissions([]);
    setConvName('');
    setAttention('idle');
    setAttentionReason(undefined);
    setLiveMode(false);
    try { localStorage.removeItem(getSessionKey(selectedId)); } catch {}
    onRouteChange?.('');
  }, [onRouteChange]);

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
            // Save current session for old account
            if (sessionId) {
              try { localStorage.setItem(getSessionKey(selectedId), sessionId); } catch {}
            }
            // Load session for new account
            let savedSession: string | null = null;
            try { savedSession = localStorage.getItem(getSessionKey(newAcct)); } catch {}
            setSelectedId(newAcct);
            setSessionId(savedSession);
            setShowQueue(!savedSession);
            setMessages([]);
            setAttention('idle');
            setAttentionReason(undefined);
            setLiveMode(false);
            try { localStorage.setItem(storageKey, newAcct); } catch {}
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
              : attentionReason === 'rate_limit' ? 'Rate Limit — Warte und versuche erneut'
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
              <div style={{ textAlign: 'center', color: 'var(--tn-text-muted)', marginTop: 40, fontSize: 13 }}>
                Lade Konversation...
              </div>
            )}
            {messages.map((msg, i) => (
              <MessageRow key={i} msg={msg} onRespond={handleRespond} isLast={i === messages.length - 1} />
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
                onClick={handleSend}
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
