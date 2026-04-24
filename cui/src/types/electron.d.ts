declare global {
  interface Window {
    electronAPI?: {
      isElectron: boolean;
      openDevTools: (webContentsId: number) => Promise<void>;
      setCookie: (details: { url: string; name: string; value: string; expirationDate: number }) => Promise<void>;
      cpuProfile: () => Promise<{
        totalSamples: number;
        durationMs: number;
        top: Array<{ hits: number; fn: string; url: string; line: number }>;
      } | { error: string }>;
    };
    /** CUI server connectivity flag — set by health-check loop */
    __cuiServerAlive?: boolean;
    /** Set to true during auto-layout activation (cleared after 3s) */
    __cuiAutoLayoutActive?: boolean;
    /** Host override for CUI app URLs (set by server via window injection) */
    __CUI_APP_HOST__?: string;
    /** Bridge API key injected by server for client-side requests */
    __CUI_BRIDGE_API_KEY__?: string;
  }
}
export {};
