const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  openDevTools: (webContentsId) => ipcRenderer.invoke('open-devtools', webContentsId),
});
