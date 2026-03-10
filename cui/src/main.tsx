import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { SessionStoreProvider } from './contexts/SessionStore';
import ErrorBoundary from './components/ErrorBoundary';
import './styles/tokyo-night.css';
import 'flexlayout-react/style/dark.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary componentName="App">
      <SessionStoreProvider>
        <App />
      </SessionStoreProvider>
    </ErrorBoundary>
  </StrictMode>
);
