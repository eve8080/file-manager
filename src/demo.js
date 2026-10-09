// Runs the app with in-memory sample data, for trying the UI without AWS.
// Everything is lost when the process exits.
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { start } from './start.js';
import { createMemoryStorage } from './storage/memory.js';

let config;
try {
  config = loadConfig(process.env, { requireS3: false });
} catch (err) {
  console.error(`Configuration error: ${err.message}`);
  process.exit(1);
}

const storage = createMemoryStorage({
  'readme.txt': 'Demo data. Nothing here is saved.',
  'Documents/': '',
  'Documents/notes.md': '# Notes\n\nHello.',
  'Documents/Invoices/2026-09.csv': 'item,amount\nhosting,12.00\n',
  'Photos/': '',
  'Photos/Holiday/beach.jpg': 'not really a jpeg',
  'Empty folder/': '',
});

start(createApp({ storage }), config, 'DEMO file manager (in-memory, not saved)');
