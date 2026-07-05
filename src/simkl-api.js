'use strict';

const DEFAULT_APP_NAME = 'tvtime-to-simkl-import-file-convertor';
const DEFAULT_APP_VERSION = '1.0.0';
const DEFAULT_BASE_URL = 'https://api.simkl.com';

const TYPE_ENDPOINTS = {
  movie: '/movies',
  tv: '/tv',
  anime: '/anime',
};

class SimklClient {
  constructor(options) {
    const config = options || {};
    this.clientId = String(config.clientId || '').trim();
    this.appName = config.appName || DEFAULT_APP_NAME;
    this.appVersion = config.appVersion || DEFAULT_APP_VERSION;
    this.baseUrl = config.baseUrl || DEFAULT_BASE_URL;
    this.userAgent = config.userAgent || `${this.appName}/${this.appVersion}`;
    this.minDelayMs = Number.isFinite(config.minDelayMs) ? config.minDelayMs : defaultDelayMs();
    this.timeoutMs = Number.isFinite(config.timeoutMs) ? config.timeoutMs : defaultTimeoutMs();
    this.onRetry = typeof config.onRetry === 'function' ? config.onRetry : null;
    this.lastRequestAt = 0;
    this.idLookupCache = new Map();

    if (!this.clientId) {
      throw new Error('Missing SIMKL client_id.');
    }
    if (typeof fetch !== 'function') {
      throw new Error('This app needs Node.js 18+ to use fetch().');
    }
  }

  async enrichMediaRecord(record) {
    const queryTypes = getQueryTypes(record);

    for (const type of queryTypes) {
      try {
        const redirected = await this.resolveByRedirect(record, type);
        if (redirected.status === 'found') {
          return redirected;
        }
      } catch (error) {
        if (!isRecoverableLookupError(error)) {
          throw error;
        }
      }
    }

    const candidates = [];
    for (const type of queryTypes) {
      const result = await this.searchByType(record, type);
      candidates.push(...result.candidates);
    }

    const sorted = candidates
      .filter((candidate) => candidate.simklId)
      .sort((left, right) => right.score - left.score);

    const best = sorted[0];
    const second = sorted[1];
    if (best && best.score >= 85 && (!second || best.score - second.score >= 8)) {
      const canonical = await this.lookupById(best.simklId, [best.simklType], record).catch(() => null);
      if (canonical && canonical.status === 'found') {
        return {
          ...canonical,
          source: 'search',
          confidence: Math.min(100, Math.round(best.score)),
          candidates: sorted.slice(0, 5),
        };
      }

      return {
        status: 'found',
        source: 'search',
        simklId: best.simklId,
        simklType: best.simklType,
        title: best.title,
        year: best.year || null,
        confidence: Math.min(100, Math.round(best.score)),
        url: best.url || '',
        candidates: sorted.slice(0, 5),
      };
    }

    return {
      status: 'not_found',
      source: sorted.length ? 'search' : 'none',
      reason: sorted.length ? 'ambiguous_or_low_confidence' : 'no_match',
      candidates: sorted.slice(0, 5),
    };
  }

  async resolveByRedirect(record, simklType) {
    const params = {
      to: 'simkl',
      type: simklType,
      title: record.title,
    };
    if (record.year) {
      params.year = String(record.year);
    }

    const response = await this.request('/redirect', params, { redirect: 'manual', json: false });
    const location = response.headers.get('location') || '';
    const parsed = parseSimklLocation(location);
    if (!parsed.id) {
      return { status: 'not_found', source: 'redirect' };
    }

    const details = await this.lookupById(parsed.id, [parsed.type || simklType], record);
    if (details.status !== 'found') {
      return {
        status: 'found',
        source: 'redirect',
        simklId: parsed.id,
        simklType: parsed.type || simklType,
        title: '',
        year: null,
        confidence: 88,
        url: location,
      };
    }

    return {
      ...details,
      source: 'redirect',
      confidence: 96,
      url: location || details.url,
    };
  }

  async searchByType(record, simklType) {
    const response = await this.request(`/search/${encodeURIComponent(simklType)}`, {
      q: buildSearchQuery(record),
      extended: 'full',
    });

    const rows = Array.isArray(response) ? response : response && !response.error ? [response] : [];
    const candidates = rows.map((item) => {
      const title = getTitle(item);
      const year = getYear(item);
      const resolvedType = getItemSimklType(item, simklType);
      return {
        simklId: getSimklId(item),
        simklType: resolvedType,
        title,
        year,
        url: item.url || item.simkl_url || '',
        score: scoreCandidate(record, item, resolvedType),
      };
    });

    return { candidates };
  }

