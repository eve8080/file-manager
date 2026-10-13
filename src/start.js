import http from 'node:http';
import { createApp } from './app.js';
import { createAuth } from './auth.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

// Builds the app from the config (both entry points share this, so settings such as MAX_UPLOAD_MB and
// AUTH_MODE are wired the same way), starts the HTTP server and prints where it is reachable. Success is logged
// only on the 'listening' event (Express 5's app.listen callback also runs on failure, so it isn't used).
export function start(storage, { host, port, maxUploadMb, auth }, label) {
  const app = createApp({
    storage,
    maxUploadBytes: Math.floor(maxUploadMb * 1024 * 1024),
    auth: auth.mode === 'cognito' ? createAuth(auth) : undefined,
  });
  const address = `${host.includes(':') ? `[${host}]` : host}:${port}`;
  const server = http.createServer(app);
  server.once('listening', () => {
    console.log(`${label} listening on http://${address}`);
    if (auth.mode === 'cognito') {
      console.log(`Login required (AUTH_MODE=cognito). Open ${auth.publicOrigin}/`);
    } else if (!LOOPBACK_HOSTS.has(host)) {
      console.warn(
        'WARNING: reachable from your network and has NO login. Use only on a trusted Wi-Fi; never expose to the internet.',
      );
    }
  });
  server.once('error', (err) => {
    const reason =
      err.code === 'EADDRINUSE' ? `${address} is already in use (EADDRINUSE). Set PORT to a free port.` : err.message;
    console.error(`Could not start server: ${reason}`);
    process.exit(1);
  });
  server.listen(port, host);
  return server;
}
