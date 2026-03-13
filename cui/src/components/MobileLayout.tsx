import { useState, useEffect, useRef, useCallback } from 'react';
import { MessageSquare, FolderOpen, StickyNote, Globe, Image } from 'lucide-react';
import CuiLitePanel from './panels/CuiLitePanel';
import FilePreview from './panels/FilePreview';
import NotesPanel from './panels/NotesPanel';
import BrowserPanel from './panels/BrowserPanel';
import ImageDrop from './panels/ImageDrop';
import ErrorBoundary from './ErrorBoundary';
import { useSessionStore } from '../contexts/SessionStore';
import { ACCOUNTS } from '../types';

interface MobileLayoutProps {
  projectId: string;
  workDir: string;
}

interface MobileTab {
  component: string;
  name: string;
  config: Record<string, unknown>;
}

const MOBILE_PANELS: Record<string, { label: string; Icon: typeof MessageSquare }> = {
  'cui':      { label: 'Chat',   Icon: MessageSquare },
  'cui-lite': { label: 'Chat',   Icon: MessageSquare },
  'preview':  { label: 'Files',  Icon: FolderOpen },
  'notes':    { label: 'Notes',  Icon: StickyNote },
  'browser':  { label: 'Browse', Icon: Globe },
  'images':   { label: 'Images', Icon: Image },
};

function isChatTab(component: string): boolean {
  return component === 'cui' || component === 'cui-lite';
}

function extractTabs(node: any): MobileTab[] {
  const tabs: MobileTab[] = [];
  if (node.type === 'tab' && node.component) {
    tabs.push({ component: node.component, name: node.name || node.component, config: node.config || {} });
  }
  if (node.children) {
    for (const child of node.children) tabs.push(...extractTabs(child));
  }
  if (node.layout) tabs.push(...extractTabs(node.layout));
  return tabs;
}

/** Get short label for a chat tab: account short name or first 6 chars of tab name */
function chatTabLabel(tab: MobileTab): string {
  const accountId = tab.config?.accountId as string;
  if (accountId) {
    const acct = ACCOUNTS.find(a => a.id === accountId);
    if (acct) return acct.label.slice(0, 6);
  }
  // Fallback: use tab name or generic "Chat"
  return tab.name?.slice(0, 6) || 'Chat';
}

/** Get account color for a chat tab */
function chatTabColor(tab: MobileTab): string | undefined {
  const accountId = tab.config?.accountId as string;
  if (accountId) {
    return ACCOUNTS.find(a => a.id === accountId)?.color;
  }
  return undefined;
}

