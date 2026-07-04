'use strict';

const crypto = require('crypto');

const {
  SIMKL_INTERNAL_JSON_NAME,
  ZipArchive,
  loadTvTimeData,
  convertTvTimeToSimklJson,
  createZip,
  makeTimestamp,
} = require('./core');
const { SimklClient, normalizeTitle } = require('./simkl-api');

const DEFAULT_CONVERT_OPTIONS = {
  includePlanToWatch: true,
  includeRewatches: true,
  progressIntervalMs: 0,
};
const TYPE_VERIFIER_VERSION = 7;

async function createSessionFromZip(zipBuffer, options) {
  const config = options || {};
  const progress = config.progress || noopProgress;
  const timestamp = makeTimestamp(new Date());

  progress({ phase: 'reading TV Time ZIP', done: 0, total: 1 });
  const zip = ZipArchive.fromBuffer(zipBuffer);
  const loaded = loadTvTimeData(zip);

  progress({ phase: 'converting TV Time history', done: 0, total: 1 });
  const conversion = convertTvTimeToSimklJson(loaded, {
    ...DEFAULT_CONVERT_OPTIONS,
    includePlanToWatch: config.includePlanToWatch !== false,
    includeRewatches: config.includeRewatches !== false,
  }, noopConverterProgress);

  const records = extractMediaRecords(conversion.simklBackup);
  const notes = [...conversion.notes];

  if (config.mappingStore) {
    try {
      const applied = await applyStoredMappings(records, config.mappingStore);
      if (applied.cached > 0) {
        notes.push(`${applied.cached} SIMKL IDs were loaded from the MongoDB cache.`);
      }
      if (applied.needsType > 0) {
        notes.push(`${applied.needsType} MongoDB SIMKL IDs need type confirmation from SIMKL.`);
      }
    } catch (error) {
      notes.push(`MongoDB cache ignored: ${error.message}`);
    }
  }

  if (config.clientId) {
    await enrichRecords(records, {
      clientId: config.clientId,
      mappingStore: config.mappingStore,
      progress,
    });
  } else {
    for (const record of records) {
      if (record.status !== 'found' || !record.verifiedSimklId) {
        markNotFound(record, 'simkl_client_id_missing');
      }
    }
  }

  const session = {
    id: config.sessionId || randomId(),
    timestamp,
    createdAt: new Date().toISOString(),
    clientId: String(config.clientId || '').trim(),
    backup: conversion.simklBackup,
    reportRows: conversion.reportRows,
    summary: {
      ...conversion.summary,
      media_records: records.length,
      simkl_found: records.filter((record) => record.status === 'found').length,
      simkl_not_found: records.filter((record) => record.status !== 'found').length,
    },
    notes,
    records,
  };

  return session;
}

async function enrichRecords(records, options) {
  let currentRecord = null;
  let currentIndex = 0;
  const client = new SimklClient({
    clientId: options.clientId,
    onRetry(retry) {
      progress({
        phase: retryPhase(retry, currentRecord),
        done: currentIndex,
        total,
      });
    },
  });
  const progress = options.progress || noopProgress;
  const mappingStore = options.mappingStore || null;
  const total = Math.max(1, records.length);

  for (const [index, record] of records.entries()) {
    currentRecord = record;
    currentIndex = index;
    if (record.status === 'found' && record.verifiedSimklId) {
      progress({
        phase: `MongoDB cache: ${record.title}`,
        done: index + 1,
        total,
      });
      continue;
    }

    progress({
      phase: record.inputSimklId ? `confirming SIMKL type: ${record.title}` : `searching SIMKL: ${record.title}`,
      done: index,
      total,
    });

    try {
      const result = record.inputSimklId
        ? await client.lookupById(record.inputSimklId, validationTypes(record, record.simklType), record)
        : await client.enrichMediaRecord(record);
      applyLookupResult(record, result);
      await persistFoundMapping(record, mappingStore, progress, index, total);
    } catch (error) {
      markNotFound(record, 'simkl_api_error', error.message);
    }
  }

  progress({ phase: 'SIMKL enrichment complete', done: total, total });
}

