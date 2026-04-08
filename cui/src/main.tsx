import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { SessionStoreProvider } from './contexts/SessionStore';
import ErrorBoundary from './components/ErrorBoundary';
import './styles/tokyo-night.css';
import 'flexlayout-react/style/dark.css';

// ─── Mobile Redirect Gate ───────────────────────────────────────────
// MUST run before React bootstrap. Touch devices without ?mobile or ?desktop
// get redirected to mobile mode. If redirect fires, we STOP — no React mount,
// no race condition, no Error #310.
const params = new URLSearchParams(window.location.search);
const isTouchDevice = 'ontouchstart' in window && window.innerWidth < 1200;
const isMobile = params.has('mobile') || params.get('mode') === 'mobile';
const isDesktopForced = params.has('desktop');

if (isTouchDevice && !isMobile && !isDesktopForced) {
  const url = new URL(window.location.href);
  url.searchParams.set('mobile', '');
  window.location.replace(url.toString());
  // STOP: page is navigating away — do NOT mount React
} else {
  // ─── Normal Bootstrap ───────────────────────────────────────────────
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ErrorBoundary componentName="App">
        <SessionStoreProvider>
          <App />
        </SessionStoreProvider>
      </ErrorBoundary>
    </StrictMode>
  );
}
