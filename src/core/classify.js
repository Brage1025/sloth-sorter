'use strict';
// Ask the local model what a file is, with a safe fallback when it can't.
const path = require('path');
const ollama = require('./ollama');
const { extract } = require('./extract');
const { categoryByRules, SCREENSHOT_RE } = require('./rules');
const { buildName, looksMessy, validDate } = require('./naming');
const { CATEGORY_HINTS } = require('./config');
const { ResultCache } = require('./cache');

// Files the AI can't read anything inside. A model call would only restate the file type.
const TYPE_ONLY = new Set(['Installers', 'Archives', 'Music & Video']);

function humanSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

function buildSchema(categories) {
  return {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      category: { type: 'string', enum: categories },
      title: { type: 'string' },
      date: { type: 'string' },
    },
    required: ['summary', 'category', 'title', 'date'],
  };
}

function buildSystem(categories) {
  const list = categories
    .map((c) => (CATEGORY_HINTS[c] ? `- ${c}: ${CATEGORY_HINTS[c]}` : `- ${c}`))
    .join('\n');
  const lines = [
    "You help someone tidy their messy computer files. You are given a file's name, type, size,",
    'and sometimes a text excerpt or the picture itself. Reply with JSON only.',
    '',
    'Fields:',
    '- summary: one short sentence (at most 15 words) saying what the file is ABOUT.',
    '- category: exactly one of the allowed categories below.',
    '- title: a clear, human-friendly file name WITHOUT the extension, 2 to 6 words. Be specific: use the real',
    '  product, game, company, person or subject that appears in the content (for example "Dead or Alive Xtreme 2',
    '  Manual", never just "PDF Manual" or "Game Manual"). Write it in the same language as the content. No slashes.',
    '  For a manual or guide, end the title with "Manual" or "Guide" (for example "MP1840 Player Manual").',
    '- date: the date printed in the document itself, as YYYY-MM-DD. Only if it is clearly written in the content.',
    '  Otherwise an empty string. Never use today\'s date and never guess.',
    '',
    'Important:',
    '- Ignore legal notices, health and safety warnings, copyright text and contents lists at the start of a',
    '  document. Work out what the document is about overall.',
    '- If "Clues from the whole document" are given, product-style names and trademark or copyright lines are',
    '  strong evidence of the product or company. A manual should be named after the product it belongs to.',
    '- Do not name a document after a character, place or chapter inside it.',
    '- Excerpts may come from different places in a long document. The title must describe the WHOLE document',
    '  (for a manual: the product or game it is for, often named in headers, footers or the legal text), not',
    '  just one section such as a list of characters or a chapter heading.',
    '- If you cannot tell what it is, say so in the summary and keep the title short. Never guess a specific name.',
  ];
  if (categories.includes('Documents'))
    lines.push('- A story, list, manual, guide, letter or notes is "Documents", even when the topic is games or hobbies.');
  if (categories.includes('Code & Data'))
    lines.push('- "Code & Data" is only for programming source code, spreadsheets, databases and data files.');
  if (categories.includes('Other')) lines.push('- Use "Other" only as a last resort.');
  lines.push('', 'Allowed categories:', list);
  return lines.join('\n');
}

function buildPrompt({ name, size }, snippet) {
  const lines = [
    `File name: ${name}`,
    `Type: ${path.extname(name).replace('.', '').toUpperCase() || 'unknown'}`,
    `Size: ${humanSize(size)}`,
  ];
  if (snippet.pages) lines.push(`Pages: ${snippet.pages}`);
  if (snippet.kind === 'text') {
    lines.push('', snippet.pages > 1 ? 'Excerpts from different pages (separated by ---):' : 'Beginning of the file:', '"""', snippet.text, '"""');
  }
  else if (snippet.kind === 'image' && snippet.pageImage)
    lines.push('', 'The attached picture is the FIRST PAGE of a scanned document. Read its title and any product, company or person names on it.');
  else if (snippet.kind === 'image') lines.push('', 'The picture is attached.');
  else lines.push('', '(No readable content, judge by the name and type.)');
  return lines.join('\n');
}

