const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  openDevTools: (webContentsId) => ipcRenderer.invoke('open-devtools', webContentsId),
  setCookie: (details) => ipcRenderer.invoke('set-cookie', details),
  cpuProfile: () => ipcRenderer.invoke('cpu-profile'),
});
