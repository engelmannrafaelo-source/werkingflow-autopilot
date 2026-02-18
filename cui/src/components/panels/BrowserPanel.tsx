import { useState, useRef, useEffect, useCallback } from 'react';

declare global {
  interface Window {
    electronAPI?: {
      isElectron: boolean;
      openDevTools: (webContentsId: number) => Promise<void>;
    };
  }
}

interface BrowserPanelProps {
  initialUrl?: string;
  panelId?: string;
}

const isElectron = !!window.electronAPI?.isElectron;

export default function BrowserPanel({ initialUrl = '', panelId }: BrowserPanelProps) {
  // Persist URL per panel instance in localStorage
  const storageKey = panelId ? `browser-url-${panelId}` : '';
  const restoredUrl = storageKey ? (localStorage.getItem(storageKey) || initialUrl) : initialUrl;
  const [url, setUrl] = useState(restoredUrl);
  const [inputValue, setInputValue] = useState(restoredUrl);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const webviewRef = useRef<HTMLWebViewElement | null>(null);

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
  }

  // Webview event listeners (Electron only)
  useEffect(() => {
    if (!isElectron || !url) return;
    const wv = webviewRef.current as any;
    if (!wv) return;

    const onNavigate = () => {
      setInputValue(wv.getURL?.() ?? url);
      setCanGoBack(wv.canGoBack?.() ?? false);
      setCanGoForward(wv.canGoForward?.() ?? false);
    };

    wv.addEventListener('did-navigate', onNavigate);
    wv.addEventListener('did-navigate-in-page', onNavigate);

    return () => {
      wv.removeEventListener('did-navigate', onNavigate);
      wv.removeEventListener('did-navigate-in-page', onNavigate);
    };
  }, [url]);

  const handleBack = useCallback(() => {
    const wv = webviewRef.current as any;
    if (isElectron && wv) wv.goBack?.();
  }, []);

  const handleForward = useCallback(() => {
    const wv = webviewRef.current as any;
    if (isElectron && wv) wv.goForward?.();
  }, []);

  const handleReload = useCallback(() => {
    if (isElectron && webviewRef.current) {
      (webviewRef.current as any).reload?.();
    } else if (iframeRef.current) {
      iframeRef.current.src = url;
    }
  }, [url]);

  const handleDevTools = useCallback(() => {
    const wv = webviewRef.current as any;
    if (isElectron && wv) {
      const wcId = wv.getWebContentsId?.();
      if (wcId) window.electronAPI!.openDevTools(wcId);
    }
  }, []);

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
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--tn-surface)' }}>
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
        <button onClick={handleReload} style={btnStyle()} title="Reload">&#8635;</button>
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
      {url ? (
        isElectron ? (
          <webview
            ref={webviewRef as any}
            src={url}
            partition="persist:browser"
            style={{ flex: 1, border: 'none', width: '100%', minHeight: 0 }}
          />
        ) : (
          <iframe
            ref={iframeRef}
            src={url}
            style={{ flex: 1, border: 'none', width: '100%', minHeight: 0, background: '#fff' }}
          />
        )
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
