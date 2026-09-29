// BuildX Nationality API — the request handler, exposing one nationality data
// source two ways:
//
//   POST /mcp   MCP (Streamable HTTP) — add as a custom connector in Claude,
//               which syncs to web, desktop, and the phone app.
//   GET  /api/* plain JSON + CORS — callable straight from the dashboard HTML.
//
// Written against the web Request/Response interfaces so the same handler runs
// under Node (src/server.js, what the NAS container uses) unchanged.

import { handleRpcPayload, LATEST_PROTOCOL_VERSION, SERVER_INFO } from './mcp.js';
import {
  getCountryInfo,
  predictNationality,
  predictNationalityBatch,
  UpstreamError,
} from './nationality.js';

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers':
    'content-type, authorization, mcp-protocol-version, mcp-session-id, last-event-id',
  'access-control-expose-headers': 'mcp-protocol-version, mcp-session-id',
  'access-control-max-age': '86400',
};

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS_HEADERS, ...extra },
  });

function buildRegistry(env) {
  const options = { fetchImpl: fetch.bind(globalThis), apiKey: env.NATIONALIZE_API_KEY };

  return {
    predict_nationality: {
      definition: {
        name: 'predict_nationality',
        title: 'Predict nationality from a name',
        description:
          'Estimate the most likely countries of origin for a given first name, with a ' +
          'probability for each. Backed by nationalize.io, which scores the name string ' +
          'against name frequencies by country. This is a statistic about the name, not a ' +
          'determination about any individual person — do not use it to make decisions ' +
          'about a specific customer, applicant, or tenant.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'A first/given name. Surnames lower accuracy — pass the given name alone.',
            },
            top_n: {
              type: 'integer',
              description: 'How many countries to return, 1-10. Defaults to 5.',
              minimum: 1,
              maximum: 10,
            },
          },
          required: ['name'],
          additionalProperties: false,
        },
      },
      handler: (args) => predictNationality(args.name, { ...options, topN: args.top_n }),
    },

    predict_nationality_batch: {
      definition: {
        name: 'predict_nationality_batch',
        title: 'Predict nationality for several names',
        description:
          'Run predict_nationality over up to 10 names in one call. Names that fail come ' +
          'back with an error field instead of sinking the whole batch. Same caveat: these ' +
          'are name-frequency statistics, not facts about individuals.',
        inputSchema: {
          type: 'object',
          properties: {
            names: {
              type: 'array',
              description: 'First names to look up. Maximum 10 per call.',
              items: { type: 'string' },
              minItems: 1,
              maxItems: 10,
            },
            top_n: {
              type: 'integer',
              description: 'Countries per name, 1-10. Defaults to 5.',
              minimum: 1,
              maximum: 10,
            },
          },
          required: ['names'],
          additionalProperties: false,
        },
      },
      handler: (args) => predictNationalityBatch(args.names, { ...options, topN: args.top_n }),
    },

    get_country_info: {
      definition: {
        name: 'get_country_info',
        title: 'Look up country reference data',
        description:
          'Return reference data for a country — official name, ISO codes, flag, region, ' +
          'capital, population, languages, and currencies. Accepts an ISO code ("US", "USA") ' +
          'or a country name ("Portugal"). Useful for expanding the country codes that ' +
          'predict_nationality returns.',
        inputSchema: {
          type: 'object',
          properties: {
            country: {
              type: 'string',
              description: 'ISO 3166-1 alpha-2/alpha-3 code, or a common country name.',
            },
          },
          required: ['country'],
          additionalProperties: false,
        },
      },
      handler: (args) => getCountryInfo(args.country, options),
    },
  };
}

// Optional shared secret. Unset (the default) leaves the Worker open, which is
// fine for public reference data; set AUTH_TOKEN to lock it down.
function unauthorized(request, env) {
  if (!env.AUTH_TOKEN) return false;
  const header = request.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  return token !== env.AUTH_TOKEN;
}

async function handleRestRequest(url, registry) {
  try {
    if (url.pathname === '/api/nationality') {
      const name = url.searchParams.get('name');
      const topRaw = url.searchParams.get('top_n');
      const top_n = topRaw === null ? undefined : Number.parseInt(topRaw, 10);
      return json(await registry.predict_nationality.handler({ name, top_n }));
    }
    if (url.pathname === '/api/country') {
      const country = url.searchParams.get('code') ?? url.searchParams.get('name');
      return json(await registry.get_country_info.handler({ country }));
    }
  } catch (err) {
    const status = err instanceof UpstreamError ? err.status : 500;
    return json({ error: err.message, retryable: err.retryable ?? false }, status);
  }
  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname === '/health' || url.pathname === '/') {
      return json({
        status: 'ok',
        service: SERVER_INFO.name,
        version: SERVER_INFO.version,
        protocol_version: LATEST_PROTOCOL_VERSION,
        mcp_endpoint: `${url.origin}/mcp`,
        rest_endpoints: [`${url.origin}/api/nationality?name=…`, `${url.origin}/api/country?code=…`],
        auth_required: Boolean(env.AUTH_TOKEN),
      });
    }

    if (unauthorized(request, env)) {
      return json({ error: 'Unauthorized. Send `Authorization: Bearer <token>`.' }, 401, {
        'www-authenticate': 'Bearer',
      });
    }

    const registry = buildRegistry(env);

    if (url.pathname === '/mcp') {
      if (request.method !== 'POST') {
        // No server-initiated stream, so GET/DELETE on the endpoint are not supported.
        return json({ error: 'Use POST for the MCP endpoint.' }, 405, { allow: 'POST, OPTIONS' });
      }
      const { status, body } = await handleRpcPayload(await request.text(), registry);
      if (body === null) {
        return new Response(null, { status, headers: CORS_HEADERS });
      }
      return json(body, status, {
        'mcp-protocol-version':
          request.headers.get('mcp-protocol-version') ?? LATEST_PROTOCOL_VERSION,
      });
    }

    if (url.pathname.startsWith('/api/')) {
      if (request.method !== 'GET') {
        return json({ error: 'REST endpoints accept GET.' }, 405, { allow: 'GET, OPTIONS' });
      }
      const response = await handleRestRequest(url, registry);
      if (response) return response;
    }

    return json({ error: `Not found: ${url.pathname}`, try: ['/health', '/mcp', '/api/nationality'] }, 404);
  },
};
