import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';

// Action types
type ActionType = 'navigate' | 'execute';

// Action definition interface
export interface Action {
  id: string;
  label: string;
  icon: string; // Using emoji for simplicity (no icon library needed)
  type: ActionType;
  target?: string; // Route for navigate, handler key for execute
  shortcut?: string;
  group?: 'users' | 'tenants' | 'system' | 'data' | 'navigation';
}

// Props for execution handlers
export interface QuickActionsProps {
  onExecute?: (actionId: string) => void | Promise<void>;
  onNavigate?: (path: string) => void;
}

/**
 * QuickActions - Command Palette for Admin Panel
 *
 * Keyboard shortcuts:
 * - Cmd+K / Ctrl+K: Open menu
 * - Arrow keys: Navigate
 * - Enter: Execute action
 * - ESC: Close
 *
 * Features:
 * - Fuzzy search
 * - Keyboard navigation
 * - Execute vs. Navigate actions
 * - Visual grouping
 * - Shortcuts display
 */
export default function QuickActions({ onExecute, onNavigate }: QuickActionsProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [executingAction, setExecutingAction] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Available actions (centralized configuration)
  const ACTIONS: Action[] = useMemo(() => [
    // Users
    { id: 'create-user', label: 'Create New User', icon: '👤', type: 'execute', shortcut: 'Cmd+Shift+U', group: 'users' },
    { id: 'search-users', label: 'Search Users', icon: '🔍', type: 'navigate', target: '/admin?tab=users', group: 'users' },
    { id: 'export-users', label: 'Export Users to CSV', icon: '📥', type: 'execute', group: 'users' },
    { id: 'bulk-delete-users', label: 'Bulk Delete Users', icon: '🗑️', type: 'execute', group: 'users' },

    // Tenants
    { id: 'create-tenant', label: 'Create New Tenant', icon: '🏢', type: 'execute', shortcut: 'Cmd+Shift+T', group: 'tenants' },
    { id: 'search-tenants', label: 'Search Tenants', icon: '🔍', type: 'navigate', target: '/admin?tab=tenants', group: 'tenants' },
    { id: 'export-tenants', label: 'Export Tenants to CSV', icon: '📥', type: 'execute', group: 'tenants' },

    // System
    { id: 'system-health', label: 'View System Health', icon: '💚', type: 'navigate', target: '/admin?tab=system-health', group: 'system' },
    { id: 'audit-log', label: 'Go to Audit Log', icon: '📋', type: 'navigate', target: '/admin?tab=audit', group: 'system' },
    { id: 'impersonation', label: 'Impersonate User', icon: '🎭', type: 'navigate', target: '/admin?tab=impersonation', group: 'system' },

    // Data
    { id: 'recent-invoices', label: 'View Recent Invoices', icon: '💰', type: 'navigate', target: '/admin?tab=billing', group: 'data' },
    { id: 'usage-stats', label: 'View Usage Statistics', icon: '📊', type: 'navigate', target: '/admin?tab=usage', group: 'data' },
    { id: 'api-tokens', label: 'Manage API Tokens', icon: '🔑', type: 'navigate', target: '/admin?tab=tokens', group: 'data' },

    // Navigation
    { id: 'dashboard', label: 'Go to Dashboard', icon: '🏠', type: 'navigate', target: '/admin?tab=dashboard', group: 'navigation' },
    { id: 'activity-feed', label: 'View Activity Feed', icon: '📰', type: 'navigate', target: '/admin?tab=activity', group: 'navigation' },
  ], []);

  // Fuzzy search implementation
  const filteredActions = useMemo(() => {
    if (!query.trim()) return ACTIONS;

    const lowerQuery = query.toLowerCase();
    return ACTIONS.filter(action => {
      const searchString = `${action.label} ${action.group || ''}`.toLowerCase();

      // Simple fuzzy matching: check if all query characters appear in order
      let searchIndex = 0;
      for (const char of lowerQuery) {
        searchIndex = searchString.indexOf(char, searchIndex);
        if (searchIndex === -1) return false;
        searchIndex++;
      }
      return true;
    });
  }, [query, ACTIONS]);

  // Reset selected index when filtered results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [filteredActions]);

  // Focus input when modal opens
  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen]);

  // Global keyboard shortcut listener (Cmd+K / Ctrl+K)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setIsOpen(prev => !prev);
        setQuery(''); // Reset query on open
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Modal keyboard navigation (Arrow keys, Enter, ESC)
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!isOpen) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex(prev =>
          prev < filteredActions.length - 1 ? prev + 1 : 0
        );
        break;

      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex(prev =>
          prev > 0 ? prev - 1 : filteredActions.length - 1
        );
        break;

      case 'Enter':
        e.preventDefault();
        if (filteredActions[selectedIndex]) {
          handleExecuteAction(filteredActions[selectedIndex]);
        }
        break;

      case 'Escape':
        e.preventDefault();
        setIsOpen(false);
        setQuery('');
        break;
    }
  }, [isOpen, filteredActions, selectedIndex]);

  // Execute or navigate action
  const handleExecuteAction = useCallback(async (action: Action) => {
    if (!action) {
      console.warn('[QuickActions] No action provided to execute');
      return;
    }

    console.log('[QuickActions] Executing action:', action.id, action.type);

    if (action.type === 'navigate') {
      // Navigation: close modal and navigate
      setIsOpen(false);
      setQuery('');

      if (onNavigate) {
        onNavigate(action.target || '/admin');
      } else {
        console.warn('[QuickActions] No onNavigate handler provided for navigation action');
      }
    } else if (action.type === 'execute') {
      // Execution: keep modal open, show loading state
      setExecutingAction(action.id);

      try {
        if (onExecute) {
          await onExecute(action.id);
        } else {
          console.warn(`[QuickActions] No handler for execute action: ${action.id}`);
          // Show placeholder message
          alert(`Action "${action.label}" would execute here.\n\nImplement onExecute handler to add functionality.`);
        }
      } catch (error) {
        console.error(`[QuickActions] Failed to execute action ${action.id}:`, error);
        alert(`Failed to execute action: ${error instanceof Error ? error.message : 'Unknown error'}`);
      } finally {
        setExecutingAction(null);
      }
    }
  }, [onExecute, onNavigate]);

  // Don't render if not open
  if (!isOpen) return null;

  // Group actions for visual organization
  const groupedActions = useMemo(() => {
    const groups: Record<string, Action[]> = {};
    filteredActions.forEach(action => {
      const group = action.group || 'other';
      if (!groups[group]) groups[group] = [];
      groups[group].push(action);
    });
    return groups;
  }, [filteredActions]);

  const groupLabels: Record<string, string> = {
    users: 'Users',
    tenants: 'Tenants',
    system: 'System',
    data: 'Data & Analytics',
    navigation: 'Navigation',
    other: 'Other',
  };

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={() => {
          setIsOpen(false);
          setQuery('');
        }}
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0, 0, 0, 0.5)',
          zIndex: 9999,
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'center',
          paddingTop: '20vh',
        }}
      >
        {/* Modal */}
        <div
          onClick={(e) => e.stopPropagation()} // Prevent closing when clicking inside
          onKeyDown={handleKeyDown}
          style={{
            background: 'var(--tn-surface)',
            borderRadius: 8,
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)',
            border: '1px solid var(--tn-border)',
            width: '100%',
            maxWidth: 600,
            maxHeight: '60vh',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          {/* Header with Search Input */}
          <div style={{
            padding: '16px',
            borderBottom: '1px solid var(--tn-border)',
            background: 'var(--tn-bg-dark)',
          }}>
            <div style={{ position: 'relative' }}>
              <div style={{
                position: 'absolute',
                left: 12,
                top: '50%',
                transform: 'translateY(-50%)',
                fontSize: 16,
                color: 'var(--tn-text-muted)',
                pointerEvents: 'none',
              }}>
                🔍
              </div>
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search actions... (type to filter)"
                style={{
                  width: '100%',
                  padding: '10px 12px 10px 40px',
                  fontSize: 14,
                  background: 'var(--tn-bg)',
                  border: '1px solid var(--tn-border)',
                  borderRadius: 6,
                  color: 'var(--tn-text)',
                  outline: 'none',
                }}
              />
            </div>
            <div style={{
              marginTop: 8,
              fontSize: 10,
              color: 'var(--tn-text-muted)',
              display: 'flex',
              gap: 12,
            }}>
              <span>↑↓ Navigate</span>
              <span>↵ Execute</span>
              <span>ESC Close</span>
            </div>
          </div>

          {/* Actions List */}
          <div style={{
            flex: 1,
            overflow: 'auto',
            padding: '8px',
          }}>
            {filteredActions.length === 0 ? (
              <div style={{
                padding: '32px 16px',
                textAlign: 'center',
                color: 'var(--tn-text-muted)',
                fontSize: 13,
              }}>
                No actions found for "{query}"
              </div>
            ) : (
              Object.entries(groupedActions).map(([groupKey, actions]) => (
                <div key={groupKey} style={{ marginBottom: 16 }}>
                  {/* Group Label */}
                  <div style={{
                    fontSize: 10,
                    fontWeight: 700,
                    color: 'var(--tn-text-muted)',
                    textTransform: 'uppercase',
                    padding: '4px 8px',
                    letterSpacing: '0.5px',
                  }}>
                    {groupLabels[groupKey] || groupKey}
                  </div>

                  {/* Actions in Group */}
                  {actions.map((action, idx) => {
                    const globalIndex = filteredActions.indexOf(action);
                    const isSelected = globalIndex === selectedIndex;
                    const isExecuting = executingAction === action.id;

                    return (
                      <button
                        key={action.id}
                        onClick={() => handleExecuteAction(action)}
                        onMouseEnter={() => setSelectedIndex(globalIndex)}
                        disabled={isExecuting}
                        style={{
                          width: '100%',
                          padding: '10px 12px',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 12,
                          background: isSelected ? 'var(--tn-blue)' : 'transparent',
                          border: 'none',
                          borderRadius: 6,
                          cursor: isExecuting ? 'wait' : 'pointer',
                          color: isSelected ? '#fff' : 'var(--tn-text)',
                          textAlign: 'left',
                          transition: 'all 0.15s',
                          opacity: isExecuting ? 0.6 : 1,
                        }}
                      >
                        {/* Icon */}
                        <span style={{ fontSize: 20, flexShrink: 0 }}>
                          {isExecuting ? '⏳' : action.icon}
                        </span>

                        {/* Label */}
                        <span style={{
                          flex: 1,
                          fontSize: 13,
                          fontWeight: 500,
                        }}>
                          {action.label}
                        </span>

                        {/* Type Badge */}
                        <span style={{
                          fontSize: 9,
                          fontWeight: 600,
                          padding: '2px 6px',
                          borderRadius: 3,
                          background: action.type === 'navigate'
                            ? 'rgba(158,206,106,0.2)'
                            : 'rgba(224,175,104,0.2)',
                          color: action.type === 'navigate'
                            ? 'var(--tn-green)'
                            : 'var(--tn-orange)',
                        }}>
                          {action.type === 'navigate' ? 'GO' : 'RUN'}
                        </span>

                        {/* Keyboard Shortcut */}
                        {action.shortcut && (
                          <span style={{
                            fontSize: 10,
                            fontWeight: 600,
                            padding: '2px 6px',
                            borderRadius: 3,
                            background: isSelected ? 'rgba(255,255,255,0.2)' : 'var(--tn-bg-dark)',
                            color: isSelected ? '#fff' : 'var(--tn-text-muted)',
                            fontFamily: 'monospace',
                          }}>
                            {action.shortcut}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>

          {/* Footer */}
          <div style={{
            padding: '12px 16px',
            borderTop: '1px solid var(--tn-border)',
            background: 'var(--tn-bg-dark)',
            fontSize: 10,
            color: 'var(--tn-text-muted)',
            textAlign: 'center',
          }}>
            Press <kbd style={{
              background: 'var(--tn-bg)',
              padding: '2px 6px',
              borderRadius: 3,
              fontWeight: 600,
            }}>Cmd+K</kbd> to toggle
          </div>
        </div>
      </div>
    </>
  );
}
