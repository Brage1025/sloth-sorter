'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { startMock } = require('./mock-ollama');
const ollama = require('../src/core/ollama');
const { createClassifier } = require('../src/core/classify');
const { buildPlan, applyPlan, undoMoves, scanFolder } = require('../src/core/planner');
const { sanitizeBase, looksMessy, buildName, validDate, isGenericTitle } = require('../src/core/naming');
const { categoryByRules } = require('../src/core/rules');
const { extract, pdfClues } = require('../src/core/extract');
const { DEFAULT_SETTINGS, DEFAULT_CATEGORIES } = require('../src/core/config');
const { HistoryStore } = require('../src/core/history');
const http = require('http');
const { ResultCache } = require('../src/core/cache');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sloth-'));
const write = (dir, name, content = 'x') => {
  fs.writeFileSync(path.join(dir, name), content);
  return path.join(dir, name);
};
const settingsFor = (folder, extra = {}) => ({ ...DEFAULT_SETTINGS, categories: DEFAULT_CATEGORIES, folder, ...extra });

test('naming: sanitising and messy-name detection', () => {
  assert.equal(sanitizeBase('Bad/Name: with*illegal?chars'), 'Bad Name with illegal chars');
  assert.equal(sanitizeBase('con'), 'con_');
  assert.equal(sanitizeBase('...hidden...'), 'hidden');
  assert.ok(looksMessy('IMG_2231'));
  assert.ok(looksMessy('scan0001'));
  assert.ok(looksMessy('20260301_142233'));
  assert.ok(looksMessy('final'));
  assert.ok(!looksMessy('Tax return 2025 final'));
  assert.ok(validDate('2026-09-14'));
  assert.ok(!validDate('2026-13-40'));
  assert.ok(!validDate('yesterday'));
  assert.equal(buildName({ title: 'Electricity Invoice', date: '2026-09-14', original: 'scan0001.pdf' }), '2026-09-14 Electricity Invoice.pdf');
  assert.equal(buildName({ title: 'Report.pdf', date: '', original: 'x1.pdf' }), 'Report.pdf');
  assert.equal(buildName({ title: '', date: '', original: 'keep.pdf' }), 'keep.pdf');
});

test('rules: category by type, screenshots, and fitting custom lists', () => {
  assert.equal(categoryByRules('Screenshot 2026-10-01 at 10.00.png', DEFAULT_CATEGORIES), 'Screenshots');
  assert.equal(categoryByRules('invoice-123.pdf', DEFAULT_CATEGORIES), 'Bills & Receipts');
  assert.equal(categoryByRules('setup.dmg', DEFAULT_CATEGORIES), 'Installers');
  assert.equal(categoryByRules('weird.xyz', DEFAULT_CATEGORIES), 'Other');
  assert.equal(categoryByRules('setup.dmg', ['Stuff', 'Other']), 'Other');
});

test('scanFolder skips folders, hidden, partial downloads and very fresh files', () => {
  const d = tmp();
  write(d, 'a.pdf');
  write(d, '.hidden');
  write(d, 'big.crdownload');
  write(d, '~$lock.docx');
  write(d, 'Thumbs.db');
  fs.mkdirSync(path.join(d, 'subfolder'));
  write(path.join(d, 'subfolder'), 'inner.txt');
  assert.deepEqual(scanFolder(d).map((f) => f.name), ['a.pdf']);
  assert.equal(scanFolder(d, { minAgeMs: 60_000 }).length, 0); // just created = still "in use"
});

test('extract reads text, pdf-less docs and skips binaries', async () => {
  const d = tmp();
  const t = write(d, 'a.txt', 'Dear tenant,\n\n\n\nYour lease  ends soon.');
  assert.equal((await extract(t)).text, 'Dear tenant,\n\nYour lease ends soon.');
  const b = write(d, 'b.txt', Buffer.from([0, 1, 2, 3]));
  assert.equal((await extract(b)).kind, 'none');
  const html = write(d, 'c.html', '<html><style>x{}</style><body><h1>Hello</h1></body></html>');
  assert.equal((await extract(html)).text, 'Hello');
  assert.equal((await extract(path.join(d, 'nope.pdf'))).kind, 'none');
});

