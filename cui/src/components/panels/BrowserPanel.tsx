import { useState, useRef, useEffect, useCallback } from 'react';

interface BrowserPanelProps {
  initialUrl?: string;
  panelId?: string;
  onUrlChange?: (url: string) => void;
}

const isElectron = !!window.electronAPI?.isElectron;

export default function BrowserPanel({ initialUrl = '', panelId, onUrlChange }: BrowserPanelProps) {
  // Persist URL per panel instance in localStorage
  const storageKey = panelId ? `browser-url-${panelId}` : '';
  const restoredUrl = storageKey ? (localStorage.getItem(storageKey) || initialUrl) : initialUrl;
  const [url, setUrl] = useState(restoredUrl);
  const [inputValue, setInputValue] = useState(restoredUrl);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [isDomVisible, setIsDomVisible] = useState(true);
  // Incrementing key destroys + recreates iframe/webview = guaranteed fresh load
  const [reloadKey, setReloadKey] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const webviewRef = useRef<HTMLWebViewElement | null>(null);

  // Unload iframe/webview when hidden behind other tabs (same pattern as CuiPanel)
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

  // Listen for global nuclear-refresh event (from toolbar button)
  useEffect(() => {
    const handler = () => hardRefresh();
    window.addEventListener('nuclear-refresh', handler);
    return () => window.removeEventListener('nuclear-refresh', handler);
  }, []);

  function navigate() {
    let target = inputValue.trim();
    if (!target) return;
    if (!target.startsWith('http')) {
      if (!target.includes('.') || target.includes(' ')) {
        target = `https://www.google.com/search?q=${encodeURIComponent(target)}`;
      } else {
        target = 'https://' + target;
      }
    }
    setUrl(target);
    if (storageKey) localStorage.setItem(storageKey, target);
    onUrlChange?.(target);
  }

  // Webview event listeners (Electron only)
  useEffect(() => {
    if (!isElectron || !url) return;
    const wv = webviewRef.current as any;
    if (!wv) return;

    const onNavigate = () => {
      const currentUrl = wv.getURL?.() ?? url;
      setInputValue(currentUrl);
      setUrl(currentUrl);
      if (storageKey) localStorage.setItem(storageKey, currentUrl);
      onUrlChange?.(currentUrl);
      setCanGoBack(wv.canGoBack?.() ?? false);
      setCanGoForward(wv.canGoForward?.() ?? false);
    };

    wv.addEventListener('did-navigate', onNavigate);
    wv.addEventListener('did-navigate-in-page', onNavigate);

    return () => {
      wv.removeEventListener('did-navigate', onNavigate);
      wv.removeEventListener('did-navigate-in-page', onNavigate);
    };
  }, [url, reloadKey]);

  const handleBack = useCallback(() => {
    const wv = webviewRef.current as any;
    if (isElectron && wv) wv.goBack?.();
  }, []);

  const handleForward = useCallback(() => {
    const wv = webviewRef.current as any;
    if (isElectron && wv) wv.goForward?.();
  }, []);

  // Hard refresh: reloadIgnoringCache bypasses ALL cache (HTML + CSS + JS)
  // while preserving cookies/login state. Falls back to destroy+recreate for iframes.
  function hardRefresh() {
    const wv = webviewRef.current as any;
    if (isElectron && wv?.reloadIgnoringCache) {
      wv.reloadIgnoringCache();
    } else {
      setReloadKey(k => k + 1);
    }
  }

  const handleReload = useCallback(() => {
    hardRefresh();
  }, []);

  const handleDevTools = useCallback(() => {
    const wv = webviewRef.current as any;
    if (isElectron && wv) {
      // Use webview's built-in DevTools API (no IPC roundtrip needed)
      if (wv.isDevToolsOpened?.()) {
        wv.closeDevTools();
      } else {
        wv.openDevTools?.();
      }
    }
  }, []);

  // Cache-busted URL: only needed for iframe fallback (webviews use reloadIgnoringCache)
  function cacheBustedUrl(base: string, key: number): string {
    if (key === 0) return base;
    try {
      const u = new URL(base);
      u.searchParams.delete('_cb');
      u.searchParams.set('_cb', key.toString());
      return u.toString();
    } catch {
      return base;
    }
  }

  const btnStyle = (enabled = true): React.CSSProperties => ({
    background: 'none',
    border: 'none',
    color: enabled ? 'var(--tn-text-muted)' : 'var(--tn-border)',
    cursor: enabled ? 'pointer' : 'default',
    fontSize: 13,
    padding: '1px 4px',
    borderRadius: 3,
  });

  return (
    <div ref={containerRef} style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--tn-surface)' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '4px 8px',
          background: 'var(--tn-bg-dark)',
          borderBottom: '1px solid var(--tn-border)',
          height: 30,
          flexShrink: 0,
        }}
      >
        {isElectron && (
          <>
            <button onClick={handleBack} style={btnStyle(canGoBack)} disabled={!canGoBack} title="Back">&#8592;</button>
            <button onClick={handleForward} style={btnStyle(canGoForward)} disabled={!canGoForward} title="Forward">&#8594;</button>
          </>
        )}
        <button onClick={handleReload} style={btnStyle()} title="Hard Refresh (Cache loeschen)">&#8635;</button>
        <input
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') navigate(); }}
          placeholder="URL or search..."
          style={{
            flex: 1,
            background: 'var(--tn-bg)',
            color: 'var(--tn-text)',
            border: '1px solid var(--tn-border)',
            borderRadius: 4,
            padding: '3px 8px',
            fontSize: 11,
          }}
        />
        <button
          onClick={navigate}
          style={{
            background: 'var(--tn-border)',
            border: 'none',
            color: 'var(--tn-text)',
            padding: '3px 10px',
            borderRadius: 4,
            fontSize: 11,
            cursor: 'pointer',
          }}
        >
          Go
        </button>
        {isElectron && (
          <button onClick={handleDevTools} style={btnStyle()} title="DevTools">
            {'</>'}
          </button>
        )}
      </div>
      {url && isDomVisible ? (
        isElectron ? (
          <webview
            ref={webviewRef as any}
            src={url}
            partition="persist:browser"
            style={{ flex: 1, border: 'none', width: '100%', minHeight: 0 }}
          />
        ) : (
          <iframe
            key={`if-${reloadKey}`}
            ref={iframeRef}
            src={cacheBustedUrl(url, reloadKey)}
            style={{ flex: 1, border: 'none', width: '100%', minHeight: 0, background: '#fff' }}
          />
        )
      ) : url && !isDomVisible ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--tn-text-muted)', fontSize: 11, opacity: 0.5 }}>
          Pausiert (Tab nicht sichtbar)
        </div>
      ) : (
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            color: 'var(--tn-text-muted)',
            fontSize: 13,
          }}
        >
          <span style={{ fontSize: 24 }}>
            {isElectron ? 'Electron Browser' : 'Browser'}
          </span>
          <span>URL eingeben oder suchen</span>
          {!isElectron && (
            <span style={{ fontSize: 10, opacity: 0.6 }}>
              Electron-App starten fuer DevTools + volle Browser-Funktionalitaet
            </span>
          )}
        </div>
      )}
    </div>
  );
}