/** The model sometimes invents dates (or echoes today's). Only keep one that can be justified. */
function trustDate(date, snippet, file) {
  if (!validDate(date)) return '';
  if (snippet.kind === 'image') return ''; // vision models misread digits; a wrong date in a name is worse than none
  const local = (d) => d.toLocaleDateString('sv-SE'); // YYYY-MM-DD in local time
  const banned = [new Date(file.mtime), new Date()].flatMap((d) => [d.toISOString().slice(0, 10), local(d)]);
  if (banned.includes(date)) return '';
  if (snippet.kind === 'text' && !snippet.text.includes(date.slice(0, 4))) return ''; // year not in the text
  return date;
}

const DOC_EXTS = new Set(['.pdf', '.doc', '.docx', '.txt', '.md', '.rtf', '.odt', '.epub']);

/** Small models over-use "Other" and "Code & Data". Overrule them when the file type is obvious. */
function sanityCheckCategory(category, fileName, categories) {
  const ext = path.extname(fileName).toLowerCase();
  if (category === 'Other') {
    const byType = categoryByRules(fileName, categories);
    if (byType !== 'Other') return byType;
  }
  if (category === 'Code & Data' && DOC_EXTS.has(ext) && categories.includes('Documents')) return 'Documents';
  return category;
}

/**
 * Create a classifier bound to the user's settings.
 * `imageEncoder(path)` shrinks a picture and returns base64 (supplied by the Electron main process).
 */
function createClassifier(settings, { imageEncoder, pdfRenderer, signal, onStats, cache } = {}) {
  const categories = settings.categories;
  const schema = buildSchema(categories);
  const system = buildSystem(categories);
  let visionPromise = null;
  const canSee = () => (visionPromise ||= ollama.supportsVision(settings.host, settings.model));

  return async function classify(file) {
    const fallback = () => ({
      category: categoryByRules(file.name, categories),
      newName: file.name,
      reason: 'Sorted by file type (no AI)',
      source: 'rules',
    });
    if (!settings.useAI) return fallback();

    // Obvious by type (installer, zip, song, screenshot): no need to wake the model up.
    const byType = categoryByRules(file.name, categories);
    const isScreenshot = SCREENSHOT_RE.test(path.basename(file.name, path.extname(file.name)));
    if (TYPE_ONLY.has(byType) || (isScreenshot && byType === 'Screenshots')) {
      return { ...fallback(), reason: 'Sorted by file type' };
    }

    const cacheKey = cache && ResultCache.key(file, settings);
    const hit = cache && cache.get(cacheKey);
    if (hit) return { ...hit, fromCache: true };

    try {
      const wantImage = !!imageEncoder && settings.useVision !== false && (await canSee());
      const snippet = await extract(file.path, { imageEncoder, wantImage, pdfRenderer });
      const res = await ollama.chatJSON({
        host: settings.host,
        model: settings.model,
        system,
        prompt: buildPrompt(file, snippet),
        schema,
        images: snippet.kind === 'image' ? [snippet.image] : undefined,
        signal,
        onStats: onStats && ((j) => onStats({ file: file.name, kind: snippet.kind, snippet: snippet.text, ...j })),
      });

      const picked = categories.includes(res.category) ? res.category : categoryByRules(file.name, categories);
      const category = sanityCheckCategory(picked, file.name, categories);
      const ext = path.extname(file.name);
      const origBase = path.basename(file.name, ext);
      let newName = file.name;
      const shouldRename = settings.rename && (!settings.keepGoodNames || looksMessy(origBase));
      if (shouldRename) newName = buildName({ title: res.title, date: trustDate(res.date, snippet, file), original: file.name });

      const basis = snippet.kind === 'text' ? 'text' : snippet.kind === 'image' ? 'image' : snippet.scanned ? 'scanned' : 'name';
      const result = { category, newName, reason: String(res.summary || '').slice(0, 200), source: 'ai', basis };
      if (cache) cache.set(cacheKey, result);
      return result;
    } catch (err) {
      if (signal && signal.aborted) throw err;
      const f = fallback();
      f.reason = 'Sorted by file type (the AI could not read this one)';
      return f;
    }
  };
}

module.exports = { createClassifier, buildSchema, buildSystem, buildPrompt };
