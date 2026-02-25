import { useState, useRef, useEffect, useCallback } from 'react';
import { ACCOUNTS, getCuiUrl } from '../../types';
import { copyToClipboard } from '../../utils/clipboard';
import QueueOverlay from './QueueOverlay';

const REMOTE_ACCOUNTS = new Set(['rafael', 'engelmann', 'office']);
const SWITCHABLE_ACCOUNTS = ACCOUNTS.filter(a => a.id !== 'local');
const LOCAL_PORT = 5004;
const isElectron = !!window.electronAPI?.isElectron;

interface CuiPanelProps {
  accountId?: string;
  projectId?: string;
  workDir?: string;
  panelId?: string;
  isTabVisible?: boolean;
  onRouteChange?: (route: string) => void;
}

export default function CuiPanel({ accountId, projectId, workDir, panelId, isTabVisible = true, onRouteChange }: CuiPanelProps) {
  const storageKey = `cui-account-${panelId || projectId || 'default'}`;
  const modeKey = `cui-mode-${panelId || projectId || 'default'}`;
  const [selectedId, setSelectedId] = useState(() => {
    if (accountId) return accountId;
    try { return localStorage.getItem(storageKey) || ACCOUNTS[0].id; } catch { return ACCOUNTS[0].id; }
  });
  const [useLocalMode, setUseLocalMode] = useState(() => {
    try { return localStorage.getItem(modeKey) === 'local'; } catch { return false; }
  });
  const [iframeSrc, setIframeSrc] = useState('');
  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading');
  const [dragOver, setDragOver] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [cuiOnHome, setCuiOnHome] = useState(true);  // Track if CUI is on home/queue page
  const [showQueue, setShowQueue] = useState(true);   // User toggle for queue overlay
  const [cuiAttention, setCuiAttention] = useState<'idle' | 'working' | 'needs_attention'>('idle');
  const [attentionReason, setAttentionReason] = useState<string | undefined>();
  const [rateLimited, setRateLimited] = useState(false);
  const [queueRefresh, setQueueRefresh] = useState(0);
  const rateLimitSuppressedUntil = useRef<number>(0); // Suppress re-trigger after dismiss
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const webviewRef = useRef<HTMLWebViewElement | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(null);
  const savedRouteRef = useRef<string>('');
  // Suppress cuiOnHome=true for a few seconds after explicit navigation (SPA may briefly show / before /c/)
  const lastNavigateTimeRef = useRef<number>(0);
  // Stable unique ID per panel instance (survives re-renders but not remounts)
  const instanceId = useRef(panelId || Math.random().toString(36).slice(2, 8));
  // Ref for visibility reporting (set later, used in route change handler)
  const reportVisibilityRef = useRef<() => void>(() => {});

  const [isDomVisible, setIsDomVisible] = useState(true);
  const account = ACCOUNTS.find((a) => a.id === selectedId) ?? ACCOUNTS[0];
  const isRemote = !useLocalMode && REMOTE_ACCOUNTS.has(selectedId);

  // Effective CUI URL: local mode overrides account port to LOCAL_PORT
  const effectiveCuiUrl = useCallback((acc: typeof account) => {
    if (useLocalMode) {
      const host = acc.host || window.location.hostname;
      return `http://${host}:${LOCAL_PORT}`;
    }
    return getCuiUrl(acc);
  }, [useLocalMode]);

  // Track actual DOM visibility via IntersectionObserver (detects flexlayout tab switches)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => setIsDomVisible(entry.isIntersecting && entry.intersectionRatio > 0),
      { threshold: 0.01 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

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

  // Send a message to the guest (webview via executeJavaScript or iframe via postMessage)
  const sendToGuest = useCallback((data: Record<string, unknown>) => {
    if (isElectron && webviewRef.current) {
      (webviewRef.current as any).executeJavaScript(
        `window.postMessage(${JSON.stringify(data)}, '*')`
      ).catch(() => {});
    } else if (iframeRef.current?.contentWindow) {
      iframeRef.current.contentWindow.postMessage(data, '*');
    }
  }, []);

  // Listen for route changes from THIS panel's CUI iframe only (iframe mode)
  useEffect(() => {
    // In Electron webview mode, route detection uses did-navigate events (see below)
    if (isElectron) return;
    function handleMessage(e: MessageEvent) {
      // Only accept messages from our own iframe (not other CUI panels)
      if (e.source !== iframeRef.current?.contentWindow) return;
      if (e.data?.type === 'cui-rate-limit') {
        if (!iframeRef.current) return;
        if (e.data.limited === false) {
          setRateLimited(false);
        } else if (Date.now() > rateLimitSuppressedUntil.current) {
          setRateLimited(true);
        }
      }
      // Stale conversation recovery: CUI shows "not found" → clear route, show queue
      if (e.data?.type === 'cui-stale-conversation') {
        savedRouteRef.current = '';
        setCuiOnHome(true);
        setShowQueue(true);
        try { localStorage.removeItem(routeKey); } catch {}
        onRouteChange?.('');
        return;
      }
      if (e.data?.type === 'cui-route') {
        const pathname = e.data.pathname || '/';
        if (pathname.startsWith('/c/')) {
          savedRouteRef.current = pathname;
          setCuiOnHome(false);
          setShowQueue(false);
          try { localStorage.setItem(routeKey, pathname); } catch {}
          onRouteChange?.(pathname);
          const sessionId = pathname.replace('/c/', '');
          if (sessionId) {
            fetch(`/api/mission/conversation/${sessionId}/assign`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ accountId: selectedId }),
            }).catch(() => {});
          }
        } else {
          // Suppress home-switch for 5s after explicit navigation — CUI SPA may briefly show / before routing to /c/
          if (Date.now() - lastNavigateTimeRef.current < 5000) return;
          savedRouteRef.current = '';
          setCuiOnHome(true);
          setShowQueue(true);
          try { localStorage.removeItem(routeKey); } catch {}
          onRouteChange?.('');
        }
        reportVisibilityRef.current();
      }
    }
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [routeKey, selectedId]);

  // Webview navigation events — route detection in Electron mode
  useEffect(() => {
    if (!isElectron) return;
    const wv = webviewRef.current as any;
    if (!wv) return;

    const handleNavigation = () => {
      const currentUrl: string = wv.getURL?.() ?? '';
      try {
        const pathname = new URL(currentUrl).pathname;
        if (pathname.startsWith('/c/')) {
          savedRouteRef.current = pathname;
          setCuiOnHome(false);
          setShowQueue(false);
          try { localStorage.setItem(routeKey, pathname); } catch {}
          onRouteChange?.(pathname);
          const sessionId = pathname.replace('/c/', '');
          if (sessionId) {
            fetch(`/api/mission/conversation/${sessionId}/assign`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ accountId: selectedId }),
            }).catch(() => {});
          }
        } else {
          // Suppress home-switch for 5s after explicit navigation
          if (Date.now() - lastNavigateTimeRef.current < 5000) return;
          savedRouteRef.current = '';
          setCuiOnHome(true);
          setShowQueue(true);
          try { localStorage.removeItem(routeKey); } catch {}
          onRouteChange?.('');
        }
        reportVisibilityRef.current();
      } catch { /* invalid URL */ }
    };

    wv.addEventListener('did-navigate', handleNavigation);
    wv.addEventListener('did-navigate-in-page', handleNavigation);
    return () => {
      wv.removeEventListener('did-navigate', handleNavigation);
      wv.removeEventListener('did-navigate-in-page', handleNavigation);
    };
  }, [iframeSrc, routeKey, selectedId]);

  // Fetch auth token from local proxy, then load iframe/webview.
  // Restores last conversation route if available (per-panel).
  useEffect(() => {
    setStatus('loading');
    setIframeSrc('');
    setRateLimited(false);
    rateLimitSuppressedUntil.current = Date.now() + 30000;
    const baseUrl = effectiveCuiUrl(account);

    // Restore saved route for THIS specific panel (accountId + projectId)
    const savedRoute = localStorage.getItem(routeKey) || '';
    savedRouteRef.current = savedRoute;
    // If restoring a conversation route, hide overlay immediately (don't wait for inject script)
    if (savedRoute.startsWith('/c/')) {
      setCuiOnHome(false);
      setShowQueue(false);
      lastNavigateTimeRef.current = Date.now();
    }

    fetch(`${baseUrl}/api/config`, { signal: AbortSignal.timeout(5000) })
      .then((res) => res.json())
      .then(async (config) => {
        const token = config.authToken;
        if (token && token.length === 32 && /^[a-f0-9]+$/.test(token)) {
          if (isElectron) {
            // Electron: inject cookie via IPC into default session BEFORE webview loads
            await window.electronAPI!.setCookie({
              url: baseUrl,
              name: 'cui-auth-token',
              value: token,
              expirationDate: Math.floor(Date.now() / 1000) + 7 * 86400,
            });
          } else {
            // Browser: set cookie on document
            const expires = new Date();
            expires.setDate(expires.getDate() + 7);
            document.cookie = `cui-auth-token=${token}; expires=${expires.toUTCString()}; path=/; SameSite=Lax`;
          }
        }
        // Restore conversation or start at home
        setIframeSrc(buildIframeUrl(baseUrl, savedRoute));
        setStatus('ok');
      })
      .catch(() => {
        setIframeSrc(buildIframeUrl(baseUrl, savedRoute));
        setStatus('error');
      });
  }, [selectedId, useLocalMode, buildIframeUrl, routeKey]);

  // Ref for WS so visibility can be reported from route change handlers
  const visibilityWsRef = useRef<WebSocket | null>(null);

  const reportVisibility = useCallback(() => {
    const ws = visibilityWsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const route = savedRouteRef.current || '';
    const sessionId = route.startsWith('/c/') ? route.replace('/c/', '') : '';
    ws.send(JSON.stringify({
      type: 'panel-visibility',
      panelId: instanceId.current,
      projectId: projectId || 'default',
      accountId: selectedId,
      sessionId,
      route,
    }));
  }, [selectedId, projectId]);

  // Ref for navigate handler (avoids stale closure in WS listener)
  const handleQueueNavigateRef = useRef<(sessionId: string) => void>(() => {});

  // Auto-refresh + Control API + Visibility reporting
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${protocol}://${window.location.host}/ws`);
    visibilityWsRef.current = ws;
    let reloadTimer: ReturnType<typeof setTimeout> | null = null;
    let queueRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    const _tag = `[CuiPanel:${instanceId.current}/${selectedId}]`;
    // Perf counters (logged in 30s summary, no per-message console.log)
    let _wsTotal = 0;
    let _cuiState = 0;
    let _attention = 0;
    let _t0 = Date.now();

    ws.onopen = () => {
      console.log(`${_tag} WS connected`);
      reportVisibility();
    };
    const heartbeat = setInterval(() => reportVisibility(), 120000);

    // Aggregate rate summary every 30s (single log line, no per-message logging)
    const rateLogger = setInterval(() => {
      if (_wsTotal > 0) {
        const s = ((Date.now() - _t0) / 1000).toFixed(0);
        console.log(`${_tag} WS ${s}s: ${_wsTotal} total, ${_cuiState} state, ${_attention} attn (${(_wsTotal / (+s || 1)).toFixed(1)}/s)`);
      }
      _wsTotal = 0; _cuiState = 0; _attention = 0; _t0 = Date.now();
    }, 30000);

    ws.onmessage = (e) => {
      _wsTotal++;
      try {
        const raw = e.data as string;
        // Fast pre-filter: skip messages clearly not for this panel (avoid JSON.parse overhead)
        // Messages with cuiId that doesn't match this panel can be skipped early
        if (raw.includes('"cuiId"') && !raw.includes(selectedId) && !raw.includes('"all"')) return;
        const msg = JSON.parse(raw);
        // CUI state from proxy (processing/done)
        if (msg.type === 'cui-state' && msg.cuiId === selectedId) {
          _cuiState++;
          // Debounced QueueOverlay refresh: coalesce rapid state updates into one fetch (15s window)
          if (!queueRefreshTimer) {
            queueRefreshTimer = setTimeout(() => {
              queueRefreshTimer = null;
              setQueueRefresh(n => n + 1);
            }, 15000);
          }
          if (msg.state === 'processing') {
            setCuiAttention(prev => prev === 'working' ? prev : 'working');
            setAttentionReason(prev => prev === undefined ? prev : undefined);
          } else if (msg.state === 'done') {
            setCuiAttention(prev => prev === 'idle' ? prev : 'idle');
            setAttentionReason(prev => prev === 'done' ? prev : 'done');
          }
        }
        // Attention state from SSE detection (plan/question/error)
        if (msg.type === 'conv-attention' && (msg.accountId === selectedId || msg.key === selectedId)) {
          _attention++;
          setCuiAttention(prev => prev === msg.state ? prev : msg.state);
          setAttentionReason(prev => prev === msg.reason ? prev : msg.reason);
        }
        // Auto-refresh when CUI response is ready
        if (msg.type === 'cui-response-ready' && msg.cuiId === selectedId) {
          setCuiAttention(prev => prev === 'idle' ? prev : 'idle');
          setAttentionReason(prev => prev === 'done' ? prev : 'done');
          if (reloadTimer) clearTimeout(reloadTimer);
          reloadTimer = setTimeout(() => {
            sendToGuest({ type: 'cui-refresh' });
          }, 1500);
        }
        // Navigate to conversation (from Mission Control Activate)
        if (msg.type === 'control:cui-navigate-conversation' && msg.panelId === instanceId.current) {
          handleQueueNavigateRef.current(msg.sessionId);
        }
        // Control API commands
        if (msg.cuiId === selectedId || msg.cuiId === 'all') {
          if (msg.type === 'control:cui-reload') handleReloadRef.current();
          if (msg.type === 'control:cui-new-conversation') handleNewConversationRef.current();
          if (msg.type === 'control:cui-set-cwd' && msg.cwd) sendToGuest({ type: 'cui-set-cwd', cwd: msg.cwd });
        }
      } catch { /* ignore */ }
    };

    return () => {
      clearInterval(heartbeat);
      clearInterval(rateLogger);
      if (reloadTimer) clearTimeout(reloadTimer);
      if (queueRefreshTimer) clearTimeout(queueRefreshTimer);
      // Notify server this panel is gone
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'panel-removed', panelId: instanceId.current, projectId: projectId || 'default' }));
      }
      visibilityWsRef.current = null;
      ws.close();
    };
  }, [selectedId, projectId, reportVisibility]);

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
          await copyToClipboard(fullUrl);
          showToast(`Screenshot URL kopiert (Remote-Account)`);
        } else {
          // Local CUI can read local files directly
          await copyToClipboard(path);
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
    if (isElectron && webviewRef.current) {
      (webviewRef.current as any).reload();
    } else {
      const route = savedRouteRef.current;
      setIframeSrc('');
      setTimeout(() => {
        setIframeSrc(buildIframeUrl(effectiveCuiUrl(account), route));
      }, 50);
    }
  }
  handleReloadRef.current = handleReload;

  function handleNewConversation() {
    // Clear saved route + force fresh CUI home page
    savedRouteRef.current = '';
    setCuiOnHome(true);
    setShowQueue(true);
    setCuiAttention('idle');
    try { localStorage.removeItem(routeKey); } catch {}
    const baseUrl = effectiveCuiUrl(account);
    sendToGuest({ type: 'cui-clear-session' });
    if (isElectron && webviewRef.current) {
      (webviewRef.current as any).loadURL(buildIframeUrl(baseUrl));
    } else {
      setIframeSrc('');
      setTimeout(() => setIframeSrc(buildIframeUrl(baseUrl)), 50);
    }
  }
  handleNewConversationRef.current = handleNewConversation;

  // Queue overlay: navigate CUI iframe/webview to a specific conversation
  function handleQueueNavigate(sessionId: string) {
    const baseUrl = effectiveCuiUrl(account);
    const route = `/c/${sessionId}`;
    savedRouteRef.current = route;
    setCuiOnHome(false);
    setShowQueue(false);
    lastNavigateTimeRef.current = Date.now();
    try { localStorage.setItem(routeKey, route); } catch {}
    if (isElectron && webviewRef.current) {
      (webviewRef.current as any).loadURL(buildIframeUrl(baseUrl, route));
    } else {
      setIframeSrc('');
      setTimeout(() => setIframeSrc(buildIframeUrl(baseUrl, route)), 50);
    }
    // Track account assignment for this conversation
    fetch(`/api/mission/conversation/${sessionId}/assign`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: selectedId }),
    }).catch(() => {});
    // Report visibility change
    setTimeout(() => reportVisibility(), 100);
  }
  handleQueueNavigateRef.current = handleQueueNavigate;
  reportVisibilityRef.current = reportVisibility;

  // Queue overlay: start a new conversation with subject
  // Returns true on success, false on failure (so QueueOverlay can handle error state)
  async function handleQueueStartNew(subject: string, message: string): Promise<boolean> {
    try {
      const r = await fetch('/api/mission/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: selectedId,
          workDir: workDir || '/root',
          subject,
          message,
          useLocal: useLocalMode,
        }),
      });
      const data = await r.json();
      if (!r.ok || data.error) {
        showToast(`Fehler: ${data.error || `HTTP ${r.status}`}`);
        return false;
      }
      if (data.sessionId) {
        handleQueueNavigate(data.sessionId);
      }
      return true;
    } catch {
      showToast('Fehler: Server nicht erreichbar');
      return false;
    }
  }

  function handlePopout() {
    window.open(iframeSrc || effectiveCuiUrl(account), '_blank', 'width=1200,height=800,menubar=no,toolbar=no');
  }

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--tn-surface)', position: 'relative', overflow: 'hidden', outline: 'none' }}
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
            setCuiAttention('idle');
            setAttentionReason(undefined);
            setRateLimited(false);
            rateLimitSuppressedUntil.current = Date.now() + 30000;
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
          {SWITCHABLE_ACCOUNTS.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
        {/* Remote/Local mode toggle */}
        <div style={{ display: 'flex', borderRadius: 4, overflow: 'hidden', border: '1px solid var(--tn-border)' }}>
          <button
            onClick={() => { setUseLocalMode(false); try { localStorage.setItem(modeKey, 'remote'); } catch {} }}
            style={{
              background: !useLocalMode ? 'var(--tn-blue)' : 'var(--tn-bg)',
              color: !useLocalMode ? '#fff' : 'var(--tn-text-muted)',
              border: 'none', fontSize: 9, padding: '1px 6px', cursor: 'pointer', fontWeight: 600,
            }}
          >R</button>
          <button
            onClick={() => { setUseLocalMode(true); try { localStorage.setItem(modeKey, 'local'); } catch {} }}
            style={{
              background: useLocalMode ? '#e0af68' : 'var(--tn-bg)',
              color: useLocalMode ? '#1a1b26' : 'var(--tn-text-muted)',
              border: 'none', fontSize: 9, padding: '1px 6px', cursor: 'pointer', fontWeight: 600,
            }}
            title="Lokaler CUI-Server (localhost:4004)"
          >L</button>
        </div>
        {cuiAttention === 'working' && !cuiOnHome && (
          <span style={{ fontSize: 9, color: '#3B82F6', fontWeight: 600, opacity: 0.8 }}>
            arbeitet
          </span>
        )}
        {cuiAttention === 'needs_attention' && !cuiOnHome && (
          <span style={{ fontSize: 9, color: '#F59E0B', fontWeight: 600 }}>
            {attentionReason === 'plan' ? 'Plan' : attentionReason === 'question' ? 'Frage' : attentionReason === 'error' ? 'Fehler' : attentionReason === 'done' ? 'Fertig' : 'Aktion'}
          </span>
        )}
        {workDir && (
          <button
            onClick={() => {
              copyToClipboard(workDir);
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
          {!cuiOnHome && (
            <button
              onClick={() => {
                const route = savedRouteRef.current || '';
                const sid = route.startsWith('/c/') ? route.replace('/c/', '') : '';
                if (!sid) { showToast('Keine aktive Konversation'); return; }
                fetch(`/api/mission/conversation/${sid}/finish`, {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ finished: true }),
                }).then(() => showToast('Als fertig markiert')).catch(() => showToast('Fehler'));
              }}
              style={{
                background: 'none',
                border: '1px solid rgba(16,185,129,0.3)',
                color: '#10B981',
                cursor: 'pointer',
                fontSize: 9,
                padding: '1px 6px',
                borderRadius: 3,
                fontWeight: 600,
              }}
              title="Konversation als fertig markieren"
            >
              &#10003; Fertig
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
          <span>CUI nicht erreichbar auf {effectiveCuiUrl(account)}</span>
          <button onClick={handleReload} style={{ background: 'var(--tn-border)', border: 'none', color: 'var(--tn-text)', padding: '4px 12px', borderRadius: 4, fontSize: 11, cursor: 'pointer' }}>
            Retry
          </button>
        </div>
      )}
      {/* Content: webview in Electron, iframe in browser.
         Both unmount when tab is hidden (isDomVisible=false) to free Chromium renderer processes.
         Each webview spawns a full Chromium process (~500MB-1.6GB) running the claude.ai React app locally. */}
      {iframeSrc && status === 'ok' && isElectron && isDomVisible && (
        <webview
          ref={webviewRef as any}
          src={iframeSrc}
          style={{ flex: 1, border: 'none', width: '100%', minHeight: 0, background: 'var(--tn-bg)' }}
        />
      )}
      {iframeSrc && status === 'ok' && !isElectron && isDomVisible && (
        <iframe
          ref={iframeRef}
          src={iframeSrc}
          style={{ flex: 1, border: 'none', width: '100%', minHeight: 0, background: 'var(--tn-bg)' }}
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
            useLocal={useLocalMode}
            onNavigate={handleQueueNavigate}
            onStartNew={handleQueueStartNew}
            refreshSignal={queueRefresh}
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
