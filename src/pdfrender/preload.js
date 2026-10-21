'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('slothPdf', {
  onRender: (cb) => ipcRenderer.on('render-pdf', (_e, d) => cb(d)),
  done: (d) => ipcRenderer.send('render-pdf-done', d),
  ready: () => ipcRenderer.send('render-pdf-ready'),
});
