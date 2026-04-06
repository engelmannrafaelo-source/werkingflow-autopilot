import { useRef, useEffect, useCallback } from 'react';
import mermaid from 'mermaid';

interface PortStatusEntry {
  status: 'online' | 'offline';
  port: number;
  latency_ms: number | null;
  isBackend: boolean;
}

interface MermaidRendererProps {
  mermaidContent: string;
  onNodeClick?: (nodeId: string) => void;
  portStatus?: Record<string, PortStatusEntry>;
}

let mermaidInitialized = false;

function initMermaidOnce() {
  if (mermaidInitialized) return;
  mermaidInitialized = true;
  mermaid.initialize({
    startOnLoad: false,
    theme: 'dark',
    securityLevel: 'loose',
    flowchart: {
      useMaxWidth: true,
      htmlLabels: true,
      curve: 'basis',
    },
    themeVariables: {
      fontSize: '13px',
      fontFamily: 'ui-monospace, monospace',
      primaryColor: '#2d2d2d',
      primaryTextColor: '#e0e0e0',
      primaryBorderColor: '#555',
      lineColor: '#888',
      secondaryColor: '#333',
      tertiaryColor: '#1e1e1e',
    },
  });
}

/**
 * Extract node ID from Mermaid SVG element ID (e.g. "flowchart-engelmann-42" → "engelmann")
 * and apply a status indicator dot if port status is known.
 */
function applyPortStatusToNode(nodeEl: SVGElement, portStatus: Record<string, PortStatusEntry>) {
  const mermaidId = nodeEl.id?.replace(/^flowchart-/, '').replace(/-\d+$/, '');
  if (!mermaidId) return;

  // Map MASTER.yaml node IDs to ports.json app IDs
  const nodeToPortKey: Record<string, string> = {
    'engelmann': 'engelmann',
    'werking-report': 'werking-report',
    'werking-energy': 'werking-energy',
    'werking-safety': 'werking-safety',
    'werking-noise': 'werking-noise',
    'platform': 'platform',
    'energy-backend': 'werking-energy-backend',
    'safety-backend': 'werking-safety-backend',
    'cui': 'cui',
    'watchdog': 'watchdog',
  };

  const portKey = nodeToPortKey[mermaidId];
  if (!portKey) return;

  const entry = portStatus[portKey];
  if (!entry) return;

  const isOnline = entry.status === 'online';
  const color = isOnline ? '#4caf50' : '#f44336';

  // Apply a colored border to the rect/polygon inside the node
  const shape = nodeEl.querySelector('rect, polygon, circle, ellipse');
  if (shape) {
    (shape as SVGElement).style.stroke = color;
    (shape as SVGElement).style.strokeWidth = '2.5';
    if (isOnline) {
      (shape as SVGElement).style.filter = `drop-shadow(0 0 4px ${color}80)`;
    }
  }

  // Add a small status dot in top-right corner
  const bbox = nodeEl.getBBox?.();
  if (bbox) {
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('cx', String(bbox.x + bbox.width - 4));
    dot.setAttribute('cy', String(bbox.y + 4));
    dot.setAttribute('r', '4');
    dot.setAttribute('fill', color);
    dot.setAttribute('stroke', '#1e1e1e');
    dot.setAttribute('stroke-width', '1');
    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    title.textContent = `Port ${entry.port}: ${entry.status}${entry.latency_ms != null ? ` (${entry.latency_ms}ms)` : ''}`;
    dot.appendChild(title);
    nodeEl.appendChild(dot);
  }
}

export default function MermaidRenderer({ mermaidContent, onNodeClick, portStatus }: MermaidRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const renderIdRef = useRef(0);

  const handleClick = useCallback((e: MouseEvent) => {
    if (!onNodeClick) return;
    const target = e.target as HTMLElement;
    // Walk up to find a node group element
    let el: HTMLElement | null = target;
    while (el && el !== containerRef.current) {
      // Mermaid generates SVG nodes with class "node" and id like "flowchart-nodeId-N"
      if (el.classList?.contains('node') || el.closest?.('.node')) {
        const nodeEl = el.classList?.contains('node') ? el : el.closest('.node') as HTMLElement;
        if (nodeEl) {
          const nodeId = nodeEl.id
            ?.replace(/^flowchart-/, '')
            ?.replace(/-\d+$/, '');
          if (nodeId) {
            onNodeClick(nodeId);
            return;
          }
        }
      }
      el = el.parentElement;
    }
  }, [onNodeClick]);

  useEffect(() => {
    if (!containerRef.current || !mermaidContent.trim()) return;
    initMermaidOnce();

    const currentRender = ++renderIdRef.current;
    const container = containerRef.current;
    const renderId = `arch-mermaid-${Date.now()}-${currentRender}`;

    let cancelled = false;

    (async () => {
      try {
        const { svg } = await mermaid.render(renderId, mermaidContent);
        if (cancelled || currentRender !== renderIdRef.current) return;
        container.innerHTML = svg;

        // Make nodes clickable + apply port status indicators
        const nodes = container.querySelectorAll('.node');
        nodes.forEach(node => {
          (node as HTMLElement).style.cursor = 'pointer';
          if (portStatus) {
            applyPortStatusToNode(node as SVGElement, portStatus);
          }
        });
      } catch (err) {
        if (cancelled) return;
        console.warn('[MermaidRenderer] render error:', err);
        container.innerHTML = `<div style="color: #ef9a9a; padding: 16px; font-size: 12px;">
          Mermaid render error: ${err instanceof Error ? err.message : String(err)}
        </div>`;
      }
    })();

    return () => { cancelled = true; };
  }, [mermaidContent, portStatus]);

  // Attach click handler
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.addEventListener('click', handleClick);
    return () => el.removeEventListener('click', handleClick);
  }, [handleClick]);

  return (
    <div
      ref={containerRef}
      style={{
        flex: 1,
        overflow: 'auto',
        padding: 8,
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'flex-start',
        minHeight: 0,
      }}
    />
  );
}