test('end to end with a (mock) Ollama: plan, apply, undo', async () => {
  const mock = await startMock();
  const folder = tmp();
  write(folder, 'scan0001.txt', 'INVOICE\nAmount due: 1 450 kr\nIssued 2026-09-14\nHafslund');
  write(folder, 'IMG_2231.txt', 'Dear tenant, kind regards, your landlord');
  write(folder, 'Great Holiday Plans.txt', 'Some notes about the agenda for the roadmap'); // already a good name
  write(folder, 'installer.dmg', Buffer.from([0, 1, 2]));
  write(folder, 'Screenshot 2026-10-01 at 10.00.png', Buffer.from([0, 1, 2]));

  const settings = settingsFor(folder, { host: mock.url });
  const st = await ollama.status(mock.url);
  assert.ok(st.running && ollama.hasModel(st.models, 'gemma3:4b'));

  const seen = [];
  const items = await buildPlan(settings, createClassifier(settings), { onProgress: (p) => seen.push(p.done) });
  assert.equal(items.length, 5);
  assert.ok(seen.includes(5));
  const by = Object.fromEntries(items.map((i) => [i.name, i]));
  assert.equal(by['scan0001.txt'].category, 'Bills & Receipts');
  assert.equal(by['scan0001.txt'].newName, '2026-09-14 Hafslund Electricity Invoice.txt');
  assert.equal(by['IMG_2231.txt'].category, 'Documents');
  assert.equal(by['Great Holiday Plans.txt'].newName, 'Great Holiday Plans.txt'); // kept: already readable
  assert.equal(by['Great Holiday Plans.txt'].category, 'Work');
  assert.equal(by['installer.dmg'].category, 'Installers');

  const choices = items.map((i) => ({ from: i.from, category: i.category, newName: i.newName }));
  // The user edits one name in the review screen:
  choices.find((c) => c.from.endsWith('installer.dmg')).newName = 'My App Setup';
  const { moves, failed } = applyPlan(settings, choices);
  assert.equal(failed.length, 0);
  assert.equal(moves.length, 5);
  assert.ok(fs.existsSync(path.join(folder, 'Sorted', 'Bills & Receipts', '2026-09-14 Hafslund Electricity Invoice.txt')));
  assert.ok(fs.existsSync(path.join(folder, 'Sorted', 'Installers', 'My App Setup.dmg'))); // extension preserved
  assert.deepEqual(fs.readdirSync(folder).sort(), ['Sorted']);

  const r = undoMoves(moves);
  assert.equal(r.restored, 5);
  assert.deepEqual(fs.readdirSync(folder).sort(), [
    'Great Holiday Plans.txt', 'IMG_2231.txt', 'Screenshot 2026-10-01 at 10.00.png', 'installer.dmg', 'scan0001.txt',
  ]); // and the empty Sorted folder is gone
  mock.close();
});

test('falls back to rules when the AI is unreachable, and when AI is switched off', async () => {
  const folder = tmp();
  write(folder, 'photo.jpg', 'x');
  write(folder, 'notes.pdf', 'x');
  for (const settings of [
    settingsFor(folder, { host: 'http://127.0.0.1:1' }), // nothing listening
    settingsFor(folder, { useAI: false }),
  ]) {
    const items = await buildPlan(settings, createClassifier(settings));
    const by = Object.fromEntries(items.map((i) => [i.name, i]));
    assert.equal(by['photo.jpg'].category, 'Photos');
    assert.equal(by['notes.pdf'].category, 'Documents');
    assert.equal(by['notes.pdf'].source, 'rules');
    assert.equal(by['notes.pdf'].newName, 'notes.pdf'); // never renames without the AI
  }
});