  async lookupById(simklId, preferredTypes, contextRecord) {
    const id = Number.parseInt(String(simklId || '').trim(), 10);
    if (!Number.isInteger(id) || id <= 0) {
      return { status: 'not_found', reason: 'invalid_id' };
    }

    const cached = this.idLookupCache.get(id);
    if (cached) {
      return { ...cached };
    }

    const requestedTypes = preferredTypes && preferredTypes.length ? preferredTypes : ['tv', 'movie', 'anime'];
    const types = unique([...requestedTypes, 'tv', 'movie', 'anime'])
      .filter((type) => TYPE_ENDPOINTS[type]);

    for (const type of types) {
      try {
        const item = await this.request(`${TYPE_ENDPOINTS[type]}/${id}`, { extended: 'full' });
        if (item && !item.error && (getSimklId(item) || getTitle(item))) {
          const resolvedType = getItemSimklType(item, type);
          const result = {
            status: 'found',
            source: 'id',
            simklId: getSimklId(item) || id,
            simklType: resolvedType,
            title: getTitle(item),
            year: getYear(item) || null,
            imdbId: getImdbId(item),
            tvdbId: getTvdbId(item),
            confidence: contextRecord ? Math.min(100, Math.max(70, Math.round(scoreCandidate(contextRecord, item, resolvedType)))) : 100,
            url: item.url || item.simkl_url || '',
            typeVerified: true,
            typeVerifiedBy: 'api_type',
          };
          this.idLookupCache.set(id, { ...result });
          return result;
        }
      } catch (error) {
        if (!isNotFoundLike(error)) {
          throw error;
        }
      }
    }

    return { status: 'not_found', reason: 'id_not_found' };
  }

  async lookupByExternalIds(ids, preferredTypes, contextRecord) {
    const imdbId = cleanImdbId(ids && ids.imdbId);
    const tvdbId = cleanNumericId(ids && ids.tvdbId);
    const lookups = [];

    if (imdbId) {
      lookups.push(await this.lookupByExternalId('imdb', imdbId, preferredTypes, contextRecord));
    }
    if (tvdbId) {
      lookups.push(await this.lookupByExternalId('tvdb', tvdbId, preferredTypes, contextRecord));
    }

    const found = lookups.filter((lookup) => lookup && lookup.status === 'found' && lookup.simklId);
    if (!found.length) {
      return { status: 'not_found', reason: 'external_ids_not_found' };
    }

    const first = found[0];
    const mismatch = found.find((lookup) => String(lookup.simklId) !== String(first.simklId));
    if (mismatch) {
      return {
        status: 'not_found',
        reason: 'external_ids_mismatch',
        fieldErrors: {
          imdbId: imdbId ? 'IMDb ID points to a different SIMKL item.' : '',
          tvdbId: tvdbId ? 'TVDB ID points to a different SIMKL item.' : '',
        },
      };
    }

    return {
      ...first,
      source: found.length > 1 ? 'external_ids' : first.source,
    };
  }

  async lookupByExternalId(kind, value, preferredTypes, contextRecord) {
    const params = {};
    params[kind] = value;

    const response = await this.request('/search/id', params);
    const candidates = extractSearchIdCandidates(response)
      .filter((candidate) => candidate.simklId)
      .sort((left, right) => {
        const typeScore = Number((preferredTypes || []).includes(right.simklType)) - Number((preferredTypes || []).includes(left.simklType));
        return typeScore || right.score - left.score;
      });

    const best = candidates[0];
    if (!best) {
      return { status: 'not_found', reason: `${kind}_not_found` };
    }

    const canonical = await this.lookupById(best.simklId, [best.simklType], contextRecord).catch(() => null);
    if (canonical && canonical.status === 'found') {
      return {
        ...canonical,
        source: kind,
        confidence: contextRecord ? canonical.confidence : 100,
        candidates: candidates.slice(0, 5),
      };
    }

    return {
      status: 'found',
      source: kind,
      simklId: best.simklId,
      simklType: best.simklType,
      title: best.title,
      year: best.year,
      imdbId: best.imdbId || (kind === 'imdb' ? value : ''),
      tvdbId: best.tvdbId || (kind === 'tvdb' ? value : ''),
      confidence: 100,
      candidates: candidates.slice(0, 5),
      typeVerified: true,
      typeVerifiedBy: 'search_id',
    };
  }

