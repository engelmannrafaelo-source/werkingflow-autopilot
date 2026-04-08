const { contextBridge, ipcRenderer } = require('electron');

// Mode passed via webPreferences.additionalArguments from main process
const modeArg = process.argv.find(a => a.startsWith('--cui-mode='));
const cuiMode = modeArg ? modeArg.split('=')[1] : 'remote';

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  mode: cuiMode,
  openDevTools: (webContentsId) => ipcRenderer.invoke('open-devtools', webContentsId),
  setCookie: (details) => ipcRenderer.invoke('set-cookie', details),
  cpuProfile: () => ipcRenderer.invoke('cpu-profile'),
});
