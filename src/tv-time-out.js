'use strict';

const { ZipArchive, parseCsv } = require('./core');
const { normalizeTitle } = require('./simkl-api');

function parseTvTimeOutZip(buffer) {
  if (!buffer || !buffer.length) {
    return { mappings: new Map(), stats: emptyStats() };
  }

  const zip = ZipArchive.fromBuffer(buffer);
  const rows = [];
  const stats = emptyStats();

  for (const entry of zip.entries.values()) {
    const name = entry.name.toLowerCase();
    const text = zip.readBuffer(entry).toString('utf8');
    if (name.endsWith('.json')) {
      parseJsonFile(entry.name, text, rows, stats);
    } else if (name.endsWith('.csv')) {
      parseCsvFile(entry.name, text, rows, stats);
    }
  }

  const mappings = new Map();
  const conflicts = new Set();

  for (const row of rows) {
    const key = mappingKey(row.sourceType, row.title, row.year);
    if (!key) continue;

    const existing = mappings.get(key);
    if (!existing) {
      mappings.set(key, row);
      continue;
    }

    const merged = mergeMapping(existing, row);
    if (merged.conflict) {
      conflicts.add(key);
      mappings.delete(key);
      stats.conflicts += 1;
      continue;
    }
    mappings.set(key, merged.mapping);
  }

  for (const key of conflicts) {
    mappings.delete(key);
  }

  stats.mappings = mappings.size;
  return { mappings, stats };
}

function parseJsonFile(fileName, text, rows, stats) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    stats.ignored += 1;
    return;
  }

  if (!Array.isArray(data)) {
    stats.ignored += 1;
    return;
  }

  if (/movies/i.test(fileName)) {
    for (const item of data) {
      addMapping(rows, stats, {
        sourceType: 'movie',
        title: item.title,
        year: item.year,
        tvdbId: item.id && item.id.tvdb,
        imdbId: item.id && item.id.imdb,
        source: fileName,
      });
    }
    return;
  }

  if (/series/i.test(fileName)) {
    for (const item of data) {
      addMapping(rows, stats, {
        sourceType: 'show',
        title: item.title,
        year: null,
        tvdbId: item.id && item.id.tvdb,
        imdbId: item.id && item.id.imdb,
        source: fileName,
      });
    }
  }
}

function parseCsvFile(fileName, text, rows, stats) {
  let parsed;
  try {
    parsed = parseCsv(text);
  } catch {
    stats.ignored += 1;
    return;
  }

  if (/movies/i.test(fileName)) {
    for (const row of parsed.rows) {
      addMapping(rows, stats, {
        sourceType: 'movie',
        title: row.title,
        year: row.year,
        tvdbId: row.tvdb_id,
        imdbId: row.imdb_id,
        source: fileName,
      });
    }
    return;
  }

  if (/series-\d{4}|series/i.test(fileName) && !/episodes/i.test(fileName)) {
    for (const row of parsed.rows) {
      addMapping(rows, stats, {
        sourceType: 'show',
        title: row.title,
        year: null,
        tvdbId: row.tvdb_id,
        imdbId: row.imdb_id,
        source: fileName,
      });
    }
  }
}

function addMapping(rows, stats, values) {
  const title = String(values.title || '').trim();
  const tvdbId = cleanNumericId(values.tvdbId);
  const imdbId = cleanImdbId(values.imdbId);
  if (!title || (!tvdbId && !imdbId)) {
    stats.ignored += 1;
    return;
  }

  rows.push({
    sourceType: values.sourceType,
    title,
    year: Number.parseInt(String(values.year || ''), 10) || null,
    tvdbId,
    imdbId,
    source: values.source || '',
  });
  stats.rows += 1;
}

function mergeMapping(left, right) {
  if (
    left.tvdbId &&
    right.tvdbId &&
    String(left.tvdbId) !== String(right.tvdbId)
  ) {
    return { conflict: true };
  }
  if (
    left.imdbId &&
    right.imdbId &&
    String(left.imdbId).toLowerCase() !== String(right.imdbId).toLowerCase()
  ) {
    return { conflict: true };
  }

  return {
    conflict: false,
    mapping: {
      ...left,
      tvdbId: left.tvdbId || right.tvdbId,
      imdbId: left.imdbId || right.imdbId,
      source: [left.source, right.source].filter(Boolean).join(', '),
    },
  };
}

function mappingKey(sourceType, title, year) {
  const normalized = normalizeTitle(title);
  if (!normalized) return '';
  return `${sourceType}|${normalized}|${sourceType === 'movie' ? year || '' : ''}`;
}

function cleanNumericId(value) {
  const text = String(value || '').trim();
  return /^\d+$/.test(text) ? text : '';
}

function cleanImdbId(value) {
  const text = String(value || '').trim().toLowerCase();
  return /^tt\d{5,12}$/.test(text) ? text : '';
}

function emptyStats() {
  return {
    rows: 0,
    mappings: 0,
    conflicts: 0,
    ignored: 0,
    applied: 0,
  };
}

module.exports = {
  parseTvTimeOutZip,
  mappingKey,
};
