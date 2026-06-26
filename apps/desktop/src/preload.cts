import { contextBridge, ipcRenderer } from 'electron';

const desktopBridge = {
  getConfig: () => ipcRenderer.invoke('desktop:get-config'),
  resetApiUrl: () => ipcRenderer.invoke('desktop:reset-api-url'),
  setApiUrl: (apiUrl: string) => ipcRenderer.invoke('desktop:set-api-url', apiUrl),
};

contextBridge.exposeInMainWorld('openClaudeTagDesktop', desktopBridge);
