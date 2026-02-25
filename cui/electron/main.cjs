const { app, BrowserWindow, ipcMain, session, Menu } = require('electron');
const path = require('path');
// Skip macOS Keychain prompts — mock keychain so Electron never triggers the OS dialog
app.commandLine.appendSwitch("use-mock-keychain");

// Prevent crashes from unhandled errors (webview load failures, etc.)
process.on('uncaughtException', (err) => {
  console.error('[Electron] Uncaught exception:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Electron] Unhandled rejection:', reason);
});

let mainWindow;

function createWindow() {
  // macOS needs an application menu for Cmd+C/V/X/A to work
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: app.name || 'Workspace',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        {
          label: 'Cache leeren & Reload',
          accelerator: 'CmdOrCtrl+Shift+Alt+R',
          click: async () => {
            if (!mainWindow) return;
            await session.defaultSession.clearCache();
            await session.defaultSession.clearStorageData({ storages: ['cachestorage', 'serviceworkers'] });
            mainWindow.webContents.reloadIgnoringCache();
            console.log('[Electron] Cache cleared + hard reload');
          },
        },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { role: 'close' },
      ],
    },
  ]));

  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#1a1b26',
    webPreferences: {
      webviewTag: true,
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  // CUI Workspace runs on the remote dev server (single instance).
  // Mac Electron is a thin client — just loads the remote URL.
  const REMOTE_URL = 'http://100.121.161.109:4005';
  const isDev = process.argv.includes('--dev');
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadURL(REMOTE_URL);
  }

  mainWindow.webContents.on('did-fail-load', (_event, code, desc) => {
    console.error(`Failed to load: ${code} ${desc}`);
    // Retry after 2s if remote server isn't reachable yet (Tailscale not ready, etc.)
    if (code === -102 || code === -6) {
      setTimeout(() => mainWindow.loadURL(REMOTE_URL), 2000);
    }
  });
}

app.whenReady().then(() => {
  // IPC: open DevTools for a specific webview
  ipcMain.handle('open-devtools', (_event, webContentsId) => {
    const contents = require('electron').webContents.fromId(webContentsId);
    if (contents) {
      if (contents.isDevToolsOpened()) {
        contents.closeDevTools();
      } else {
        contents.openDevTools({ mode: 'bottom' });
      }
    }
  });

  // CPU Profiling: capture 5s V8 profile of the main renderer
  ipcMain.handle('cpu-profile', async () => {
    if (!mainWindow) return { error: 'no window' };
    const wc = mainWindow.webContents;
    try {
      await wc.debugger.attach('1.3');
      await wc.debugger.sendCommand('Profiler.enable');
      await wc.debugger.sendCommand('Profiler.start');
      await new Promise(r => setTimeout(r, 5000));
      const { profile } = await wc.debugger.sendCommand('Profiler.stop');
      wc.debugger.detach();
      // Find top CPU consumers
      const nodes = profile.nodes || [];
      const samples = profile.samples || [];
      const timeDeltas = profile.timeDeltas || [];
      const hitCount = {};
      for (const sid of samples) {
        hitCount[sid] = (hitCount[sid] || 0) + 1;
      }
      const top = Object.entries(hitCount)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([id, hits]) => {
          const node = nodes.find(n => n.id === parseInt(id));
          const fn = node?.callFrame || {};
          return { hits, fn: fn.functionName || '(anonymous)', url: (fn.url || '').split('/').pop(), line: fn.lineNumber };
        });
      return { totalSamples: samples.length, durationMs: timeDeltas.reduce((s, d) => s + d, 0) / 1000, top };
    } catch (err) {
      try { wc.debugger.detach(); } catch {}
      return { error: err.message };
    }
  });

  // Set cookie in default session (used by CUI webviews for auth token injection)
  ipcMain.handle('set-cookie', async (_event, { url, name, value, expirationDate }) => {
    await session.defaultSession.cookies.set({ url, name, value, expirationDate });
  });

  // Strip CSP headers so webviews can load any URL
  // Apply to both defaultSession AND the persist:browser partition used by webviews
  function stripCSP(sess) {
    sess.webRequest.onHeadersReceived((details, callback) => {
      const headers = { ...details.responseHeaders };
      delete headers['content-security-policy'];
      delete headers['Content-Security-Policy'];
      delete headers['x-frame-options'];
      delete headers['X-Frame-Options'];
      callback({ responseHeaders: headers });
    });
  }
  stripCSP(session.defaultSession);
  stripCSP(session.fromPartition('persist:browser'));

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
