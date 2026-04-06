// =============================================================================
// ArchitectureRenderer — Swappable Renderer Interface
// =============================================================================
// v1: MermaidRenderer (uses mermaid.js)
// v2: Custom SVG Renderer (future)

export interface ArchitectureRenderer {
  /** Render the given content (e.g. Mermaid string) into the container */
  render(container: HTMLElement, content: string): Promise<void>;

  /** Set callback for node click events */
  onNodeClick(callback: (nodeId: string) => void): void;

  /** Clean up resources */
  destroy(): void;
}