async function validateManualRecords(session, updates, options) {
  if (!session.clientId) {
    throw new Error('This session does not have a SIMKL client_id for ID validation.');
  }

  const config = options || {};
  const progress = config.progress || noopProgress;
  const mappingStore = config.mappingStore || null;
  let currentRecord = null;
  let currentIndex = 0;
  const client = new SimklClient({
    clientId: session.clientId,
    onRetry(retry) {
      progress({
        phase: retryPhase(retry, currentRecord),
        done: currentIndex,
        total,
      });
    },
  });
  const byId = new Map(session.records.map((record) => [record.id, record]));
  const changed = [];
  const rows = updates || [];
  const total = Math.max(1, rows.length);

  for (const [index, update] of rows.entries()) {
    const record = byId.get(update.id);
    if (!record) continue;
    currentRecord = record;
    currentIndex = index;

    const typedId = cleanId(update.simklId);
    const type = normalizeRecordType(update.simklType || record.simklType || record.sourceType);

    progress({
      phase: typedId ? `validating ${typedId}` : `clearing ID for ${record.title}`,
      done: index,
      total,
    });

    record.inputSimklId = typedId;
    record.simklType = type;

    if (!typedId) {
      markNotFound(record, 'manual_id_removed');
      changed.push(toPublicRecord(record));
      progress({
        phase: `ID cleared: ${record.title}`,
        done: index + 1,
        total,
      });
      continue;
    }

    try {
      const result = await client.lookupById(typedId, validationTypes(record, type), record);
      applyLookupResult(record, result, { manual: true, keepInput: typedId });
      await persistFoundMapping(record, mappingStore, progress, index, total);
    } catch (error) {
      markNotFound(record, 'simkl_api_error', error.message);
      record.inputSimklId = typedId;
    }

    changed.push(toPublicRecord(record));
    progress({
      phase: `validated: ${record.title}`,
      done: index + 1,
      total,
    });
  }

  return changed;
}

async function applyStoredMappings(records, mappingStore) {
  const mappings = await mappingStore.getMappings(records);
  let cached = 0;
  let needsType = 0;

  for (const record of records) {
    const mapping = mappings.get(record.id);
    if (!mapping || !mapping.simkl || !mapping.simkl.id) {
      continue;
    }

    if (
      !mapping.simkl.type ||
      mapping.simkl.typeVerified !== true ||
      Number(mapping.simkl.typeVerifierVersion || 0) < TYPE_VERIFIER_VERSION
    ) {
      record.inputSimklId = String(mapping.simkl.id);
      record.initialSimklId = String(mapping.simkl.id);
      record.lookupSource = 'mongodb_untyped';
      record.reason = 'mongodb_id_needs_type';
      needsType += 1;
      continue;
    }

    applyLookupResult(record, {
      status: 'found',
      source: 'mongodb',
      simklId: mapping.simkl.id,
      simklType: mapping.simkl.type || record.simklType,
      title: mapping.simkl.title || '',
      year: mapping.simkl.year || null,
      confidence: 100,
      typeVerified: true,
      typeVerifiedBy: mapping.simkl.typeVerifiedBy || 'mongodb',
      candidates: [],
    });
    cached += 1;
  }

  return { cached, needsType };
}

async function saveConfirmedMappings(session, submittedRecords, mappingStore) {
  const mappings = collectConfirmedMappings(session, submittedRecords);
  if (mappings.blocked.length) {
    const examples = mappings.blocked.slice(0, 5).map((record) => record.title).join(', ');
    throw new Error(`Some filled IDs are not green yet. Validate these first: ${examples}`);
  }

  const result = await mappingStore.saveMappings(mappings.rows);
  return {
    ...result,
    skippedEmpty: mappings.skippedEmpty,
    blocked: 0,
  };
}