test('never overwrites: collisions get a number, existing files survive', () => {
  const folder = tmp();
  const settings = settingsFor(folder);
  fs.mkdirSync(path.join(folder, 'Sorted', 'Documents'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'Sorted', 'Documents', 'Report.pdf'), 'OLD');
  const a = write(folder, 'a.pdf', 'A');
  const b = write(folder, 'b.pdf', 'B');
  const { moves } = applyPlan(settings, [
    { from: a, category: 'Documents', newName: 'Report.pdf' },
    { from: b, category: 'Documents', newName: 'Report.pdf' },
  ]);
  assert.equal(fs.readFileSync(path.join(folder, 'Sorted', 'Documents', 'Report.pdf'), 'utf8'), 'OLD');
  assert.equal(fs.readFileSync(moves[0].to, 'utf8'), 'A');
  assert.equal(fs.readFileSync(moves[1].to, 'utf8'), 'B');
  assert.notEqual(moves[0].to, moves[1].to);
});

test('refuses to move files from outside the chosen folder or invalid paths', () => {
  const folder = tmp();
  const other = tmp();
  const outside = write(other, 'secret.txt', 'nope');
  const { moves, failed } = applyPlan(settingsFor(folder), [
    { from: outside, category: 'Documents', newName: 'x' },
    { from: path.join(folder, 'missing.txt'), category: 'Documents', newName: 'x' },
  ]);
  assert.equal(moves.length, 0);
  assert.equal(failed.length, 2);
  assert.ok(fs.existsSync(outside));
});

test('category and name injection cannot escape the Sorted folder', () => {
  const folder = tmp();
  const f = write(folder, 'a.txt', 'A');
  const { moves } = applyPlan(settingsFor(folder), [{ from: f, category: '../../etc', newName: '../../evil' }]);
  assert.ok(moves[0].to.startsWith(path.join(folder, 'Sorted') + path.sep));
});

test('undo leaves a file alone if it was already moved away by the user', () => {
  const folder = tmp();
  const f = write(folder, 'a.txt', 'A');
  const { moves } = applyPlan(settingsFor(folder), [{ from: f, category: 'Documents', newName: 'a' }]);
  fs.unlinkSync(moves[0].to);
  const r = undoMoves(moves);
  assert.equal(r.restored, 0);
  assert.equal(r.missing.length, 1);
});

test('history persists, caps and marks undone', () => {
  const d = tmp();
  const file = path.join(d, 'h.json');
  const h = new HistoryStore(file, 2);
  const b1 = h.add({ folder: 'f', moves: [{ from: '/a/x', to: '/a/Sorted/x' }] });
  h.add({ folder: 'f', moves: [] });
  h.add({ folder: 'f', moves: [] });
  assert.equal(h.list().length, 2);
  const h2 = new HistoryStore(file, 2);
  assert.equal(h2.list().length, 2);
  assert.equal(h2.get(b1.id), undefined);
  h2.markUndone(h2.list()[0].id);
  assert.ok(new HistoryStore(file).list()[0].undone);
});

test('model download streams progress', async () => {
  const mock = await startMock({ models: [], pullMs: 200 });
  const pct = [];
  await ollama.pull(mock.url, 'gemma3:4b', (p) => p.percent != null && pct.push(p.percent));
  assert.equal(pct[pct.length - 1], 100);
  assert.ok(ollama.hasModel((await ollama.status(mock.url)).models, 'gemma3:4b'));
  mock.close();
});

test('messy-name detection catches the real-world cases from user testing', () => {
  for (const n of ['down-img', 'down-img (1)', 'down-img (2)', 'asdgawgwagasdf', '453754rtyrghf', '12122012', 'asdf (1)', 'manual', 'download (1)', 'IMG__01', '!IMG__203', '19793507']) {
    assert.ok(looksMessy(n), `${n} should count as messy`);
  }
  for (const n of ['jace_tribal_multiverse_reforged_rebuilt', 'lost recipt', 'Tax return 2025', 'Great Holiday Plans']) {
    assert.ok(!looksMessy(n), `${n} should count as good`);
  }
});