  async request(pathname, params, options) {
    const config = options || {};
    await this.waitTurn();

    const url = new URL(pathname, this.baseUrl);
    const query = {
      ...(params || {}),
      client_id: this.clientId,
      'app-name': this.appName,
      'app-version': this.appVersion,
    };
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }

    let attempt = 0;
    let delayMs = 1000;
    while (attempt < 5) {
      attempt += 1;
      let response;
      try {
        response = await fetchWithTimeout(url, {
          method: 'GET',
          redirect: config.redirect || 'follow',
          headers: {
            'User-Agent': this.userAgent,
            Accept: config.json === false ? '*/*' : 'application/json',
          },
        }, this.timeoutMs);
      } catch (error) {
        if (error && error.code === 'ETIMEDOUT') {
          throw new Error(`SIMKL timeout after ${formatMs(this.timeoutMs)} at ${url.pathname}`);
        }
        throw error;
      }

      if (response.status === 429 || response.status >= 500) {
        if (attempt >= 5) {
          throw new Error(`SIMKL ${response.status} at ${url.pathname}`);
        }
        if (this.onRetry) {
          this.onRetry({
            status: response.status,
            pathname: url.pathname,
            attempt,
            delayMs,
          });
        }
        await sleep(delayMs);
        delayMs *= 2;
        continue;
      }

      if (response.status === 404) {
        const error = new Error(`SIMKL 404 at ${url.pathname}`);
        error.status = 404;
        throw error;
      }

      if (!response.ok && !(config.redirect === 'manual' && response.status >= 300 && response.status < 400)) {
        const text = await response.text().catch(() => '');
        throw new Error(`SIMKL ${response.status}: ${text.slice(0, 180)}`);
      }

      if (config.json === false) {
        return response;
      }

      return response.json();
    }

    throw new Error(`SIMKL request failed at ${url.pathname}`);
  }

  async waitTurn() {
    const now = Date.now();
    const waitMs = Math.max(0, this.lastRequestAt + this.minDelayMs - now);
    if (waitMs > 0) {
      await sleep(waitMs);
    }
    this.lastRequestAt = Date.now();
  }
}

function getQueryTypes(record) {
  if (record.simklType) {
    return unique([record.simklType, ...fallbackTypes(record.sourceType)]);
  }
  return fallbackTypes(record.sourceType);
}

function fallbackTypes(sourceType) {
  if (sourceType === 'movie') return ['movie'];
  if (sourceType === 'anime') return ['anime', 'tv'];
  return ['tv', 'anime'];
}

function defaultDelayMs() {
  const value = Number.parseInt(String(process.env.SIMKL_API_DELAY_MS || ''), 10);
  return Number.isFinite(value) && value >= 0 ? value : 110;
}

