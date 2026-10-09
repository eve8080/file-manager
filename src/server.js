import { loadConfig } from './config.js';
import { start } from './start.js';
import { createS3Storage } from './storage/s3.js';

let config;
try {
  config = loadConfig(process.env);
} catch (err) {
  console.error(`Configuration error: ${err.message}`);
  process.exit(1);
}

const storage = createS3Storage({ bucket: config.bucket, region: config.region });
start(storage, config, `File manager (bucket "${config.bucket}")`);