/** A fake Ollama whose answer we control, to test how the app treats imperfect model output. */
function fakeOllama(answer, { vision = false } = {}) {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url === '/api/show') return res.end(JSON.stringify({ capabilities: vision ? ['completion', 'vision'] : [] }));
      const body = JSON.parse(raw || '{}');
      const user = (body.messages || []).find((m) => m.role === 'user');
      res.end(JSON.stringify({ message: { content: JSON.stringify(answer(user ? user.content : '')) } }));
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${server.address().port}`, close: () => { server.close(); server.closeAllConnections(); } })));
}

test('prompt no longer leaks the file date, and a made-up or "today" date is thrown away', async () => {
  const today = new Date().toISOString().slice(0, 10);
  let prompt = '';
  const fake = await fakeOllama((p) => { prompt = p; return { summary: 'x', category: 'Documents', title: 'Some Manual', date: today }; });
  const folder = tmp();
  write(folder, 'x1.txt', 'hello there');
  const settings = settingsFor(folder, { host: fake.url });
  const [item] = await buildPlan(settings, createClassifier(settings));
  assert.ok(!/last modified/i.test(prompt), 'file modification date must not be sent to the model');
  assert.equal(item.newName, 'Some Manual.txt'); // no date prefix
  fake.close();
});

test('a date is kept only when its year really appears in the text', async () => {
  const fake = await fakeOllama(() => ({ summary: 'x', category: 'Bills & Receipts', title: 'Power Bill', date: '2024-03-09' }));
  const folder = tmp();
  write(folder, 'a1.txt', 'Invoice date 9 March 2024, amount due 100');
  write(folder, 'b1.txt', 'Invoice with no year anywhere, amount due 100');
  const settings = settingsFor(folder, { host: fake.url });
  const items = await buildPlan(settings, createClassifier(settings));
  const by = Object.fromEntries(items.map((i) => [i.name, i.newName]));
  assert.equal(by['a1.txt'], '2024-03-09 Power Bill.txt');
  assert.equal(by['b1.txt'], 'Power Bill.txt');
  fake.close();
});

test('safety net: "Other" for a photo/document and "Code & Data" for a text file are corrected', async () => {
  const fakeOther = await fakeOllama(() => ({ summary: 'x', category: 'Other', title: 'Something', date: '' }));
  const folder = tmp();
  write(folder, 'pic1.jpg', 'x');
  write(folder, 'story1.docx', 'x');
  write(folder, 'mystery.xyz', 'x');
  let settings = settingsFor(folder, { host: fakeOther.url });
  let items = await buildPlan(settings, createClassifier(settings));
  let by = Object.fromEntries(items.map((i) => [i.name, i.category]));
  assert.equal(by['pic1.jpg'], 'Photos');
  assert.equal(by['story1.docx'], 'Documents');
  assert.equal(by['mystery.xyz'], 'Other'); // genuinely unknown stays Other
  fakeOther.close();

  const fakeData = await fakeOllama(() => ({ summary: 'x', category: 'Code & Data', title: 'Card List', date: '' }));
  const f2 = tmp();
  write(f2, 'cards1.txt', 'a list of cards');
  write(f2, 'data1.csv', 'a,b');
  settings = settingsFor(f2, { host: fakeData.url });
  items = await buildPlan(settings, createClassifier(settings));
  by = Object.fromEntries(items.map((i) => [i.name, i.category]));
  assert.equal(by['cards1.txt'], 'Documents');
  assert.equal(by['data1.csv'], 'Code & Data'); // a real data file stays
  fakeData.close();
});

test('PDF: samples later pages so a manual that opens with a health warning is still identified', async () => {
  const r = await extract(path.join(__dirname, 'fixtures', 'game-manual.pdf'));
  if (r.kind !== 'text') {
    const raw = fs.readFileSync(path.join(__dirname, 'fixtures', 'game-manual.pdf'));
    let crlf = 0;
    for (let i = 1; i < raw.length; i++) if (raw[i] === 10 && raw[i - 1] === 13) crlf++;
    const expected = ['8a53f0', '28eba7', '65fb54', '6ecd31', 'a7da79', 'e4c194', '2945e6', 'ec0e46', 'f40a1e', '150222', '605b4e', '6e4f82', '1ee26e', 'd6be6e', '04a56f', 'b41f03', '89d974', '1711c9', '670b27', '509687', 'f0f024'];
    const got = [];
    for (let i = 0; i < raw.length; i += 1024) got.push(require('crypto').createHash('sha256').update(raw.subarray(i, i + 1024)).digest('hex').slice(0, 6));
    const diff = got.map((h, i) => (h === expected[i] ? null : i)).filter((x) => x !== null);
    assert.fail(`could not read the fixture: ${r.error}\nfile size ${raw.length} bytes (expected 21325), ${crlf} CRLF pairs (expected 0)\nKB blocks that differ from the original: ${JSON.stringify(diff)}`);
  }
  assert.ok(/Dead or Alive Xtreme 2/.test(r.text), 'later page content must reach the model');
  assert.ok(/PDF title: Game Manual/.test(r.text), 'PDF metadata title is included');
});

test('speed: installers, archives, music and screenshots never wake the model', async () => {
  const mock = await startMock();
  const folder = tmp();
  for (const n of ['setup.exe', 'backup.zip', 'song.mp3', 'Screenshot 2026-10-01 at 10.00.png']) write(folder, n, 'x');
  const settings = settingsFor(folder, { host: mock.url });
  const items = await buildPlan(settings, createClassifier(settings));
  assert.equal(mock.state.chatCalls, 0);
  const by = Object.fromEntries(items.map((i) => [i.name, i.category]));
  assert.deepEqual(by, { 'setup.exe': 'Installers', 'backup.zip': 'Archives', 'song.mp3': 'Music & Video', 'Screenshot 2026-10-01 at 10.00.png': 'Screenshots' });
  mock.close();
});

test('speed: a second scan of unchanged files is answered from the cache', async () => {
  const mock = await startMock();
  const folder = tmp();
  write(folder, 'a1.txt', 'INVOICE amount due 100 issued 2026-09-14');
  write(folder, 'b1.txt', 'Dear tenant, kind regards');
  const settings = settingsFor(folder, { host: mock.url });
  const cache = new ResultCache(path.join(tmp(), 'cache.json'));
  const first = await buildPlan(settings, createClassifier(settings, { cache }));
  assert.equal(mock.state.chatCalls, 2);
  const second = await buildPlan(settings, createClassifier(settings, { cache }));
  assert.equal(mock.state.chatCalls, 2, 'no new model calls');
  assert.deepEqual(second.map((i) => [i.category, i.newName]), first.map((i) => [i.category, i.newName]));
  // changing the model (or the file) invalidates the entry
  await buildPlan({ ...settings, model: 'other:1b' }, createClassifier({ ...settings, model: 'other:1b' }, { cache }));
  assert.equal(mock.state.chatCalls, 4);
  // survives a restart
  cache.flush();
  assert.equal(new ResultCache(cache.file).map.size, cache.map.size);
  mock.close();
});

test('PDF: a long manual is identified from its last page even though the start is all warnings and characters', async () => {
  const r = await extract(path.join(__dirname, 'fixtures', 'long-manual.pdf'));
  assert.equal(r.kind, 'text');
  assert.equal(r.pages, 14);
  assert.ok(/Dead or Alive Xtreme 2 is a trademark/.test(r.text), 'last page must be sampled');
  assert.ok(/\[page 1\].*Warning/is.test(r.text) && /\[page 8\]/.test(r.text), 'start and middle sampled too');
  assert.ok(!/\[page 5\]/.test(r.text), 'but not every page (keeps the prompt short)');
});

test('PDF with no text is reported as scanned so the UI can say why it was judged by name', async () => {
  const folder = tmp();
  // A valid-but-empty PDF: one blank page.
  const blank = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF';
  const f = write(folder, 'manual.pdf', blank);
  const r = await extract(f);
  assert.equal(r.kind, 'none');
});

test('generic titles such as "PDF Manual" are rejected, specific ones kept', () => {
  assert.ok(isGenericTitle('PDF Manual'));
  assert.ok(isGenericTitle('User Guide'));
  assert.ok(isGenericTitle('Document'));
  assert.ok(!isGenericTitle('Dead or Alive Xtreme 2 Manual'));
  assert.ok(!isGenericTitle('MP1840 Player Manual'));
  assert.equal(buildName({ title: 'PDF Manual', date: '', original: 'manual.pdf' }), 'manual.pdf');
});

test('the classifier reports what it based its answer on', async () => {
  const fake = await fakeOllama(() => ({ summary: 's', category: 'Documents', title: 'Some Real Title', date: '' }));
  const folder = tmp();
  write(folder, 'note1.txt', 'plenty of readable text in here');
  write(folder, 'blob1.docx', 'not really a docx');
  const settings = settingsFor(folder, { host: fake.url });
  const items = await buildPlan(settings, createClassifier(settings));
  const by = Object.fromEntries(items.map((i) => [i.name, i.basis]));
  assert.equal(by['note1.txt'], 'text');
  assert.equal(by['blob1.docx'], 'name');
  fake.close();
});

test('clues: trademark/copyright lines and product-style names are pulled from the whole document', () => {
  const pages = [
    'WARNING Before playing, read the manual. Seizure risk.',
    'Chapter 2. Characters Kasumi and Leifang.',
    'Display information about ACME ROBOT 3000 Deluxe 2 and erase saved data.',
    'ACME ROBOT 3000 is a registered trademark of Acme Corporation. \u00a9 2006 ACME CORP. All rights reserved.',
    'IN NO EVENT SHALL ACME BE LIABLE FOR CONSEQUENTIAL DAMAGES. LIMITED WARRANTY',
  ];
  const c = pdfClues(pages);
  assert.ok(/trademark of Acme Corporation/.test(c), c);
  assert.ok(/\u00a9 ACME CORP/.test(c), c);
  assert.ok(/Product-style names: .*ACME ROBOT 3000/.test(c), c);
  assert.ok(!/LIABLE|WARRANTY/.test(c), 'warranty boilerplate is not a product name');
  assert.equal(pdfClues(['just some ordinary lowercase text here']), '');
});

test('scanned PDF: no text layer -> rendered page image goes to a seeing model, otherwise flagged as scanned', async () => {
  const f = path.join(__dirname, 'fixtures', 'scanned-manual.pdf');
  const blind = await extract(f, { wantImage: true }); // no renderer available
  assert.equal(blind.kind, 'none');
  assert.equal(blind.scanned, true);
  const seeing = await extract(f, { wantImage: true, pdfRenderer: async () => 'QUJD' });
  assert.equal(seeing.kind, 'image');
  assert.equal(seeing.pageImage, true);
  assert.equal(seeing.image, 'QUJD');
  const notAllowed = await extract(f, { wantImage: false, pdfRenderer: async () => 'QUJD' }); // photo reading off
  assert.equal(notAllowed.kind, 'none');
});

test('clues keep connector words in names, and junk PDF titles are not passed on', async () => {
  const c = pdfClues(['Dead or Alive Xtreme 2 is a trademark of Tecmo Koei. Xbox 360 is a trademark of Microsoft.']);
  assert.ok(/Dead or Alive Xtreme 2 is a trademark of Tecmo Koei/.test(c), c);
  const r = await extract(path.join(__dirname, 'fixtures', 'long-manual.pdf')); // its embedded title is "about:blank"
  assert.ok(!/PDF title/.test(r.text), 'about:blank must not reach the model');
});

test('dates read from a picture are never put in a file name, but dates from text still are', async () => {
  const fake = await fakeOllama(() => ({ summary: 'x', category: 'Bills & Receipts', title: 'Shop Receipt', date: '2019-11-20' }), { vision: true });
  const folder = tmp();
  write(folder, 'r1.png', 'x');
  write(folder, 't1.txt', 'Receipt from 20 November 2019, total 100');
  const settings = settingsFor(folder, { host: fake.url });
  const items = await buildPlan(settings, createClassifier(settings, { imageEncoder: async () => 'QUJD' }));
  const by = Object.fromEntries(items.map((i) => [i.name, i.newName]));
  assert.equal(by['r1.png'], 'Shop Receipt.png');
  assert.equal(by['t1.txt'], '2019-11-20 Shop Receipt.txt');
  fake.close();
});

test('cache: clear() forgets everything, also on disk', () => {
  const c = new ResultCache(path.join(tmp(), 'cache.json'));
  c.set('a', { x: 1 }); c.set('b', { x: 2 });
  assert.equal(c.clear(), 2);
  assert.equal(c.get('a'), undefined);
  assert.equal(new ResultCache(c.file).map.size, 0);
});
