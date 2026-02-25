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
  }
}
export {};