export default function MobileLayout({ projectId, workDir }: MobileLayoutProps) {
  const { cuiStates } = useSessionStore();
  const [activeIdx, setActiveIdx] = useState(0);
  const [tabs, setTabs] = useState<MobileTab[]>([]);
  const [splitPct, setSplitPct] = useState(40);
  const [visited, setVisited] = useState<Set<number>>(new Set([0]));
  const activeDirRef = useRef(workDir);
  const splitRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  useEffect(() => {
    const fallback: MobileTab[] = [
      { component: 'cui', name: 'Chat', config: {} },
      { component: 'preview', name: 'Files', config: { watchPath: workDir } },
      { component: 'notes', name: 'Notes', config: {} },
    ];

    fetch(`/api/layouts/${projectId}`)
      .then(r => r.ok ? r.json() : null)
      .then(layout => {
        if (!layout) { setTabs(fallback); return; }
        const all = extractTabs(layout);
        const mobile = all.filter(t => t.component in MOBILE_PANELS);
        // Deduplicate: keep each unique chat account + each non-chat panel type once
        const seen = new Set<string>();
        const deduped = mobile.filter(t => {
          const key = isChatTab(t.component)
            ? `cui-${(t.config?.accountId as string) || 'default'}`
            : t.component;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        setTabs(deduped.length > 0 ? deduped : fallback);
      })
      .catch(() => setTabs(fallback));
  }, [projectId, workDir]);

  // Mark tabs as visited (lazy-mount, never unmount)
  useEffect(() => {
    setVisited(prev => {
      if (prev.has(activeIdx)) return prev;
      const next = new Set(prev);
      next.add(activeIdx);
      return next;
    });
  }, [activeIdx]);

  useEffect(() => {
    if (activeIdx >= tabs.length) setActiveIdx(0);
  }, [tabs.length, activeIdx]);

  // Draggable split divider
  const onDividerTouchStart = useCallback((e: React.TouchEvent) => {
    e.preventDefault();
    dragging.current = true;
  }, []);

  useEffect(() => {
    const onMove = (e: TouchEvent) => {
      if (!dragging.current || !splitRef.current) return;
      const wrapper = splitRef.current.parentElement;
      if (!wrapper) return;
      const rect = wrapper.getBoundingClientRect();
      const y = e.touches[0].clientY - rect.top;
      const pct = Math.min(75, Math.max(15, (y / rect.height) * 100));
      setSplitPct(pct);
    };
    const onEnd = () => { dragging.current = false; };
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd);
    return () => {
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
    };
  }, []);

  const renderPanel = (tab: MobileTab, idx: number) => {
    switch (tab.component) {
      case 'cui': case 'cui-lite':
        return (
          <CuiLitePanel
            accountId={tab.config?.accountId as string}
            projectId={projectId}
            workDir={workDir}
            panelId={`mobile-${tab.component}-${idx}`}
            isTabVisible={idx === activeIdx}
          />
        );
      case 'preview':
        return (
          <FilePreview
            watchPath={(tab.config?.watchPath as string) || activeDirRef.current || workDir}
            stageDir={activeDirRef.current}
          />
        );
      case 'notes':
        return <NotesPanel projectId={projectId} />;
      case 'browser':
        return <BrowserPanel initialUrl={tab.config?.url as string} panelId="mobile-browser" />;
      case 'images':
        return <ImageDrop />;
      default:
        return <div style={{ padding: 20, color: 'var(--tn-text-muted)' }}>Unknown: {tab.component}</div>;
    }
  };

  const activeTab = tabs[activeIdx];
  const isChat = activeTab && isChatTab(activeTab.component);

  // Chat tabs and non-chat tabs
  const chatTabs = tabs.map((t, i) => ({ tab: t, idx: i })).filter(x => isChatTab(x.tab.component));
  const nonChatTabs = tabs.map((t, i) => ({ tab: t, idx: i })).filter(x => !isChatTab(x.tab.component));

  // Find the "first" chat tab for the always-mounted split-top (when a non-chat tab is active)
  const firstChatIdx = chatTabs.length > 0 ? chatTabs[0].idx : -1;
  const firstChatTab = firstChatIdx >= 0 ? tabs[firstChatIdx] : null;

  return (
    <div className="mobile-layout">
      <div className="mobile-split-wrapper">
        {/* When a chat tab is active: show that chat fullscreen */}
        {isChat && (
          <div style={{ height: '100%', overflow: 'hidden' }}>
            {chatTabs.map(({ tab, idx }) => {
              if (!visited.has(idx)) return null;
              return (
                <div
                  key={`chat-${idx}`}
                  style={{ display: idx === activeIdx ? 'block' : 'none', height: '100%' }}
                >
                  <ErrorBoundary componentName={tab.component}>
                    {renderPanel(tab, idx)}
                  </ErrorBoundary>
                </div>
              );
            })}
          </div>
        )}

        {/* When a non-chat tab is active: split view (chat top, other bottom) */}
        {!isChat && (
          <>
            <div
              className="mobile-split-top"
              style={{ height: `${splitPct}%` }}
            >
              {firstChatTab && (
                <ErrorBoundary componentName={firstChatTab.component}>
                  {renderPanel(firstChatTab, firstChatIdx)}
                </ErrorBoundary>
              )}
            </div>

            <div
              ref={splitRef}
              className="mobile-split-divider"
              onTouchStart={onDividerTouchStart}
            />

            <div className="mobile-split-bottom">
              {nonChatTabs.map(({ tab, idx }) => {
                if (!visited.has(idx)) return null;
                const isActive = idx === activeIdx;
                return (
                  <div
                    key={`panel-${tab.component}-${idx}`}
                    style={{ display: isActive ? 'block' : 'none', height: '100%' }}
                  >
                    <ErrorBoundary componentName={tab.component}>
                      {renderPanel(tab, idx)}
                    </ErrorBoundary>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* Bottom tab bar */}
      <nav className="mobile-tab-bar">
        {tabs.map((tab, i) => {
          const isActive = i === activeIdx;
          const info = MOBILE_PANELS[tab.component];
          if (!info) return null;
          const { Icon } = info;
          const isTabChat = isChatTab(tab.component);
          const cuiId = tab.config?.accountId as string;
          const state = cuiId ? cuiStates[cuiId] : undefined;
          const acctColor = isTabChat ? chatTabColor(tab) : undefined;

          // For chat tabs: show account label. For others: show panel label.
          const label = isTabChat ? chatTabLabel(tab) : info.label;

          return (
            <button
              key={`${tab.component}-${i}`}
              className={`mobile-tab-btn ${isActive ? 'active' : ''}`}
              onClick={() => setActiveIdx(i)}
              style={isActive && acctColor ? { color: acctColor } : undefined}
            >
              {state === 'processing' && <span className="mobile-state-dot processing" />}
              {state === 'done' && <span className="mobile-state-dot done" />}
              <Icon size={22} />
              <span
                className="mobile-tab-label"
                style={isActive && acctColor ? { color: acctColor } : undefined}
              >
                {label}
              </span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
