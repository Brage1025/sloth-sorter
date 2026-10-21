'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const INVOKE = [
  'get-state', 'save-settings', 'choose-folder', 'scan', 'cancel-scan', 'apply', 'history', 'undo',
  'show-in-folder', 'open-folder', 'ollama-start', 'ollama-download-page', 'pull-model', 'cancel-pull',
  'set-auto', 'check-ai', 'clear-cache',
];
const EVENTS = ['scan-progress', 'pull-progress', 'auto-ran', 'state-changed', 'perf-hint'];

contextBridge.exposeInMainWorld('sloth', {
  call: (channel, payload) => {
    if (!INVOKE.includes(channel)) throw new Error(`Unknown channel ${channel}`);
    return ipcRenderer.invoke(channel, payload);
  },
  on: (channel, cb) => {
    if (!EVENTS.includes(channel)) throw new Error(`Unknown event ${channel}`);
    const handler = (_e, data) => cb(data);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
