'use strict';
// A stand-in for Ollama, speaking the same HTTP API. Lets tests and demos run without a 3 GB download.
// "Smart" enough to be convincing: it reads the prompt and answers with schema-valid JSON.
const http = require('http');

function decide(prompt, categories, images = []) {
  const pick = (c) => (categories.includes(c) ? c : categories.includes('Other') ? 'Other' : categories[0]);
  const name = (prompt.match(/File name: (.*)/) || [])[1] || '';
  if (/FIRST PAGE of a scanned document/.test(prompt)) {
    // Prove the app really sent a rendered page: a real JPEG of reasonable size.
    const bin = Buffer.from(images[0] || '', 'base64');
    const isJpeg = bin.length > 4000 && bin[0] === 0xff && bin[1] === 0xd8;
    return isJpeg
      ? { category: pick('Documents'), title: 'Acme Robot 3000 Manual', date: '', summary: `Scanned manual page (${bin.length} byte JPEG).` }
      : { category: pick('Other'), title: 'Render Failed', date: '', summary: 'No usable page image.' };
  }
  const body = prompt.toLowerCase();
  const date = (prompt.match(/(\d{4}-\d{2}-\d{2})/g) || []).find((d) => !prompt.includes(`Last modified: ${d}`)) || '';
  if (/invoice|amount due|receipt|faktura/.test(body))
    return { category: pick('Bills & Receipts'), title: 'Hafslund Electricity Invoice', date, summary: 'An electricity invoice.' };
  if (/lecture|assignment|chapter \d|exam/.test(body))
    return { category: pick('School'), title: 'Biology Lecture Notes Week 4', date, summary: 'Lecture notes for a biology course.' };
  if (/quarterly|roadmap|meeting notes|agenda/.test(body))
    return { category: pick('Work'), title: 'Q3 Planning Meeting Notes', date, summary: 'Notes from a planning meeting.' };
  if (/dear |sincerely|kind regards/.test(body))
    return { category: pick('Documents'), title: 'Letter From Landlord About Lease', date, summary: 'A letter about a lease.' };
  if (/\.(png|jpe?g|heic)/i.test(name) && /picture is attached/.test(body))
    return { category: pick('Photos'), title: 'Dog On Beach At Sunset', date: '', summary: 'A dog on a beach.' };
  if (/\.(zip|rar|7z)/i.test(name)) return { category: pick('Archives'), title: 'Project Files Backup', date: '', summary: 'A zip archive.' };
  if (/\.(dmg|exe|pkg|msi)/i.test(name)) return { category: pick('Installers'), title: 'App Installer', date: '', summary: 'An installer.' };
  return { category: pick('Other'), title: 'Miscellaneous File', date: '', summary: 'Unknown file.' };
}

function startMock({ port = 0, models = ['gemma3:4b'], latencyMs = 0, pullMs = 2500 } = {}) {
  const state = { models: [...models], chatCalls: 0 };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      const json = (obj, code = 200) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      const body = raw ? JSON.parse(raw) : {};
      if (req.url === '/api/version') return json({ version: '0.99.0-mock' });
      if (req.url === '/api/tags') return json({ models: state.models.map((name) => ({ name })) });
      if (req.url === '/api/show') return json({ capabilities: ['completion', 'vision'] });
      if (req.url === '/api/chat') {
        state.chatCalls++;
        if (latencyMs) await new Promise((r) => setTimeout(r, latencyMs));
        const user = body.messages.find((m) => m.role === 'user');
        const cats = (body.format && body.format.properties.category.enum) || ['Other'];
        const out = decide(user.content, cats, user.images);
        return json({ message: { role: 'assistant', content: JSON.stringify(out) } });
      }
      if (req.url === '/api/pull') {
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        const total = 3_300_000_000;
        res.write(JSON.stringify({ status: 'pulling manifest' }) + '\n');
        const steps = 20;
        for (let i = 1; i <= steps; i++) {
          await new Promise((r) => setTimeout(r, pullMs / steps));
          res.write(JSON.stringify({ status: 'pulling model', total, completed: Math.round((total * i) / steps) }) + '\n');
        }
        if (!state.models.includes(body.model)) state.models.push(body.model);
        res.write(JSON.stringify({ status: 'success' }) + '\n');
        return res.end();
      }
      json({ error: 'not found' }, 404);
    });
  });
  return new Promise((resolve) =>
    server.listen(port, '127.0.0.1', () =>
      resolve({ server, state, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })
    )
  );
}

if (require.main === module) {
  const port = +process.argv[2] || 11500;
  const models = process.argv[3] === 'empty' ? [] : ['gemma3:4b'];
  startMock({ port, models, latencyMs: 350 }).then((m) => console.log(`mock ollama on ${m.url} models=${models}`));
}

module.exports = { startMock };
