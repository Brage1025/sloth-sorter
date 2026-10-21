'use strict';
// Shared defaults. Pure data, no Electron imports, so everything here is testable in plain Node.

const DEFAULT_CATEGORIES = [
  'Documents',
  'Bills & Receipts',
  'Work',
  'School',
  'Photos',
  'Screenshots',
  'Music & Video',
  'Installers',
  'Archives',
  'Code & Data',
  'Other',
];

// Short hints help small models choose well. Custom categories simply get no hint.
const CATEGORY_HINTS = {
  Documents: 'any ordinary written document: letters, forms, contracts, manuals, guides, stories, lists, notes, PDFs, Word and text files about everyday things or hobbies',
  'Bills & Receipts': 'invoices, receipts, bank statements, tax papers, tickets, orders',
  Work: 'reports, presentations, meeting notes, CVs, business documents',
  School: 'lecture notes, assignments, study material, papers, course files',
  Photos: 'pictures taken with a camera or phone, images, graphics',
  Screenshots: 'screen captures',
  'Music & Video': 'audio and video files',
  Installers: 'programs and app installers',
  Archives: 'zip, rar, tar and other compressed bundles',
  'Code & Data': 'ONLY programming source code, spreadsheets, databases and data/config files, not ordinary text documents',
  Other: 'last resort, only when nothing else fits',
};

// Models we suggest in the UI. Any tag from the Ollama library works.
const SUGGESTED_MODELS = [
  {
    tag: 'gemma3:4b',
    label: 'Balanced (recommended)',
    size: '≈3.3 GB',
    note: 'Reads documents and looks at photos. Needs about 8 GB RAM.',
  },
  {
    tag: 'gemma3:1b',
    label: 'Tiny & quick',
    size: '≈0.8 GB',
    note: 'Text only, great for older laptops. Less clever with names.',
  },
  {
    tag: 'llama3.2:3b',
    label: 'Good all-rounder',
    size: '≈2 GB',
    note: 'Text only. Solid and light.',
  },
  {
    tag: 'qwen2.5:7b',
    label: 'Smarter',
    size: '≈4.7 GB',
    note: 'Better naming. Wants 16 GB RAM.',
  },
];

const DEFAULT_SETTINGS = {
  folder: '', // filled in by main with the user's Downloads folder
  model: 'gemma3:4b',
  host: 'http://127.0.0.1:11434',
  categories: DEFAULT_CATEGORIES,
  useAI: true,
  useVision: true, // look at photos too (slower on computers without a good graphics card)
  rename: true,
  keepGoodNames: true,
  theme: 'dark', // 'dark' | 'light' | 'system'
  sortedFolder: 'Sorted',
  autoMode: false,
  autoMinutes: 5, // how long a file must sit untouched before auto mode picks it up
  startAtLogin: false,
  setupSkipped: false,
};

module.exports = { DEFAULT_CATEGORIES, CATEGORY_HINTS, SUGGESTED_MODELS, DEFAULT_SETTINGS };