function defaultTimeoutMs() {
  const value = Number.parseInt(String(process.env.SIMKL_API_TIMEOUT_MS || ''), 10);
  return Number.isFinite(value) && value >= 0 ? value : 20000;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return fetch(url, options);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (error) {
    if (error && error.name === 'AbortError') {
      const timeoutError = new Error('request_timeout');
      timeoutError.code = 'ETIMEDOUT';
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function formatMs(value) {
  return `${Math.round(Number(value) || 0)}ms`;
}

function buildSearchQuery(record) {
  return [record.title, record.year || ''].filter(Boolean).join(' ');
}

function scoreCandidate(record, item, simklType) {
  const wantedTitle = normalizeTitle(record.title);
  const wantedYear = Number(record.year) || null;
  const titles = getCandidateTitles(item).map(normalizeTitle).filter(Boolean);
  const candidateYear = getYear(item);

  let titleScore = 0;
  for (const title of titles) {
    if (title === wantedTitle) {
      titleScore = Math.max(titleScore, 78);
    } else if (title.includes(wantedTitle) || wantedTitle.includes(title)) {
      titleScore = Math.max(titleScore, 62);
    } else {
      titleScore = Math.max(titleScore, tokenOverlapScore(wantedTitle, title));
    }
  }

  let yearScore = 0;
  if (wantedYear && candidateYear) {
    const diff = Math.abs(wantedYear - candidateYear);
    if (diff === 0) yearScore = 20;
    else if (diff === 1) yearScore = 12;
    else if (diff <= 2) yearScore = 6;
  } else if (!wantedYear || !candidateYear) {
    yearScore = 5;
  }

  const typeScore = getQueryTypes(record).includes(simklType) ? 2 : 0;
  return titleScore + yearScore + typeScore;
}

function tokenOverlapScore(left, right) {
  const leftTokens = new Set(left.split(' ').filter((token) => token.length > 1));
  const rightTokens = new Set(right.split(' ').filter((token) => token.length > 1));
  if (!leftTokens.size || !rightTokens.size) return 0;
  let shared = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) shared += 1;
  }
  return Math.round((shared / Math.max(leftTokens.size, rightTokens.size)) * 60);
}

function getCandidateTitles(item) {
  const values = [getTitle(item)];
  for (const key of ['all_titles', 'alt_titles', 'alternative_titles', 'aliases']) {
    const value = item && item[key];
    if (Array.isArray(value)) {
      for (const entry of value) {
        values.push(typeof entry === 'string' ? entry : entry && (entry.title || entry.name));
      }
    }
  }
  return values.filter(Boolean);
}

function getTitle(item) {
  return String((item && (item.title || item.name || item.en_title || item.original_title)) || '').trim();
}

function getYear(item) {
  const direct = Number.parseInt(String(item && item.year || ''), 10);
  if (Number.isInteger(direct)) return direct;
  const date = String((item && (item.release_date || item.first_aired || item.date)) || '');
  const match = date.match(/^(\d{4})/);
  return match ? Number.parseInt(match[1], 10) : null;
}

function getSimklId(item) {
  const ids = (item && item.ids) || {};
  const raw = ids.simkl || ids.simkl_id || item.simkl_id || item.id;
  const id = Number.parseInt(String(raw || '').trim(), 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function getImdbId(item) {
  const ids = (item && item.ids) || {};
  return cleanImdbId(ids.imdb || ids.imdb_id || item.imdb_id || item.imdb);
}

function getTvdbId(item) {
  const ids = (item && item.ids) || {};
  return cleanNumericId(ids.tvdb || ids.tvdb_id || item.tvdb_id || item.tvdb);
}

function extractSearchIdCandidates(response) {
  const candidates = [];
  const seen = new Set();

  visitSearchId(response, (item, fallbackType) => {
    const simklId = getSimklId(item);
    if (!simklId || seen.has(simklId)) return;
    seen.add(simklId);
    const simklType = getItemSimklType(item, fallbackType || 'tv');
    candidates.push({
      simklId,
      simklType,
      title: getTitle(item),
      year: getYear(item) || null,
      imdbId: getImdbId(item),
      tvdbId: getTvdbId(item),
      score: 100,
    });
  });

  return candidates;
}

function visitSearchId(value, callback, keyHint) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) {
      visitSearchId(item, callback, keyHint);
    }
    return;
  }

  if (getSimklId(value)) {
    callback(value, normalizeSimklType(keyHint || value.type || value.media_type || ''));
  }

  for (const [key, child] of Object.entries(value)) {
    if (key === 'ids') continue;
    visitSearchId(child, callback, key);
  }
}

function getItemSimklType(item, fallbackType) {
  const value = item && (item.type || item.media_type || item.kind);
  if (!value) {
    return fallbackType;
  }
  return normalizeSimklType(value);
}

function parseSimklLocation(location) {
  const text = String(location || '');
  const match = text.match(/(?:simkl\.com)?\/(tv|anime|movies?|movie)\/(\d+)/i);
  if (!match) {
    return { id: null, type: null };
  }
  return {
    id: Number.parseInt(match[2], 10),
    type: normalizeSimklType(match[1]),
  };
}

function normalizeSimklType(value) {
  const text = String(value || '').toLowerCase();
  if (text === 'movies' || text === 'movie') return 'movie';
  if (text === 'anime') return 'anime';
  return 'tv';
}

function normalizeTitle(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['\u2019]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(the|a|an)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanNumericId(value) {
  const text = String(value || '').trim();
  return /^\d+$/.test(text) ? text : '';
}

function cleanImdbId(value) {
  const text = String(value || '').trim().toLowerCase();
  return /^tt\d{5,12}$/.test(text) ? text : '';
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isNotFoundLike(error) {
  return error && (error.status === 404 || /404|not_found|empty/i.test(error.message));
}

function isRecoverableLookupError(error) {
  return error && /400|404|not_found|empty|url_failed/i.test(error.message);
}

module.exports = {
  SimklClient,
  normalizeTitle,
  parseSimklLocation,
};
