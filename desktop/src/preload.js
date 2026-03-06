const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('openssh', {
    getConfig: () => ipcRenderer.invoke('config:get'),
    setConfig: (data) => ipcRenderer.invoke('config:set', data),
});