function collectConfirmedMappings(session, submittedRecords) {
  const submitted = new Map((submittedRecords || []).map((record) => [record.id, record]));
  const rows = [];
  const blocked = [];
  let skippedEmpty = 0;

  for (const record of session.records) {
    const update = submitted.get(record.id);
    const rawId = update ? String(update.simklId || '').trim() : record.inputSimklId;
    const simklId = cleanId(rawId);
    const simklType = normalizeRecordType((update && update.simklType) || record.simklType || record.sourceType);

    if (!rawId) {
      skippedEmpty += 1;
      continue;
    }

    if (
      !simklId ||
      record.status !== 'found' ||
      record.typeVerified !== true ||
      cleanId(record.verifiedSimklId) !== simklId ||
      normalizeRecordType(record.simklType) !== simklType
    ) {
      blocked.push(record);
      continue;
    }

    const mapping = mappingFromRecord(record);
    rows.push({
      ...mapping,
      simkl: {
        ...mapping.simkl,
        id: Number.parseInt(simklId, 10),
        type: simklType,
      },
    });
  }

  return { rows, blocked, skippedEmpty };
}

function mappingFromRecord(record) {
  return {
    _id: record.id,
    sourceType: record.sourceType,
    title: record.title,
    normalizedTitle: normalizeTitle(record.title),
    year: record.year || null,
    simkl: {
      id: Number.parseInt(cleanId(record.verifiedSimklId || record.inputSimklId), 10),
      type: normalizeRecordType(record.simklType),
      title: record.simklTitle || '',
      year: record.simklYear || null,
      typeVerified: record.typeVerified === true,
      typeVerifierVersion: record.typeVerified === true ? TYPE_VERIFIER_VERSION : null,
      typeVerifiedBy: record.typeVerifiedBy || record.lookupSource || 'simkl',
      typeVerifiedAt: new Date(),
    },
    verifiedBy: record.lookupSource || 'simkl',
    verifiedAt: new Date(),
  };
}

async function persistFoundMapping(record, mappingStore, progress, done, total) {
  if (
    !mappingStore ||
    record.status !== 'found' ||
    !record.verifiedSimklId ||
    record.typeVerified !== true
  ) {
    return false;
  }

  try {
    progress({
      phase: `saving ID to database: ${record.title}`,
      done,
      total,
    });
    await mappingStore.saveMappings([mappingFromRecord(record)]);
    return true;
  } catch (error) {
    record.error = record.error
      ? `${record.error}; MongoDB: ${error.message}`
      : `MongoDB: ${error.message}`;
    return false;
  }
}

function buildDownload(session, submittedRecords, options) {
  const exportOptions = normalizeExportOptions(options);
  const submitted = new Map((submittedRecords || []).map((record) => [record.id, record]));
  const finalRecords = session.records.map((record) => {
    const update = submitted.get(record.id);
    if (!update) return record;
    return {
      ...record,
      inputSimklId: cleanId(update.simklId),
      simklType: normalizeRecordType(update.simklType || record.simklType),
    };
  });

  const backup = applyRecordsToBackup(session.backup, finalRecords, exportOptions);
  const jsonText = `${JSON.stringify(backup, null, 2)}\n`;
  const zipBuffer = createZip([
    { name: SIMKL_INTERNAL_JSON_NAME, data: Buffer.from(jsonText, 'utf8') },
  ]);
  const filename = `SimklBackup-${makeTimestamp(new Date())}.zip`;

  return { filename, zipBuffer, jsonText };
}

function extractMediaRecords(backup) {
  const map = new Map();

  addEntries(map, backup.shows || [], 'shows', 'show');
  addEntries(map, backup.anime || [], 'anime', 'anime');
  addEntries(map, backup.movies || [], 'movies', 'movie');

  return [...map.values()].sort((left, right) => {
    const typeSort = left.sourceType.localeCompare(right.sourceType);
    if (typeSort !== 0) return typeSort;
    return left.title.localeCompare(right.title, 'en', { sensitivity: 'base' });
  });
}

