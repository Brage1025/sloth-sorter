'use strict';
(() => {
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
  const call = (c, p) => window.sloth.call(c, p);

  /** A small "are you sure?" box. Resolves true or false. */
  function askSure({ title, text, yes }) {
    return new Promise((resolve) => {
      const back = document.createElement('div');
      back.className = 'modal-back';
      back.innerHTML = `<div class="modal" role="dialog" aria-modal="true"><h3>${esc(title)}</h3><p>${esc(text)}</p>
        <div class="row"><button class="btn ghost" data-no>Cancel</button><button class="btn danger" data-yes>${esc(yes)}</button></div></div>`;
      const done = (v) => { document.removeEventListener('keydown', onKey); back.remove(); resolve(v); };
      const onKey = (e) => { if (e.key === 'Escape') done(false); };
      back.onclick = (e) => { if (e.target === back) done(false); };
      back.querySelector('[data-no]').onclick = () => done(false);
      back.querySelector('[data-yes]').onclick = () => done(true);
      document.addEventListener('keydown', onKey);
      document.body.appendChild(back);
      back.querySelector('[data-no]').focus();
    });
  }

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  const S = {
    st: null, // state from main
    view: 'tidy',
    phase: 'idle', // idle | scanning | review | done
    items: [],
    progress: { done: 0, total: 0, current: '' },
    result: null,
    pull: null, // {model, percent, status, completed, total}
    selModel: null,
    error: null,
    lastAuto: null,
    history: [],
    sigPrev: '',
  };

  const SLOTH_LINES = [
    'Taking my time. Quality takes a while.',
    'Reading carefully. No rush at all.',
    'Hanging from a branch, thinking it over.',
    'Almost there. Eventually.',
    'Peeking inside each file so you never have to.',
  ];

  // ---------- helpers ----------
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => t.classList.remove('show'), 3600);
  }
  const gb = (n) => (n / 1e9).toFixed(1);
  const splitName = (name) => {
    const i = name.lastIndexOf('.');
    return i > 0 ? { base: name.slice(0, i), ext: name.slice(i) } : { base: name, ext: '' };
  };
  const shortPath = (p) => p.replace(/^\/home\/[^/]+|^\/Users\/[^/]+|^[A-Za-z]:\\Users\\[^\\]+/, '~');
  const needsSetup = () => S.st.settings.useAI && !S.st.settings.setupSkipped && !S.st.ai.modelReady;
  const modelInfo = (tag) => S.st.suggestedModels.find((m) => m.tag === tag);
  const when = (iso) => {
    const d = new Date(iso);
    return d.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  };

  async function saveSettings(patch) {
    const res = await call('save-settings', patch);
    if (res && !res.error) S.st.settings = res;
    return res;
  }
  async function refreshState() {
    const st = await call('get-state');
    if (st && !st.error) S.st = st;
  }

  // ---------- chrome: nav + footer ----------
  function renderChrome() {
    $$('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === S.view));
    const { settings, ai } = S.st;
    let dot = 'warn';
    let text;
    if (!settings.useAI) text = 'Basic mode: sorting by file type';
    else if (ai.modelReady) { dot = 'ok'; text = `AI ready · ${settings.model}`; }
    else if (ai.running) text = 'AI engine on · brain not downloaded yet';
    else if (ai.installed) text = 'AI engine is asleep';
    else text = 'AI not set up yet';
    $('#brain').innerHTML = `<span class="dot ${dot}"></span>${esc(text)}`;
  }

  function render() {
    renderChrome();
    const main = $('#main');
    const views = { tidy: renderTidy, sleep: renderSleep, history: renderHistory, settings: renderSettings };
    main.innerHTML = '';
    (views[S.view] || renderTidy)(main);
  }

  const perfText = () => `Your computer is running the AI on its processor, which is slower (no graphics card is being used). It still works, just give it time. To speed things up, choose <b>Tiny &amp; quick</b> in Settings, or switch off <b>Look at photos</b>.`;

  // ---------- TIDY ----------
  function renderTidy(main) {
    if (needsSetup()) return renderSetup(main);
    if (S.phase === 'scanning') return renderScanning(main);
    if (S.phase === 'review') return renderReview(main);
    if (S.phase === 'done') return renderDone(main);
    renderIdle(main);
  }

  function renderIdle(main) {
    const { settings, quickFolders } = S.st;
    main.innerHTML = `
      <section class="hero">
        <img class="logo-big" src="assets/logo.svg" alt="">
        <h2>Which folder is feeling messy?</h2>
        <p class="soft">I'll read the files, work out what they are, and suggest a tidy-up. Nothing moves until you say so.</p>
      </section>
      <section class="card">
        <div class="row" role="group" aria-label="Quick folders">
          ${quickFolders.map((f) => `<button class="chip ${f.path === settings.folder ? 'on' : ''}" data-folder="${esc(f.path)}">${esc(f.label)}</button>`).join('')}
          <button class="chip" id="pick">Choose another…</button>
        </div>
        <div class="folder-box"><span aria-hidden="true">📁</span><span class="path mono" title="${esc(settings.folder)}">${esc(shortPath(settings.folder))}</span></div>
        ${S.error ? `<div class="notice">${esc(S.error)}</div>` : ''}
        <div class="row" style="margin-top:14px">
          <button class="btn primary big" id="go">Take a look</button>
          <span class="soft small">${settings.useAI ? 'Uses the AI on this computer.' : 'Basic mode: sorts by file type only.'}</span>
        </div>
      </section>`;
    $$('[data-folder]', main).forEach((b) => (b.onclick = async () => { await saveSettings({ folder: b.dataset.folder }); S.error = null; render(); }));
    $('#pick', main).onclick = async () => {
      const r = await call('choose-folder');
      if (r && r.folder) { S.st.settings.folder = r.folder; S.error = null; render(); }
    };
    $('#go', main).onclick = startScan;
  }

  async function startScan() {
    S.phase = 'scanning';
    S.error = null;
    S.progress = { done: 0, total: 0, current: '' };
    S.scanStart = Date.now();
    render();
    const res = await call('scan');
    if (res.cancelled) { S.phase = 'idle'; return render(); }
    if (res.error) { S.phase = 'idle'; S.error = res.error; return render(); }
    S.items = res.items.map((it) => ({ ...it, ...splitName(it.newName), include: true, ext: splitName(it.newName).ext }));
    S.phase = 'review';
    render();
  }

  function renderScanning(main) {
    main.innerHTML = `
      <section class="card stack" style="text-align:center;margin-top:30px">
        <img class="logo-big" src="assets/logo.svg" alt="" style="width:96px;height:96px;margin:0 auto">
        <h2>Reading your files…</h2>
        <p class="soft" id="line">${SLOTH_LINES[0]}</p>
        <div class="bar indeterminate" id="bar"><i></i></div>
        <p class="small soft mono" id="cur" style="min-height:1.5em"></p>
        <p class="small soft" id="eta" style="min-height:1.5em"></p>
        <div class="notice" id="perf" style="text-align:left;display:${S.cpuOnly ? 'block' : 'none'}">${perfText()}</div>
        <button class="btn" id="cancel">Cancel</button>
      </section>`;
    let i = 0;
    clearInterval(renderScanning.t);
    renderScanning.t = setInterval(() => { const l = $('#line'); if (l) l.textContent = SLOTH_LINES[++i % SLOTH_LINES.length]; else clearInterval(renderScanning.t); }, 4500);
    $('#cancel', main).onclick = () => call('cancel-scan');
    paintScanProgress();
  }
  function paintScanProgress() {
    const bar = $('#bar'); const cur = $('#cur');
    if (!bar) return;
    const { done, total, current } = S.progress;
    if (total > 0) {
      bar.classList.remove('indeterminate');
      $('i', bar).style.width = `${Math.round((done / total) * 100)}%`;
      cur.textContent = current ? `${done + 1} of ${total} · ${current}` : `${total} of ${total}`;
      const eta = $('#eta');
      if (eta && done >= 1 && current) {
        const secs = Math.round(((Date.now() - S.scanStart) / done) * (total - done) / 1000);
        eta.textContent = secs >= 90 ? `About ${Math.round(secs / 60)} minutes left. Feel free to go do something else.` : `About ${secs} seconds left.`;
      }
    }
  }

  function renderReview(main) {
    const items = S.items;
    if (!items.length) {
      main.innerHTML = `<section class="hero"><img class="logo-big" src="assets/logo.svg" alt=""><h2>Nothing to tidy here</h2>
        <p class="soft">This folder is already calm. (I skip folders, hidden files and anything still downloading.)</p>
        <button class="btn" id="back">Back</button></section>`;
      $('#back', main).onclick = () => { S.phase = 'idle'; render(); };
      return;
    }
    const cats = S.st.settings.categories;
    const order = [...new Set([...cats, ...items.map((i) => i.category)])];
    const groups = order.map((c) => [c, items.filter((i) => i.category === c)]).filter(([, l]) => l.length);

    main.innerHTML = `
      <h2>Here's the plan</h2>
      <p class="soft">Look it over. Rename anything, change a folder, or untick files you want left alone.</p>
      <div id="groups">${groups.map(([c, list]) => `
        <section class="cat">
          <div class="cat-head"><span>📂 ${esc(c)}</span><span class="count">${plural(list.length, 'file', 'files')}</span></div>
          <div class="card" style="padding:0">${list.map((it) => fileRow(it, cats)).join('')}</div>
        </section>`).join('')}
      </div>
      <div class="sticky">
        <div class="row">
          <button class="btn primary big" id="apply"></button>
          <button class="btn ghost" id="all">Select all</button>
          <button class="btn ghost" id="none">Select none</button>
        </div>
        <button class="btn" id="again">Start over</button>
      </div>`;

    const updateCount = () => {
      const n = S.items.filter((i) => i.include).length;
      const b = $('#apply');
      b.textContent = n ? `Tidy ${plural(n, 'file', 'files')}` : 'Nothing selected';
      b.disabled = n === 0;
    };
    updateCount();

    $$('.file', main).forEach((row) => {
      const it = S.items[+row.dataset.id];
      $('input[type=checkbox]', row).onchange = (e) => { it.include = e.target.checked; row.classList.toggle('skip', !it.include); updateCount(); };
      $('input[type=text]', row).oninput = (e) => { it.base = e.target.value; };
      $('select', row).onchange = (e) => { it.category = e.target.value; const y = main.scrollTop; render(); main.scrollTop = y; };
    });
    $('#all', main).onclick = () => { S.items.forEach((i) => (i.include = true)); const y = main.scrollTop; render(); main.scrollTop = y; };
    $('#none', main).onclick = () => { S.items.forEach((i) => (i.include = false)); const y = main.scrollTop; render(); main.scrollTop = y; };
    $('#again', main).onclick = () => { S.phase = 'idle'; render(); };
    $('#apply', main).onclick = applyPlan;
  }

  function basisNote(it) {
    const t = { text: 'read the text inside', image: 'looked at the picture', name: 'went by the name only', scanned: 'this PDF has no readable text (probably scanned), so I went by its name' }[it.basis];
    return t ? ` <span class="soft">(${esc(t)})</span>` : '';
  }

  function fileRow(it, cats) {
    const options = [...new Set([...cats, it.category])];
    return `<div class="file ${it.include ? '' : 'skip'}" data-id="${it.id}">
      <input type="checkbox" ${it.include ? 'checked' : ''} aria-label="Include ${esc(it.name)}">
      <div class="names">
        <div class="orig" title="${esc(it.name)}">${esc(it.name)}</div>
        <div class="newrow"><input type="text" value="${esc(it.base)}" aria-label="New name for ${esc(it.name)}" spellcheck="false"><span class="ext">${esc(it.ext)}</span></div>
      </div>
      <select aria-label="Folder for ${esc(it.name)}">${options.map((c) => `<option ${c === it.category ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
      ${it.reason ? `<div class="why"><span class="badge ${it.source === 'ai' ? 'ai' : ''}">${it.source === 'ai' ? 'AI' : 'RULES'}</span> ${esc(it.reason)}${basisNote(it)}</div>` : ''}
    </div>`;
  }

  async function applyPlan() {
    const choices = S.items.filter((i) => i.include).map((i) => ({ from: i.from, category: i.category, newName: i.base + i.ext }));
    const btn = $('#apply'); btn.disabled = true; btn.textContent = 'Tidying…';
    const res = await call('apply', choices);
    if (res.error) { toast(res.error); return render(); }
    S.result = res;
    S.phase = 'done';
    render();
  }

  function renderDone(main) {
    const r = S.result;
    main.innerHTML = `
      <section class="hero">
        <img class="logo-big" src="assets/logo.svg" alt="">
        <h2>${plural(r.moved, 'file', 'files')} tidied</h2>
        <p class="soft">Moved into a folder called “${esc(S.st.settings.sortedFolder)}”. Nothing was deleted, and nothing was overwritten.</p>
        ${r.failed.length ? `<div class="notice" style="text-align:left;max-width:560px;margin:10px auto">${plural(r.failed.length, 'file', 'files')} couldn't be moved: ${esc(r.failed.map((f) => f.error).slice(0, 2).join('; '))}</div>` : ''}
        <div class="row" style="justify-content:center;margin-top:12px">
          ${r.firstTo ? '<button class="btn primary" id="show">Show me</button>' : ''}
          ${r.batchId ? '<button class="btn" id="undo">Undo</button>' : ''}
          <button class="btn ghost" id="fin">Done</button>
        </div>
      </section>`;
    const show = $('#show', main); if (show) show.onclick = () => call('show-in-folder', r.firstTo);
    const undo = $('#undo', main);
    if (undo) undo.onclick = async () => { const u = await call('undo', r.batchId); toast(u.error || `Put ${plural(u.restored, 'file', 'files')} back.`); S.phase = 'idle'; render(); };
    $('#fin', main).onclick = () => { S.phase = 'idle'; render(); };
  }

  // ---------- SETUP ----------
  function renderSetup(main) {
    const { ai, settings } = S.st;
    const engineOk = ai.running;
    const sel = S.selModel || settings.model;
    const pull = S.pull;
    const info = modelInfo(sel);
    main.innerHTML = `
      <section class="hero" style="padding-bottom:0">
        <img class="logo-big" src="assets/logo.svg" alt="">
        <h2>Let's wake up your sloth's brain</h2>
        <p class="soft">Sloth Sorter uses a small AI that lives on your computer, so your files stay private. Two quick steps, once.</p>
      </section>
      ${S.error ? `<div class="notice" style="margin-bottom:14px">${esc(S.error)}</div>` : ''}
      <section class="card step ${engineOk ? 'done' : ''}">
        <div class="num">${engineOk ? '✓' : '1'}</div>
        <div class="grow">
          <h3>Install the AI engine</h3>
          ${engineOk
            ? '<p class="soft">Ollama is installed and running. Nice.</p>'
            : ai.installed
              ? `<p class="soft">Ollama is installed but not running yet.</p><button class="btn primary" id="start">Wake it up</button>`
              : `<p class="soft">It's called <b>Ollama</b>: a free, open-source app that runs AI models on your own computer. Install it like any other app, then come back. I'll notice automatically.</p>
                 <div class="row"><button class="btn primary" id="get">Get Ollama (free)</button><span class="small soft">Waiting for it to be installed…</span></div>`}
        </div>
      </section>
      <section class="card step ${engineOk ? '' : 'locked'}">
        <div class="num">2</div>
        <div class="grow">
          <h3>Download the brain</h3>
          <p class="soft">A one-time download. After this, Sloth Sorter works with no internet at all.</p>
          <div class="models" role="radiogroup">
            ${S.st.suggestedModels.map((m) => `
              <label class="model ${m.tag === sel ? 'sel' : ''}">
                <input type="radio" name="model" value="${esc(m.tag)}" ${m.tag === sel ? 'checked' : ''} ${pull ? 'disabled' : ''}>
                <span><b>${esc(m.label)}</b> <span class="soft">· ${esc(m.size)}</span><br><span class="small soft">${esc(m.note)}</span></span>
              </label>`).join('')}
          </div>
          ${pull ? `
            <div class="bar ${pull.percent == null ? 'indeterminate' : ''}"><i id="pbar" style="width:${pull.percent || 0}%"></i></div>
            <p class="small soft" id="ptext" style="margin-top:8px">${pullText(pull)}</p>
            <button class="btn" id="cancelpull">Cancel</button>`
            : `<button class="btn primary big" id="dl" ${engineOk ? '' : 'disabled'}>Download ${esc(info ? info.size : '')}</button>`}
        </div>
      </section>
      <p style="text-align:center"><button class="btn ghost" id="skip">Skip for now: just sort by file type</button></p>`;

    const bind = (id, fn) => { const el = $(id, main); if (el) el.onclick = fn; };
    bind('#get', () => call('ollama-download-page'));
    bind('#start', async (e) => { e.target.disabled = true; e.target.textContent = 'Waking up…'; await call('ollama-start'); await recheckAI(true); });
    bind('#dl', () => downloadModel(sel));
    bind('#cancelpull', () => call('cancel-pull'));
    bind('#skip', async () => { await saveSettings({ setupSkipped: true }); render(); });
    $$('input[name=model]', main).forEach((r) => (r.onchange = () => { S.selModel = r.value; render(); }));
  }
  const pullText = (p) => (p.total
    ? `${esc(p.status || 'Downloading')} · ${gb(p.completed || 0)} of ${gb(p.total)} GB (${p.percent}%)`
    : esc(p.status || 'Getting ready…'));

  async function downloadModel(tag) {
    S.error = null;
    S.pull = { model: tag, percent: null, status: 'Getting ready…' };
    render();
    const r = await call('pull-model', tag);
    S.pull = null;
    if (r.error) S.error = `The download didn't finish: ${r.error}`;
    else if (r.done) { await saveSettings({ model: tag }); toast('The brain is awake!'); }
    await recheckAI(true);
    render();
  }

  // ---------- SLEEP MODE ----------
  function renderSleep(main) {
    const s = S.st.settings;
    main.innerHTML = `
      <h2>Sleep mode</h2>
      <p class="soft">The laziest way to stay tidy: leave this on and forget about it.</p>
      <section class="card stack">
        <div class="row spread">
          <div class="grow"><h3>Tidy automatically</h3>
            <p class="soft small" style="margin:0">Watches <b class="mono">${esc(shortPath(s.folder))}</b> and tidies files once they've been left alone for a while. <span class="soft">(Change the folder on the Tidy tab.)</span></p></div>
          <label class="switch"><input type="checkbox" id="auto" ${s.autoMode ? 'checked' : ''} aria-label="Tidy automatically"><span></span></label>
        </div>
        <div class="row spread">
          <label for="mins" class="grow">Wait until a file has been untouched for</label>
          <select id="mins">${[2, 5, 10, 30, 60].map((m) => `<option value="${m}" ${m === s.autoMinutes ? 'selected' : ''}>${m} minutes</option>`).join('')}</select>
        </div>
        <div class="row spread">
          <label for="login" class="grow">Start Sloth Sorter when I log in</label>
          <label class="switch"><input type="checkbox" id="login" ${s.startAtLogin ? 'checked' : ''}><span></span></label>
        </div>
      </section>
      <div class="notice good">
        Closing the window won't stop it. Sloth Sorter keeps sleeping in your ${S.st.platform === 'darwin' ? 'menu bar' : 'system tray'}.
        Every automatic tidy shows up in <b>History</b>, where you can undo it. If the AI isn't ready, Sleep mode waits instead of sorting badly.
      </div>
      ${S.lastAuto ? `<p class="small soft" style="margin-top:12px">Last automatic tidy: ${plural(S.lastAuto.moved, 'file', 'files')} at ${esc(new Date(S.lastAuto.at).toLocaleTimeString())}.</p>` : ''}`;
    $('#auto', main).onchange = async (e) => { await call('set-auto', e.target.checked); await refreshState(); toast(e.target.checked ? 'Sleep mode on. Go relax.' : 'Sleep mode off.'); };
    $('#mins', main).onchange = (e) => saveSettings({ autoMinutes: +e.target.value });
    $('#login', main).onchange = (e) => saveSettings({ startAtLogin: e.target.checked });
  }

  // ---------- HISTORY ----------
  async function renderHistory(main) {
    main.innerHTML = '<h2>History</h2><p class="soft">Every tidy-up can be undone, one at a time.</p><div id="list"></div>';
    S.history = await call('history');
    const list = $('#list', main);
    if (!S.history.length) { list.innerHTML = '<section class="card soft">Nothing yet. Your first tidy-up will show up here.</section>'; return; }
    list.innerHTML = S.history.map((b) => `
      <section class="card hist ${b.undone ? 'undone' : ''}">
        <div class="grow">
          <div class="when">${esc(when(b.at))} ${b.auto ? '<span class="badge auto">AUTOMATIC</span>' : ''} ${b.undone ? '<span class="badge">UNDONE</span>' : ''}</div>
          <div class="small soft">${plural(b.count, 'file', 'files')} from <span class="mono">${esc(shortPath(b.folder))}</span></div>
          <ul class="plain">${b.sample.map((m) => `<li>${esc(m.from)} → ${esc(m.to)}</li>`).join('')}${b.count > b.sample.length ? `<li>…and ${b.count - b.sample.length} more</li>` : ''}</ul>
        </div>
        <button class="btn" data-undo="${esc(b.id)}" ${b.undone ? 'disabled' : ''}>Undo</button>
      </section>`).join('');
    $$('[data-undo]', list).forEach((btn) => (btn.onclick = async () => {
      btn.disabled = true;
      const u = await call('undo', btn.dataset.undo);
      toast(u.error || `Put ${plural(u.restored, 'file', 'files')} back${u.missing.length ? ` (${u.missing.length} had been moved or deleted)` : ''}.`);
      renderHistory(main);
    }));
  }

  // ---------- SETTINGS ----------
  function renderSettings(main) {
    const s = S.st.settings;
    const sel = s.model;
    const known = S.st.suggestedModels.some((m) => m.tag === sel);
    main.innerHTML = `
      <h2>Settings</h2>
      <section class="card stack">
        <div class="row spread">
          <div class="grow"><h3>Use the AI</h3><p class="soft small" style="margin:0">Off = basic mode, which only sorts by file type and never renames.</p></div>
          <label class="switch"><input type="checkbox" id="useai" ${s.useAI ? 'checked' : ''} aria-label="Use the AI"><span></span></label>
        </div>
        <div>
          <h3>Which brain?</h3>
          <p class="soft small">Any model from the Ollama library works. Swap it whenever a better one comes out.</p>
          <div class="models">
            ${S.st.suggestedModels.map((m) => `
              <label class="model ${m.tag === sel ? 'sel' : ''}"><input type="radio" name="m" value="${esc(m.tag)}" ${m.tag === sel ? 'checked' : ''}>
              <span><b>${esc(m.label)}</b> <span class="mono soft">${esc(m.tag)}</span> <span class="soft">· ${esc(m.size)}</span><br><span class="small soft">${esc(m.note)}</span></span></label>`).join('')}
          </div>
          <div class="row"><label for="custom" class="small soft">Or any other model:</label>
            <input type="text" id="custom" class="mono" placeholder="e.g. qwen2.5:7b" value="${known ? '' : esc(sel)}"></div>
          <p class="small" id="modelstate" style="margin-top:10px"></p>
        </div>
      </section>
      <section class="card stack">
        <h3>How I sort</h3>
        <div class="row spread"><div class="grow">Look at photos<div class="small soft">The AI describes pictures to name and sort them. This is the slowest part, especially on computers without a good graphics card. Off = photos are sorted by type only.</div></div>
          <label class="switch"><input type="checkbox" id="vision" ${s.useVision !== false ? 'checked' : ''}><span></span></label></div>
        <div class="row spread"><div class="grow">Rename messy files<div class="small soft">Turns <span class="mono">IMG_2231.jpg</span> into something readable.</div></div>
          <label class="switch"><input type="checkbox" id="rename" ${s.rename ? 'checked' : ''}><span></span></label></div>
        <div class="row spread"><div class="grow">Leave good names alone<div class="small soft">Only rename files whose names are cryptic.</div></div>
          <label class="switch"><input type="checkbox" id="keep" ${s.keepGoodNames ? 'checked' : ''}><span></span></label></div>
        <div class="row spread"><label for="sorted" class="grow">Put tidied files inside a folder called</label>
          <input type="text" id="sorted" value="${esc(s.sortedFolder)}"></div>
        <div>
          <label for="cats"><b>Folders to sort into</b> <span class="small soft">(one per line)</span></label>
          <textarea id="cats" spellcheck="false">${esc(s.categories.join('\n'))}</textarea>
          <div class="row" style="margin-top:8px"><button class="btn" id="savecats">Save folders</button><button class="btn ghost" id="resetcats">Reset to default</button></div>
        </div>
        <div class="row spread"><div class="grow">Forget what I've learned<div class="small soft">I remember what each file was, so a second scan is quick. Forget that to make me look at every file again.</div></div>
          <button class="btn danger" id="forget">Forget</button></div>
      </section>
      <section class="card small soft">
        <b>Sloth Sorter ${esc(S.st.version)}</b> · open source (MIT). Powered by open-weight models running through Ollama on this computer.
        It never uploads anything, and it never deletes your files.
      </section>`;

    const modelState = async () => {
      const el = $('#modelstate', main);
      if (!el) return;
      const ai = S.st.ai;
      const ok = ai.running && ai.models.some((m) => m === s.model || m === `${s.model}:latest`);
      el.innerHTML = ok ? '✓ This model is downloaded and ready.'
        : ai.running ? `This model isn't downloaded yet. <button class="btn" id="dlmodel" style="margin-left:8px">Download it</button>`
        : 'The AI engine isn\'t running. Finish setup on the Tidy tab.';
      const b = $('#dlmodel', main);
      if (b) b.onclick = () => { S.view = 'tidy'; S.selModel = s.model; saveSettings({ setupSkipped: false }).then(() => downloadModel(s.model)); };
    };
    modelState();

    const setModel = async (tag) => { if (!tag) return; await saveSettings({ model: tag, setupSkipped: false }); S.selModel = tag; await recheckAI(true); render(); };
    $('#useai', main).onchange = async (e) => { await saveSettings({ useAI: e.target.checked }); render(); };
    $$('input[name=m]', main).forEach((r) => (r.onchange = () => setModel(r.value)));
    $('#custom', main).onchange = (e) => setModel(e.target.value.trim());
    $('#vision', main).onchange = (e) => saveSettings({ useVision: e.target.checked });
    $('#rename', main).onchange = (e) => saveSettings({ rename: e.target.checked });
    $('#keep', main).onchange = (e) => saveSettings({ keepGoodNames: e.target.checked });
    $('#sorted', main).onchange = (e) => saveSettings({ sortedFolder: e.target.value.trim() || 'Sorted' });
    $('#savecats', main).onclick = async () => {
      const cats = [...new Set($('#cats', main).value.split('\n').map((c) => c.trim()).filter(Boolean))];
      if (!cats.length) return toast('Add at least one folder.');
      await saveSettings({ categories: cats }); toast('Folders saved.'); render();
    };
    $('#forget', main).onclick = async () => {
      const ok = await askSure({
        title: 'Forget what I\'ve learned?',
        text: 'I will look at every file again on the next scan, which can take a while. Your files and your history are not touched.',
        yes: 'Yes, forget',
      });
      if (!ok) return;
      await call('clear-cache');
      toast('Forgotten. The next scan will look at every file again.');
    };
    $('#resetcats', main).onclick = async () => { await saveSettings({ categories: S.st.defaultCategories }); toast('Back to the defaults.'); render(); };
  }

  // ---------- background polling ----------
  async function recheckAI(force = false) {
    const ai = await call('check-ai');
    if (!ai || ai.error) return;
    S.st.ai = ai;
    const sig = `${ai.installed}|${ai.running}|${ai.modelReady}|${S.st.settings.model}`;
    if (force || sig !== S.sigPrev) {
      const was = S.sigPrev;
      S.sigPrev = sig;
      if (was && !S.pull && (S.view === 'tidy' || S.view === 'settings')) {
        const typing = document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) && S.view === 'settings';
        if (!typing) render();
      } else renderChrome();
    }
  }

  // ---------- boot ----------
  async function boot() {
    await refreshState();
    S.selModel = S.st.settings.model;
    S.sigPrev = `${S.st.ai.installed}|${S.st.ai.running}|${S.st.ai.modelReady}|${S.st.settings.model}`;
    // If Ollama is installed but asleep, quietly wake it.
    if (S.st.settings.useAI && S.st.ai.installed && !S.st.ai.running) call('ollama-start').then(() => recheckAI());
    $$('#nav button').forEach((b) => (b.onclick = () => { S.view = b.dataset.view; render(); $('#main').scrollTop = 0; }));
    window.sloth.on('scan-progress', (p) => { S.progress = p; paintScanProgress(); });
    window.sloth.on('pull-progress', (p) => {
      if (!S.pull) return;
      S.pull = { ...S.pull, ...p };
      const bar = $('#pbar'); const txt = $('#ptext');
      if (bar && p.percent != null) { bar.parentElement.classList.remove('indeterminate'); bar.style.width = `${p.percent}%`; }
      if (txt) txt.innerHTML = pullText(S.pull);
    });
    window.sloth.on('perf-hint', (h) => { S.cpuOnly = h.cpuOnly; const el = $('#perf'); if (el) { el.innerHTML = perfText(); el.style.display = h.cpuOnly ? 'block' : 'none'; } });
    window.sloth.on('auto-ran', (r) => { S.lastAuto = { ...r, at: Date.now() }; toast(`Sleep mode tidied ${plural(r.moved, 'file', 'files')}.`); if (S.view === 'history' || S.view === 'sleep') render(); });
    window.sloth.on('state-changed', async () => { await refreshState(); render(); });
    render();
    setInterval(() => recheckAI(), 2500);
  }
  boot();
})();
