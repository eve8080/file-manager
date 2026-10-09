// Runs the app with in-memory sample data, for trying the UI without AWS.
// Everything is lost when the process exits.
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

// Sample files for the M3 previews: a real 96×64 PNG and a one-page PDF (both generated once, stored as base64).
const GRADIENT_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAGAAAABACAIAAABqVuVZAAABJ0lEQVR42u3QAWYCAABA0eognWSSJEkmySSTJEkmSZJMkmSSZJIkSZJkMpnJTtCxOsH+CT7vBC8YfrqHAgH9JxiOGMRBUYM4KGYQB8UN4qCEQRyUNIiDUgZxUNogDno2iIMyBnFQ1iAOyhnEQS8GcVDeIA4qGMRBrwZxUNEgDioZxEFlgzioYhAHVQ3ioJpBHFQ3iIPeDOKghkEc1DSIg1oGcVDbIA7qGMRBXYM4qGcQB70bxEF9gzhoYBAHDQ3ioJFBHDQ2iIM+DOKgiUEcNDWIg2YGcdDcIA76NIiDFgZx0NIgDloZxEFrgzhoYxAHbQ3ioJ1BHLQ3iIMOBnHQ0SAOOhnEQWeDOOjLIA66GMRB3wZx0NUgDvoxiIN+DeKgm0Ec9GcQeQDCnogB4u5e/AAAAABJRU5ErkJggg==';
const SAMPLE_PDF =
  'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAzMDAgMjAwXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA1IDAgUiA+PiA+PiAvQ29udGVudHMgNCAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA4OSA+PgpzdHJlYW0KQlQgL0YxIDI0IFRmIDQwIDE0MCBUZCAoRGVtbyBQREYpIFRqIDAgLTM2IFRkIC9GMSAxMiBUZiAoUHJldmlld2VkIGluIHRoZSBicm93c2VyLikgVGogRVQKZW5kc3RyZWFtCmVuZG9iago1IDAgb2JqCjw8IC9UeXBlIC9Gb250IC9TdWJ0eXBlIC9UeXBlMSAvQmFzZUZvbnQgL0hlbHZldGljYSA+PgplbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAowMDAwMDAwMjQxIDAwMDAwIG4gCjAwMDAwMDAzODAgMDAwMDAgbiAKdHJhaWxlcgo8PCAvU2l6ZSA2IC9Sb290IDEgMCBSID4+CnN0YXJ0eHJlZgo0NTAKJSVFT0YK';

const storage = createMemoryStorage({
  'readme.txt': 'Demo data. Nothing here is saved.',
  'Documents/': '',
  'Documents/notes.md': '# Notes\n\nHello.',
  'Documents/page.html': '<h1>Shown as text</h1>\n<script>alert("never runs")</script>\n',
  'Documents/sample.pdf': Buffer.from(SAMPLE_PDF, 'base64'),
  'Documents/Invoices/2026-09.csv': 'item,amount\nhosting,12.00\n',
  'Photos/': '',
  'Photos/gradient.png': Buffer.from(GRADIENT_PNG, 'base64'),
  'Photos/Holiday/beach.jpg': 'not really a jpeg',
  'Empty folder/': '',
});

start(storage, config, 'DEMO file manager (in-memory, not saved)');