function addEntries(map, entries, listName, sourceType) {
  for (const [index, entry] of entries.entries()) {
    const media = sourceType === 'movie' ? entry.movie : entry.show || entry.anime;
    const title = String((media && media.title) || '').trim();
    if (!title) continue;

    const year = Number.parseInt(String((media && media.year) || ''), 10) || null;
    const key = `${sourceType}|${normalizeTitle(title)}|${year || ''}`;
    let record = map.get(key);
    if (!record) {
      record = {
        id: makeRecordId(sourceType, title, year),
        sourceType,
        title,
        year,
        refs: [],
        occurrences: 0,
        watchedEpisodes: 0,
        rewatchEntries: 0,
        inputSimklId: '',
        initialSimklId: '',
        verifiedSimklId: '',
        simklType: sourceType === 'movie' ? 'movie' : sourceType === 'anime' ? 'anime' : 'tv',
        simklTitle: '',
        simklYear: null,
        confidence: null,
        lookupSource: '',
        typeVerifiedBy: '',
        status: 'not_found',
        reason: 'not_checked',
        error: '',
        candidates: [],
      };
      map.set(key, record);
    }

    record.refs.push({ listName, index });
    record.occurrences += 1;
    record.watchedEpisodes += countEntryEpisodes(entry);
    if (entry.is_rewatch) {
      record.rewatchEntries += 1;
    }
  }
}

function applyRecordsToBackup(backup, records, options) {
  const exportOptions = normalizeExportOptions(options);
  const cloned = cloneJson(backup);
  const refMap = new Map();
  for (const record of records) {
    for (const ref of record.refs || []) {
      refMap.set(`${ref.listName}:${ref.index}`, record);
    }
  }

  const next = { shows: [], anime: [], movies: [] };

  for (const listName of ['shows', 'anime', 'movies']) {
    const entries = cloned[listName] || [];
    for (const [index, entry] of entries.entries()) {
      const record = refMap.get(`${listName}:${index}`);
      const outputEntry = cloneJson(entry);
      let destination = listName;

      if (record) {
        if (!shouldExportRecord(record, exportOptions)) {
          continue;
        }

        const simklId = cleanId(record.inputSimklId);
        if (simklId) {
          applySimklId(outputEntry, record, simklId);
        }

        if (listName === 'shows' || listName === 'anime') {
          destination = record.simklType === 'anime' ? 'anime' : 'shows';
        }
      }

      next[destination].push(outputEntry);
    }
  }

  return next;
}

function normalizeExportOptions(options) {
  const config = options || {};
  return {
    includeTv: config.includeTv !== false,
    includeMovies: config.includeMovies !== false,
    includeAnime: config.includeAnime !== false,
  };
}

function shouldExportRecord(record, options) {
  if (record.sourceType === 'movie') {
    return options.includeMovies;
  }
  if (record.simklType === 'anime') {
    return options.includeAnime;
  }
  return options.includeTv;
}

function applySimklId(entry, record, simklId) {
  const media = record.sourceType === 'movie' ? entry.movie : entry.show || entry.anime;
  if (!media) return;

  const ids = {
    ...(media.ids || {}),
    simkl: Number.parseInt(simklId, 10),
  };
  delete ids.simkl_id;

  media.ids = {
    ...ids,
  };

  if (record.verifiedSimklId === simklId && record.simklTitle) {
    media.title = record.simklTitle;
  }
  if (record.verifiedSimklId === simklId && record.simklYear && record.sourceType === 'movie') {
    media.year = record.simklYear;
  }
}

function applyLookupResult(record, result, options) {
  const config = options || {};
  if (!result || result.status !== 'found' || !result.simklId) {
    markNotFound(record, result && result.reason ? result.reason : 'not_found');
    if (config.keepInput) {
      record.inputSimklId = config.keepInput;
    }
    return;
  }

  const id = String(result.simklId);
  record.inputSimklId = config.keepInput || id;
  record.verifiedSimklId = id;
  record.initialSimklId = record.initialSimklId || id;
  record.simklType = normalizeRecordType(result.simklType || record.simklType);
  record.simklTitle = result.title || record.simklTitle || '';
  record.simklYear = result.year || null;
  record.confidence = result.confidence || null;
  record.lookupSource = result.source || '';
  record.typeVerified = result.typeVerified === true;
  record.typeVerifiedBy = result.typeVerifiedBy || inferredTypeVerifier(result.source);
  record.status = 'found';
  record.reason = '';
  record.error = '';
  record.candidates = result.candidates || [];
}

