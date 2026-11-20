// The only bridge between the window and the app: status in, a few actions out.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('telemedia', {
  onStatus(callback) {
    ipcRenderer.on('status', (_event, view) => callback(view));
    ipcRenderer.send('ready');
  },
  sendPassword: (password) => ipcRenderer.invoke('password', password),
  restart: () => ipcRenderer.invoke('restart'),
  logout: () => ipcRenderer.invoke('logout'),
  connectStremio: () => ipcRenderer.invoke('connect-stremio'),
  openStremio: () => ipcRenderer.invoke('open-stremio'),
  copyAddress: () => ipcRenderer.invoke('copy-address'),
  openSetupPage: () => ipcRenderer.invoke('open-setup'),
  setAutostart: (on) => ipcRenderer.invoke('set-autostart', on),
  openLogs: () => ipcRenderer.invoke('open-logs'),
});
