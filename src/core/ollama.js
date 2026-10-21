'use strict';
// Tiny client for a local Ollama server. No dependencies: Node's built-in fetch.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');

const normalizeHost = (h) => (h || 'http://127.0.0.1:11434').replace(/\/+$/, '');

async function jfetch(url, opts = {}, timeoutMs = 4000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: opts.signal || ctrl.signal });
    return res;
  } finally {
    clearTimeout(t);
  }
}

/** Is the Ollama program installed on this computer (even if not running)? */
function findInstalled() {
  const home = os.homedir();
  const candidates = {
    win32: [
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe'),
      'C:\\Program Files\\Ollama\\ollama.exe',
    ],
    darwin: [
      '/Applications/Ollama.app',
      path.join(home, 'Applications', 'Ollama.app'),
      '/usr/local/bin/ollama',
      '/opt/homebrew/bin/ollama',
    ],
    linux: ['/usr/local/bin/ollama', '/usr/bin/ollama', path.join(home, '.local', 'bin', 'ollama')],
  }[process.platform] || [];
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

/** Ask the server what it is running and which models are downloaded. */
async function status(host) {
  const base = normalizeHost(host);
  const out = { installed: !!findInstalled(), running: false, version: null, models: [] };
  try {
    const v = await jfetch(`${base}/api/version`, {}, 1500);
    if (!v.ok) return out;
    out.running = true;
    out.installed = true;
    out.version = (await v.json()).version || null;
    const t = await jfetch(`${base}/api/tags`, {}, 3000);
    if (t.ok) out.models = ((await t.json()).models || []).map((m) => m.name || m.model);
  } catch {
    /* not running */
  }
  return out;
}

/** Does "gemma3:4b" match an installed "gemma3:4b" (or "gemma3:latest" for "gemma3")? */
function hasModel(models, wanted) {
  if (!wanted) return false;
  const w = wanted.includes(':') ? wanted : `${wanted}:latest`;
  return models.some((m) => m === w || m === wanted);
}

/** Launch Ollama in the background if it's installed but not running. */
function tryStart() {
  const exe = findInstalled();
  if (!exe) return false;
  try {
    if (process.platform === 'darwin' && exe.endsWith('.app')) {
      execFile('open', ['-a', exe]);
    } else {
      const child = spawn(exe, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
    }
    return true;
  } catch {
    return false;
  }
}

/** Download a model. onProgress({status, percent, completed, total}). */
async function pull(host, model, onProgress, signal) {
  const base = normalizeHost(host);
  const res = await fetch(`${base}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, stream: true }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.error) throw new Error(msg.error);
      const percent = msg.total ? Math.round((msg.completed / msg.total) * 100) : null;
      onProgress && onProgress({ status: msg.status, percent, completed: msg.completed, total: msg.total });
    }
  }
}

/** Is the loaded model running on the graphics card or only on the CPU? null = unknown. */
async function runsOnGpu(host, model) {
  try {
    const res = await jfetch(`${normalizeHost(host)}/api/ps`, {}, 3000);
    if (!res.ok) return null;
    const m = ((await res.json()).models || []).find((x) => x.name === model || x.model === model);
    if (!m || typeof m.size_vram !== 'number') return null;
    return m.size_vram > 0;
  } catch {
    return null;
  }
}

/** Can this model look at pictures? Newer Ollama versions report capabilities. */
async function supportsVision(host, model) {
  try {
    const res = await jfetch(
      `${normalizeHost(host)}/api/show`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }) },
      4000
    );
    if (!res.ok) return false;
    const j = await res.json();
    if (Array.isArray(j.capabilities)) return j.capabilities.includes('vision');
    return !!(j.details && /vision|llava|gemma3|qwen.*vl/i.test(JSON.stringify(j.details) + model));
  } catch {
    return false;
  }
}

/**
 * Ask the model for JSON that matches `schema`. Ollama constrains generation to the schema,
 * which is what lets small local models answer reliably.
 */
async function chatJSON({ host, model, system, prompt, schema, images, timeoutMs = 180000, signal, onStats }) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  if (signal) signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  try {
    const user = { role: 'user', content: prompt };
    if (images && images.length) user.images = images;
    const res = await fetch(`${normalizeHost(host)}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        format: schema,
        keep_alive: '15m',
        options: { temperature: 0, num_ctx: 4096, num_predict: 200 },
        messages: [{ role: 'system', content: system }, user],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`The AI engine answered with an error (${res.status}).`);
    const j = await res.json();
    if (onStats) onStats(j);
    const text = j.message && j.message.content;
    return JSON.parse(text);
  } finally {
    clearTimeout(t);
  }
}

module.exports = { runsOnGpu, normalizeHost, findInstalled, status, hasModel, tryStart, pull, supportsVision, chatJSON };
