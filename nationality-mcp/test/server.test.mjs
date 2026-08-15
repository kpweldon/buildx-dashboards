// Exercises the Worker end to end with a stubbed upstream, so the MCP
// handshake, tool dispatch, routing, and error mapping are all covered
// without touching nationalize.io or restcountries.com.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import worker from '../src/app.js';
import { flagEmoji, countryName } from '../src/countries.js';
import { normalizeName, predictNationality, UpstreamError } from '../src/nationality.js';

const NATIONALIZE_SAMPLE = {
  count: 8367,
  name: 'buz',
  country: [
    { country_id: 'US', probability: 0.412 },
    { country_id: 'TR', probability: 0.238 },
    { country_id: 'GB', probability: 0.091 },
  ],
};

const COUNTRY_SAMPLE = {
  name: { common: 'United States', official: 'United States of America' },
  cca2: 'US',
  cca3: 'USA',
  flag: '🇺🇸',
  region: 'Americas',
  subregion: 'North America',
  capital: ['Washington, D.C.'],
  population: 329484123,
  languages: { eng: 'English' },
  currencies: { USD: { name: 'United States dollar' } },
};

/** Swap globalThis.fetch for the duration of a callback. */
async function withStubbedFetch(responder, run) {
  const original = globalThis.fetch;
  globalThis.fetch = responder;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

const stubUpstream = async (url) => {
  const href = typeof url === 'string' ? url : url.toString();
  if (href.startsWith('https://api.nationalize.io/')) {
    return new Response(JSON.stringify(NATIONALIZE_SAMPLE), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (href.startsWith('https://restcountries.com/')) {
    return new Response(JSON.stringify(COUNTRY_SAMPLE), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  throw new Error(`unexpected upstream call: ${href}`);
};

const rpc = (method, params, id = 1) =>
  new Request('https://example.workers.dev/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }),
  });

const call = (request, env = {}) => worker.fetch(request, env);

// ---------------------------------------------------------------- MCP protocol

test('initialize returns server info and echoes a supported protocol version', async () => {
  const res = await call(rpc('initialize', { protocolVersion: '2025-03-26' }));
  assert.equal(res.status, 200);
  const { result } = await res.json();
  assert.equal(result.protocolVersion, '2025-03-26');
  assert.equal(result.serverInfo.name, 'buildx-nationality');
  assert.ok(result.capabilities.tools);
});

test('initialize falls back to the latest version for an unknown one', async () => {
  const res = await call(rpc('initialize', { protocolVersion: '1999-01-01' }));
  const { result } = await res.json();
  assert.equal(result.protocolVersion, '2025-06-18');
});

test('notifications get 202 and an empty body', async () => {
  const res = await call(
    new Request('https://example.workers.dev/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    }),
  );
  assert.equal(res.status, 202);
  assert.equal(await res.text(), '');
});

test('tools/list advertises all three tools with input schemas', async () => {
  const res = await call(rpc('tools/list'));
  const { result } = await res.json();
  const names = result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['get_country_info', 'predict_nationality', 'predict_nationality_batch']);
  for (const tool of result.tools) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.ok(tool.description.length > 0);
  }
});

test('unknown method returns JSON-RPC -32601', async () => {
  const res = await call(rpc('does/not/exist'));
  const { error } = await res.json();
  assert.equal(error.code, -32601);
});

test('malformed JSON returns a parse error', async () => {
  const res = await call(
    new Request('https://example.workers.dev/mcp', { method: 'POST', body: '{oops' }),
  );
  assert.equal(res.status, 400);
  const { error } = await res.json();
  assert.equal(error.code, -32700);
});

test('GET on the MCP endpoint is rejected with 405', async () => {
  const res = await call(new Request('https://example.workers.dev/mcp'));
  assert.equal(res.status, 405);
});

// ------------------------------------------------------------------ tool calls

test('tools/call predict_nationality returns enriched, ranked predictions', async () => {
  const res = await withStubbedFetch(stubUpstream, () =>
    call(rpc('tools/call', { name: 'predict_nationality', arguments: { name: 'Buz' } })),
  );
  const { result } = await res.json();
  assert.equal(result.isError, false);

  const payload = result.structuredContent;
  assert.equal(payload.sample_size, 8367);
  assert.equal(payload.predictions.length, 3);
  assert.deepEqual(payload.predictions[0], {
    country_code: 'US',
    country: 'United States',
    flag: '🇺🇸',
    probability: 0.412,
    percent: '41.2%',
  });
  // The text block mirrors the structured payload for clients that ignore it.
  assert.deepEqual(JSON.parse(result.content[0].text), payload);
});

test('top_n caps the number of predictions', async () => {
  const res = await withStubbedFetch(stubUpstream, () =>
    call(rpc('tools/call', { name: 'predict_nationality', arguments: { name: 'Buz', top_n: 2 } })),
  );
  const { result } = await res.json();
  assert.equal(result.structuredContent.predictions.length, 2);
});

test('batch reports per-name failures without failing the call', async () => {
  const res = await withStubbedFetch(stubUpstream, () =>
    call(
      rpc('tools/call', {
        name: 'predict_nationality_batch',
        arguments: { names: ['Buz', '   '] },
      }),
    ),
  );
  const { result } = await res.json();
  const { results } = result.structuredContent;
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, false);
  assert.match(results[1].error, /must not be empty/);
});

test('get_country_info flattens the restcountries payload', async () => {
  const res = await withStubbedFetch(stubUpstream, () =>
    call(rpc('tools/call', { name: 'get_country_info', arguments: { country: 'US' } })),
  );
  const { result } = await res.json();
  const info = result.structuredContent;
  assert.equal(info.name, 'United States');
  assert.equal(info.capital, 'Washington, D.C.');
  assert.deepEqual(info.languages, ['English']);
  assert.deepEqual(info.currencies, [{ code: 'USD', name: 'United States dollar' }]);
});

test('an unknown tool name is a JSON-RPC invalid-params error', async () => {
  const res = await call(rpc('tools/call', { name: 'nope', arguments: {} }));
  const { error } = await res.json();
  assert.equal(error.code, -32602);
});

test('a rate-limited upstream surfaces as a readable tool error', async () => {
  const limited = async () => new Response('rate limited', { status: 429 });
  const res = await withStubbedFetch(limited, () =>
    call(rpc('tools/call', { name: 'predict_nationality', arguments: { name: 'Buz' } })),
  );
  const { result } = await res.json();
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /rate limit reached/);
});

test('a name with no matches explains itself rather than returning bare empty', async () => {
  const empty = async () =>
    new Response(JSON.stringify({ count: 0, name: 'zzzz', country: [] }), { status: 200 });
  const result = await withStubbedFetch(empty, () =>
    predictNationality('zzzz', { fetchImpl: globalThis.fetch }),
  );
  assert.deepEqual(result.predictions, []);
  assert.match(result.note, /No match/);
});

// ------------------------------------------------------------- REST + plumbing

test('REST endpoint mirrors the tool output and sets CORS', async () => {
  const res = await withStubbedFetch(stubUpstream, () =>
    call(new Request('https://example.workers.dev/api/nationality?name=Buz&top_n=1')),
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  const body = await res.json();
  assert.equal(body.predictions.length, 1);
  assert.equal(body.predictions[0].country, 'United States');
});

test('REST validation errors map to 400, not 500', async () => {
  const res = await call(new Request('https://example.workers.dev/api/nationality'));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /must be a string/);
});

test('preflight is answered without auth', async () => {
  const res = await call(
    new Request('https://example.workers.dev/mcp', { method: 'OPTIONS' }),
    { AUTH_TOKEN: 'secret' },
  );
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');
});

test('AUTH_TOKEN gates the MCP endpoint but leaves /health reachable', async () => {
  const env = { AUTH_TOKEN: 'secret' };

  const anon = await call(rpc('tools/list'), env);
  assert.equal(anon.status, 401);

  const health = await call(new Request('https://example.workers.dev/health'), env);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).auth_required, true);

  const authed = await call(
    new Request('https://example.workers.dev/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer secret' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }),
    }),
    env,
  );
  assert.equal(authed.status, 200);
});

test('health check reports the endpoints it serves', async () => {
  const res = await call(new Request('https://example.workers.dev/health'));
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.mcp_endpoint, 'https://example.workers.dev/mcp');
  assert.equal(body.auth_required, false);
});

test('unknown paths 404 with a hint', async () => {
  const res = await call(new Request('https://example.workers.dev/nope'));
  assert.equal(res.status, 404);
  assert.ok((await res.json()).try.includes('/mcp'));
});

// ------------------------------------------------------------------- unit bits

test('flag emoji is derived from the ISO code', () => {
  assert.equal(flagEmoji('US'), '🇺🇸');
  assert.equal(flagEmoji('pt'), '🇵🇹');
  assert.equal(flagEmoji('nope'), '');
});

test('country names cover the codes nationalize returns', () => {
  assert.equal(countryName('TR'), 'Türkiye');
  assert.equal(countryName('ZZ'), null);
});

test('name validation rejects empty and overlong input', () => {
  assert.equal(normalizeName('  Buz  '), 'Buz');
  assert.throws(() => normalizeName(''), UpstreamError);
  assert.throws(() => normalizeName('x'.repeat(61)), /60 characters or fewer/);
});
