import { useState, useRef, useEffect, useCallback } from 'react';
import { ACCOUNTS, getCuiUrl } from '../../types';
import QueueOverlay from './QueueOverlay';

const REMOTE_ACCOUNTS = new Set(['rafael', 'engelmann', 'office']);

interface CuiPanelProps {
  accountId?: string;
  projectId?: string;
  workDir?: string;
  panelId?: string;
}

export default function CuiPanel({ accountId, projectId, workDir, panelId }: CuiPanelProps) {
  const storageKey = `cui-account-${panelId || projectId || 'default'}`;
  const [selectedId, setSelectedId] = useState(() => {
    if (accountId) return accountId;
    try { return localStorage.getItem(storageKey) || ACCOUNTS[0].id; } catch { return ACCOUNTS[0].id; }
  });
  const [iframeSrc, setIframeSrc] = useState('');
  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading');
  const [dragOver, setDragOver] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [cuiOnHome, setCuiOnHome] = useState(true);  // Track if CUI is on home/queue page
  const [showQueue, setShowQueue] = useState(true);   // User toggle for queue overlay
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(null);
  const savedRouteRef = useRef<string>('');
  // Stable unique ID per panel instance (survives re-renders but not remounts)
  const instanceId = useRef(panelId || Math.random().toString(36).slice(2, 8));

  const account = ACCOUNTS.find((a) => a.id === selectedId) ?? ACCOUNTS[0];
  const isRemote = REMOTE_ACCOUNTS.has(selectedId);

  // Route key per panel INSTANCE (not just per account) to avoid collision when same account appears twice
  const routeKey = `cui-route-${selectedId}-${projectId ?? 'default'}-${instanceId.current}`;

  // Build iframe URL with ?cwd= parameter for working directory enforcement
  const buildIframeUrl = useCallback((base: string, path: string = '') => {
    const params = new URLSearchParams();
    if (workDir) params.set('cwd', workDir);
    if (projectId) params.set('project', projectId);
    const qs = params.toString();
    if (path) {
      const separator = path.includes('?') ? '&' : '?';
      return qs ? `${base}${path}${separator}${qs}` : `${base}${path}`;
    }
    return qs ? `${base}/?${qs}` : base;
  }, [workDir, projectId]);

  // Listen for route changes from THIS panel's CUI iframe only
  useEffect(() => {
    function handleMessage(e: MessageEvent) {
      // Only accept messages from our own iframe (not other CUI panels)
      if (e.source !== iframeRef.current?.contentWindow) return;
      if (e.data?.type === 'cui-route') {
        const pathname = e.data.pathname || '/';
        if (pathname.startsWith('/c/')) {
          // In a conversation - save route for reload persistence
          savedRouteRef.current = pathname;
          setCuiOnHome(false);
          setShowQueue(false);
          try { localStorage.setItem(routeKey, pathname); } catch {}
        } else {
          // On home/overview page - show queue overlay
          savedRouteRef.current = '';
          setCuiOnHome(true);
          setShowQueue(true);
          try { localStorage.removeItem(routeKey); } catch {}
        }
      }
    }
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [routeKey]);

  // Fetch auth token from local proxy, then load iframe.
  // Restores last conversation route if available (per-panel).
  useEffect(() => {
    setStatus('loading');
    setIframeSrc('');
    const baseUrl = getCuiUrl(account);

    // Restore saved route for THIS specific panel (accountId + projectId)
    const savedRoute = localStorage.getItem(routeKey) || '';
    savedRouteRef.current = savedRoute;

    fetch(`${baseUrl}/api/config`)
      .then((res) => res.json())
      .then((config) => {
        const token = config.authToken;
        if (token && token.length === 32 && /^[a-f0-9]+$/.test(token)) {
          const expires = new Date();
          expires.setDate(expires.getDate() + 7);
          document.cookie = `cui-auth-token=${token}; expires=${expires.toUTCString()}; path=/; SameSite=Lax`;
        }
        // Restore conversation or start at home
        setIframeSrc(buildIframeUrl(baseUrl, savedRoute));
        setStatus('ok');
      })
      .catch(() => {
        setIframeSrc(buildIframeUrl(baseUrl, savedRoute));
        setStatus('error');
      });
  }, [selectedId, buildIframeUrl, routeKey]);

  // Auto-refresh + Control API: listen for WS commands
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${protocol}://${window.location.host}/ws`);
    let reloadTimer: ReturnType<typeof setTimeout> | null = null;

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        // Auto-refresh when CUI response is ready
        if (msg.type === 'cui-response-ready' && msg.cuiId === selectedId) {
          if (reloadTimer) clearTimeout(reloadTimer);
          reloadTimer = setTimeout(() => {
            if (iframeRef.current?.contentWindow) {
              iframeRef.current.contentWindow.postMessage({ type: 'cui-refresh' }, '*');
            }
          }, 1500);
        }
        // Control API commands
        if (msg.cuiId === selectedId || msg.cuiId === 'all') {
          if (msg.type === 'control:cui-reload') {
            handleReloadRef.current();
          }
          if (msg.type === 'control:cui-new-conversation') {
            handleNewConversationRef.current();
          }
          if (msg.type === 'control:cui-set-cwd' && msg.cwd) {
            if (iframeRef.current?.contentWindow) {
              iframeRef.current.contentWindow.postMessage({ type: 'cui-set-cwd', cwd: msg.cwd }, '*');
            }
          }
        }
      } catch { /* ignore */ }
    };

    return () => {
      if (reloadTimer) clearTimeout(reloadTimer);
      ws.close();
    };
  }, [selectedId]);

  // --- Image upload ---
  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  }, []);

  const uploadImage = useCallback(async (file: File) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      const base64 = e.target?.result as string;
      try {
        const res = await fetch('/api/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: base64, filename: file.name }),
        });
        const { path, url } = await res.json();

        if (isRemote) {
          // Remote CUI can't read local files - copy the localhost URL
          const fullUrl = `${window.location.origin}${url}`;
          await navigator.clipboard.writeText(fullUrl);
          showToast(`Screenshot URL kopiert (Remote-Account)`);
        } else {
          // Local CUI can read local files directly
          await navigator.clipboard.writeText(path);
          showToast(`Screenshot-Pfad kopiert: ${path}`);
        }
      } catch (err) {
        console.error('[Upload] Failed:', err);
        showToast('Upload fehlgeschlagen!');
      }
    };
    reader.readAsDataURL(file);
  }, [isRemote, showToast]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);

    const files = e.dataTransfer.files;
    for (let i = 0; i < files.length; i++) {
      if (files[i].type.startsWith('image/')) {
        uploadImage(files[i]);
        return; // One at a time
      }
    }
  }, [uploadImage]);

  // Paste handler: intercept Cmd+V with image data on the container
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handlePaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith('image/')) {
          e.preventDefault();
          e.stopPropagation();
          const file = items[i].getAsFile();
          if (file) uploadImage(file);
          return;
        }
      }
    };

    container.addEventListener('paste', handlePaste);
    return () => container.removeEventListener('paste', handlePaste);
  }, [uploadImage]);

  // Use refs so WS handler can call these without stale closures
  const handleReloadRef = useRef(() => {});
  const handleNewConversationRef = useRef(() => {});

  function handleReload() {
    // Reload: keep current conversation route
    const route = savedRouteRef.current;
    setIframeSrc('');
    setTimeout(() => {
      setIframeSrc(buildIframeUrl(getCuiUrl(account), route));
    }, 50);
  }
  handleReloadRef.current = handleReload;

  function handleNewConversation() {
    // Clear saved route + force fresh CUI home page
    savedRouteRef.current = '';
    setCuiOnHome(true);
    setShowQueue(true);
    try { localStorage.removeItem(routeKey); } catch {}
    const baseUrl = getCuiUrl(account);
    setIframeSrc('');
    setTimeout(() => setIframeSrc(buildIframeUrl(baseUrl)), 50);
    if (iframeRef.current?.contentWindow) {
      iframeRef.current.contentWindow.postMessage({ type: 'cui-clear-session' }, '*');
    }
  }
  handleNewConversationRef.current = handleNewConversation;

  // Queue overlay: navigate CUI iframe to a specific conversation
  function handleQueueNavigate(sessionId: string) {
    const baseUrl = getCuiUrl(account);
    const route = `/c/${sessionId}`;
    savedRouteRef.current = route;
    setCuiOnHome(false);
    setShowQueue(false);
    try { sessionStorage.setItem(routeKey, route); } catch {}
    setIframeSrc('');
    setTimeout(() => setIframeSrc(buildIframeUrl(baseUrl, route)), 50);
  }

  // Queue overlay: start a new conversation with subject
  function handleQueueStartNew(subject: string, message: string) {
    fetch('/api/mission/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: selectedId,
        workDir: workDir || '/root',
        subject,
        message,
      }),
    })
      .then(r => r.json())
      .then(data => {
        if (data.sessionId) {
          // Navigate to the new conversation
          handleQueueNavigate(data.sessionId);
        }
      })
      .catch(() => {
        showToast('Fehler beim Starten der Konversation');
      });
  }

  function handlePopout() {
    window.open(iframeSrc || getCuiUrl(account), '_blank', 'width=1200,height=800,menubar=no,toolbar=no');
  }

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--tn-surface)', position: 'relative', outline: 'none' }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '4px 8px',
          background: 'var(--tn-bg-dark)',
          borderBottom: '1px solid var(--tn-border)',
          height: 30,
          flexShrink: 0,
        }}
      >
        <div
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: status === 'ok' ? account.color : status === 'loading' ? 'var(--tn-text-muted)' : 'var(--tn-red)',
          }}
        />
        <select
          value={selectedId}
          onChange={(e) => {
            setSelectedId(e.target.value);
            try { localStorage.setItem(storageKey, e.target.value); } catch {}
          }}
          style={{
            background: 'var(--tn-bg)',
            color: 'var(--tn-text)',
            border: '1px solid var(--tn-border)',
            borderRadius: 4,
            padding: '2px 6px',
            fontSize: 11,
            cursor: 'pointer',
          }}
        >
          {ACCOUNTS.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
        {isRemote && (
          <span style={{ fontSize: 9, color: 'var(--tn-text-muted)', opacity: 0.5 }}>remote</span>
        )}
        {workDir && (
          <button
            onClick={() => {
              navigator.clipboard.writeText(workDir);
              showToast('Pfad kopiert!');
            }}
            style={{
              background: 'var(--tn-bg)',
              border: '1px solid var(--tn-border)',
              borderRadius: 3,
              padding: '1px 6px',
              fontSize: 10,
              color: 'var(--tn-cyan)',
              cursor: 'pointer',
              maxWidth: 220,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontFamily: 'monospace',
            }}
            title={`Klick = Pfad kopieren: ${workDir}`}
          >
            {workDir}
          </button>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          {/* Queue toggle - only visible when CUI is on home */}
          {cuiOnHome && (
            <button
              onClick={() => setShowQueue(!showQueue)}
              style={{
                background: showQueue ? 'var(--tn-blue)' : 'none',
                border: showQueue ? 'none' : '1px solid var(--tn-border)',
                color: showQueue ? '#fff' : 'var(--tn-text-muted)',
                cursor: 'pointer',
                fontSize: 9,
                padding: '1px 6px',
                borderRadius: 3,
                fontWeight: 600,
              }}
              title={showQueue ? 'CUI Queue anzeigen' : 'Queue-Overlay anzeigen'}
            >
              Q
            </button>
          )}
          <button
            onClick={handleNewConversation}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--tn-blue, #7aa2f7)',
              cursor: 'pointer',
              fontSize: 13,
              padding: '1px 4px',
              borderRadius: 3,
              fontWeight: 700,
            }}
            title="Neue Konversation"
          >
            +
          </button>
          <button
            onClick={handleReload}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--tn-text-muted)',
              cursor: 'pointer',
              fontSize: 13,
              padding: '1px 4px',
              borderRadius: 3,
            }}
            title="Reload"
          >
            ↻
          </button>
          <button
            onClick={handlePopout}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--tn-text-muted)',
              cursor: 'pointer',
              fontSize: 13,
              padding: '1px 4px',
              borderRadius: 3,
            }}
            title="Pop out"
          >
            ↗
          </button>
        </div>
      </div>
      {status === 'loading' && (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--tn-text-muted)', fontSize: 12 }}>
          Verbinde...
        </div>
      )}
      {status === 'error' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, color: 'var(--tn-red)', fontSize: 12 }}>
          <span>CUI nicht erreichbar auf {getCuiUrl(account)}</span>
          <button onClick={handleReload} style={{ background: 'var(--tn-border)', border: 'none', color: 'var(--tn-text)', padding: '4px 12px', borderRadius: 4, fontSize: 11, cursor: 'pointer' }}>
            Retry
          </button>
        </div>
      )}
      {iframeSrc && status === 'ok' && (
        <iframe
          ref={iframeRef}
          src={iframeSrc}
          style={{
            flex: 1,
            border: 'none',
            width: '100%',
            minHeight: 0,
            background: 'var(--tn-bg)',
          }}
        />
      )}

      {/* Queue overlay - shown when CUI is on home page */}
      {showQueue && cuiOnHome && status === 'ok' && (
        <div style={{
          position: 'absolute', inset: '30px 0 0 0', zIndex: 10,
          background: 'var(--tn-surface)',
        }}>
          <QueueOverlay
            accountId={selectedId}
            projectId={projectId}
            workDir={workDir}
            onNavigate={handleQueueNavigate}
            onStartNew={handleQueueStartNew}
          />
        </div>
      )}

      {/* Drag overlay */}
      {dragOver && (
        <div style={{
          position: 'absolute', inset: 0, zIndex: 20,
          background: 'rgba(122, 162, 247, 0.15)',
          border: '2px dashed var(--tn-blue)',
          borderRadius: 4,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          pointerEvents: 'none',
        }}>
          <div style={{
            background: 'var(--tn-bg-dark)', padding: '12px 24px', borderRadius: 8,
            color: 'var(--tn-text)', fontSize: 13, fontWeight: 600,
          }}>
            Screenshot hier ablegen
          </div>
        </div>
      )}

      {/* Toast notification */}
      {toast && (
        <div style={{
          position: 'absolute', bottom: 12, left: '50%', transform: 'translateX(-50%)',
          zIndex: 30,
          background: 'var(--tn-bg-dark)', border: '1px solid var(--tn-border)',
          padding: '8px 16px', borderRadius: 6,
          color: 'var(--tn-text)', fontSize: 11, whiteSpace: 'nowrap',
          boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
          animation: 'fadeIn 0.2s ease',
        }}>
          {toast}
        </div>
      )}
    </div>
  );
}
