'use strict';
// Main-process side: owns the hidden window that turns "page 1 of a scanned PDF" into a picture
// the vision model can read. The window is created on demand and closed again when idle.
const { BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

const MAX_BYTES = 80 * 1024 * 1024;

class PdfRenderer {
  constructor() {
    this.win = null;
    this.readyPromise = null;
    this.pending = new Map();
    this.seq = 0;
    this.idleTimer = null;
    ipcMain.on('render-pdf-done', (_e, d) => {
      const p = this.pending.get(d.id);
      if (p) {
        this.pending.delete(d.id);
        d.error ? p.reject(new Error(d.error)) : p.resolve(d);
      }
    });
  }

  _ensureWindow() {
    if (this.win && !this.win.isDestroyed()) return this.readyPromise;
    this.win = new BrowserWindow({
      show: false,
      width: 400,
      height: 400,
      webPreferences: {
        preload: path.join(__dirname, 'pdfrender', 'preload.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    this.win.webContents.on('will-navigate', (e) => e.preventDefault());
    this.win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.readyPromise = new Promise((resolve, reject) => {
      const onReady = (e) => {
        if (this.win && !this.win.isDestroyed() && e.sender === this.win.webContents) {
          ipcMain.removeListener('render-pdf-ready', onReady);
          resolve();
        }
      };
      ipcMain.on('render-pdf-ready', onReady);
      this.win.webContents.once('render-process-gone', () => reject(new Error('PDF renderer crashed')));
      setTimeout(() => reject(new Error('PDF renderer did not start')), 20000);
    });
    this.win.loadFile(path.join(__dirname, 'pdfrender', 'index.html'));
    return this.readyPromise;
  }

  /** @returns {Promise<string|null>} base64 JPEG of page 1, or null if it can't be drawn */
  async render(file, maxSide = 1100) {
    try {
      if (fs.statSync(file).size > MAX_BYTES) return null;
      await this._ensureWindow();
      const id = ++this.seq;
      const bytes = fs.readFileSync(file);
      const result = new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        setTimeout(() => {
          if (this.pending.delete(id)) reject(new Error('PDF rendering timed out'));
        }, 60000);
      });
      this.win.webContents.send('render-pdf', { id, bytes, maxSide });
      const r = await result;
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => this.close(), 60000);
      return r.image || null;
    } catch (e) {
      console.error('[sloth] could not draw PDF:', e.message);
      this.close(); // start fresh next time
      return null;
    }
  }

  close() {
    clearTimeout(this.idleTimer);
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}

module.exports = { PdfRenderer };
