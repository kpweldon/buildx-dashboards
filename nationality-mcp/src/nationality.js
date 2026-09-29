// Upstream data access. Every function takes an explicit `fetch` so the
// handlers can be exercised in tests without touching the network.

import { countryName, flagEmoji } from './countries.js';

const NATIONALIZE_URL = 'https://api.nationalize.io/';
const RESTCOUNTRIES_URL = 'https://restcountries.com/v3.1';
const COUNTRY_FIELDS = 'name,cca2,cca3,flag,region,subregion,capital,population,languages,currencies';

const MAX_NAME_LENGTH = 60;
const MAX_BATCH = 10;

export class UpstreamError extends Error {
  constructor(message, { status = 502, retryable = false } = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
    this.retryable = retryable;
  }
}

export function normalizeName(raw) {
  if (typeof raw !== 'string') {
    throw new UpstreamError('`name` must be a string.', { status: 400 });
  }
  const name = raw.trim();
  if (!name) {
    throw new UpstreamError('`name` must not be empty.', { status: 400 });
  }
  if (name.length > MAX_NAME_LENGTH) {
    throw new UpstreamError(
      `\`name\` must be ${MAX_NAME_LENGTH} characters or fewer (got ${name.length}).`,
      { status: 400 },
    );
  }
  return name;
}

// nationalize.io answers 429 when the free daily allowance is spent, and 401
// when a key is present but wrong. Translate both into something a person can
// act on rather than a bare status code.
function describeUpstreamFailure(status, body) {
  if (status === 429) {
    return new UpstreamError(
      'nationalize.io rate limit reached (the keyless tier allows 100 requests/day, ' +
        'counted per source IP). Set the NATIONALIZE_API_KEY secret to raise it.',
      { status: 429, retryable: true },
    );
  }
  if (status === 401 || status === 402) {
    return new UpstreamError(
      `nationalize.io rejected the API key (HTTP ${status}). Re-set it with ` +
        '`npx wrangler secret put NATIONALIZE_API_KEY`.',
      { status: 502 },
    );
  }
  const detail = typeof body === 'string' && body ? ` — ${body.slice(0, 200)}` : '';
  return new UpstreamError(`nationalize.io returned HTTP ${status}${detail}`, {
    status: 502,
    retryable: status >= 500,
  });
}

/**
 * Predict likely nationalities for a first name.
 * @returns {Promise<{name: string, sample_size: number, predictions: Array<object>, note: string}>}
 */
export async function predictNationality(rawName, { fetchImpl, apiKey, topN = 5 } = {}) {
  const name = normalizeName(rawName);
  const limit = Number.isInteger(topN) && topN > 0 ? Math.min(topN, 10) : 5;

  const url = new URL(NATIONALIZE_URL);
  url.searchParams.set('name', name);

  const headers = { accept: 'application/json' };
  if (apiKey) headers['X-API-KEY'] = apiKey;

  let res;
  try {
    res = await fetchImpl(url.toString(), { headers });
  } catch (err) {
    throw new UpstreamError(`Could not reach nationalize.io: ${err.message}`, {
      status: 502,
      retryable: true,
    });
  }

  if (!res.ok) {
    throw describeUpstreamFailure(res.status, await res.text().catch(() => ''));
  }

  const data = await res.json();
  const rows = Array.isArray(data.country) ? data.country : [];

  const predictions = rows
    .slice(0, limit)
    .map((row) => {
      const code = String(row.country_id ?? '').toUpperCase();
      const probability = Number(row.probability) || 0;
      return {
        country_code: code,
        country: countryName(code) ?? code,
        flag: flagEmoji(code),
        probability: Math.round(probability * 10000) / 10000,
        percent: `${(probability * 100).toFixed(1)}%`,
      };
    });

  return {
    name: data.name ?? name,
    sample_size: Number(data.count) || 0,
    predictions,
    note:
      predictions.length === 0
        ? 'No match: nationalize.io has no records for this name. Try the given name alone, without a surname.'
        : 'Statistical inference from the name string alone. Not a fact about any individual.',
  };
}

/** Predict for several names in one call. Individual failures do not sink the batch. */
export async function predictNationalityBatch(names, options = {}) {
  if (!Array.isArray(names) || names.length === 0) {
    throw new UpstreamError('`names` must be a non-empty array of strings.', { status: 400 });
  }
  if (names.length > MAX_BATCH) {
    throw new UpstreamError(
      `\`names\` accepts at most ${MAX_BATCH} entries per call (got ${names.length}).`,
      { status: 400 },
    );
  }

  const settled = await Promise.all(
    names.map((n) =>
      predictNationality(n, options).then(
        (result) => ({ ok: true, ...result }),
        (err) => ({ ok: false, name: typeof n === 'string' ? n : String(n), error: err.message }),
      ),
    ),
  );
  return { count: settled.length, results: settled };
}

/** Full country detail for an ISO code (US / USA) or a country name. */
export async function getCountryInfo(query, { fetchImpl } = {}) {
  if (typeof query !== 'string' || !query.trim()) {
    throw new UpstreamError('`country` must be a non-empty string.', { status: 400 });
  }
  const q = query.trim();
  const path = /^[A-Za-z]{2,3}$/.test(q)
    ? `alpha/${encodeURIComponent(q.toLowerCase())}`
    : `name/${encodeURIComponent(q)}`;

  let res;
  try {
    res = await fetchImpl(`${RESTCOUNTRIES_URL}/${path}?fields=${COUNTRY_FIELDS}`, {
      headers: { accept: 'application/json' },
    });
  } catch (err) {
    throw new UpstreamError(`Could not reach restcountries.com: ${err.message}`, {
      status: 502,
      retryable: true,
    });
  }

  if (res.status === 404) {
    throw new UpstreamError(`No country matched "${q}".`, { status: 404 });
  }
  if (!res.ok) {
    throw new UpstreamError(`restcountries.com returned HTTP ${res.status}`, {
      status: 502,
      retryable: res.status >= 500,
    });
  }

  const body = await res.json();
  const entry = Array.isArray(body) ? body[0] : body;
  if (!entry) throw new UpstreamError(`No country matched "${q}".`, { status: 404 });

  return {
    name: entry.name?.common ?? null,
    official_name: entry.name?.official ?? null,
    country_code: entry.cca2 ?? null,
    country_code_alpha3: entry.cca3 ?? null,
    flag: entry.flag ?? flagEmoji(entry.cca2 ?? ''),
    region: entry.region ?? null,
    subregion: entry.subregion ?? null,
    capital: Array.isArray(entry.capital) ? entry.capital[0] ?? null : entry.capital ?? null,
    population: entry.population ?? null,
    languages: entry.languages ? Object.values(entry.languages) : [],
    currencies: entry.currencies
      ? Object.entries(entry.currencies).map(([code, c]) => ({ code, name: c?.name ?? null }))
      : [],
  };
}
