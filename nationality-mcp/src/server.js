// Node entrypoint — this is what runs in the container on the NAS.
// It adapts node:http onto the web Request/Response handler in app.js.

import http from 'node:http';
import app from './app.js';

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '0.0.0.0';
const MAX_BODY_BYTES = 256 * 1024;

// Only the settings the handler actually reads. Both are optional.
const env = {
  NATIONALIZE_API_KEY: process.env.NATIONALIZE_API_KEY,
  AUTH_TOKEN: process.env.AUTH_TOKEN,
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function toWebRequest(req, body) {
  const host = req.headers.host ?? `${HOST}:${PORT}`;
  const url = new URL(req.url, `http://${host}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(key, v);
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && body.length > 0;
  return new Request(url, { method: req.method, headers, body: hasBody ? body : undefined });
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  try {
    const body = await readBody(req);
    const response = await app.fetch(toWebRequest(req, body), env);
    const payload = Buffer.from(await response.arrayBuffer());

    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(payload);

    // One line per request, so `docker logs` is enough to see what Claude is doing.
    console.log(
      `${req.method} ${req.url} -> ${response.status} (${Date.now() - started}ms)`,
    );
  } catch (err) {
    const tooLarge = err.message === 'Request body too large.';
    console.error(`${req.method} ${req.url} -> ${tooLarge ? 413 : 500}: ${err.message}`);
    if (res.headersSent) {
      res.end();
      return;
    }
    res.writeHead(tooLarge ? 413 : 500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`buildx-nationality listening on http://${HOST}:${PORT}`);
  console.log(`  MCP endpoint : POST /mcp`);
  console.log(`  REST         : GET /api/nationality?name=…  GET /api/country?code=…`);
  console.log(`  Health       : GET /health`);
  console.log(`  Auth         : ${env.AUTH_TOKEN ? 'Bearer token required' : 'open (no AUTH_TOKEN set)'}`);
});

// Docker sends SIGTERM on `stop`; finish in-flight requests instead of dropping them.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`${signal} received, shutting down.`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