function markNotFound(record, reason, error) {
  record.verifiedSimklId = '';
  record.simklTitle = '';
  record.simklYear = null;
  record.confidence = null;
  record.lookupSource = '';
  record.typeVerified = false;
  record.typeVerifiedBy = '';
  record.status = 'not_found';
  record.reason = reason || 'not_found';
  record.error = error || '';
  record.candidates = record.candidates || [];
}

function toPublicSession(session) {
  return {
    id: session.id,
    createdAt: session.createdAt,
    summary: session.summary,
    notes: session.notes,
    reportRows: (session.reportRows || []).map(toPublicReportRow),
    records: session.records.map(toPublicRecord),
  };
}

function toPublicReportRow(row) {
  return {
    source: row.source || '',
    row: row.row || '',
    type: row.type || '',
    title: row.title || '',
    season: row.season || '',
    episode: row.episode || '',
    year: row.year || '',
    reason: row.reason || '',
    details: row.details || '',
    suggestion: row.suggestion || '',
    action: row.action || '',
  };
}

function toPublicRecord(record) {
  return {
    id: record.id,
    sourceType: record.sourceType,
    title: record.title,
    year: record.year,
    occurrences: record.occurrences,
    watchedEpisodes: record.watchedEpisodes,
    rewatchEntries: record.rewatchEntries,
    inputSimklId: record.inputSimklId,
    initialSimklId: record.initialSimklId,
    verifiedSimklId: record.verifiedSimklId,
    simklType: record.simklType,
    simklTitle: record.simklTitle,
    simklYear: record.simklYear,
    typeVerified: record.typeVerified === true,
    confidence: record.confidence,
    lookupSource: record.lookupSource,
    typeVerifiedBy: record.typeVerifiedBy,
    status: record.status,
    reason: record.reason,
    error: record.error,
    candidates: (record.candidates || []).slice(0, 3),
  };
}

function validationTypes(record, preferredType) {
  if (record.sourceType === 'movie') return ['movie'];
  if (preferredType === 'anime') return ['anime', 'tv'];
  return ['tv', 'anime'];
}

function inferredTypeVerifier(source) {
  if (source === 'id_redirect' || source === 'redirect') return 'site_redirect';
  return source || '';
}

function normalizeRecordType(value) {
  const text = String(value || '').toLowerCase();
  if (text === 'movie') return 'movie';
  if (text === 'anime') return 'anime';
  return 'tv';
}

function makeRecordId(sourceType, title, year) {
  const hash = crypto
    .createHash('sha1')
    .update(`${sourceType}|${normalizeTitle(title)}|${year || ''}`)
    .digest('hex')
    .slice(0, 12);
  return `${sourceType}-${hash}`;
}

function countEntryEpisodes(entry) {
  let total = 0;
  for (const season of entry.seasons || []) {
    total += (season.episodes || []).length;
  }
  return total;
}

function cleanId(value) {
  const text = String(value || '').trim();
  return /^\d+$/.test(text) ? text : '';
}

function retryPhase(retry, record) {
  const title = record && record.title ? `: ${record.title}` : '';
  const status = retry && retry.status ? retry.status : 'error';
  const delay = retry && Number.isFinite(retry.delayMs) ? retry.delayMs : 0;
  const path = retry && retry.pathname ? ` at ${retry.pathname}` : '';
  return `SIMKL ${status}${path}; waiting ${delay}ms${title}`;
}

function randomId() {
  return crypto.randomBytes(12).toString('hex');
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

const noopProgress = () => {};
const noopConverterProgress = {
  status() {},
  tick() {},
};

module.exports = {
  createSessionFromZip,
  validateManualRecords,
  saveConfirmedMappings,
  buildDownload,
  toPublicSession,
  extractMediaRecords,
  applyRecordsToBackup,
};
