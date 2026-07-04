'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

const { formatDuration } = require('./core');
const { readRequestBuffer, parseMultipart } = require('./multipart');
const {
  createSessionFromZip,
  validateManualRecords,
  saveConfirmedMappings,
  buildDownload,
  toPublicSession,
} = require('./session-service');
const { createMongoStoreFromEnv } = require('./mongo-store');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const DEFAULT_PORT = 3000;
const DEFAULT_HOST = '127.0.0.1';

const jobs = new Map();
const validationJobs = new Map();
const sessions = new Map();
let mappingStoreLoaded = false;
let mappingStore = null;

function createApp() {
  return http.createServer(async (request, response) => {
    try {
      await route(request, response);
    } catch (error) {
      sendError(response, error);
    }
  });
}

async function route(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

  if (request.method === 'GET' && url.pathname === '/') {
    return sendStatic(response, 'index.html');
  }
  if (request.method === 'GET' && url.pathname.startsWith('/assets/')) {
    return sendStatic(response, url.pathname.replace('/assets/', ''));
  }
  if (request.method === 'POST' && url.pathname === '/api/jobs') {
    return createJob(request, response);
  }
  if (request.method === 'GET' && url.pathname.startsWith('/api/sessions/')) {
    return getSession(url.pathname.split('/').pop(), response);
  }
  if (request.method === 'GET' && url.pathname === '/api/config') {
    return sendJson(response, 200, {
      mongoConfigured: Boolean(process.env.MONGODB_URL),
    });
  }
  if (request.method === 'POST' && url.pathname === '/api/validation-jobs') {
    return createValidationJob(request, response);
  }
  if (request.method === 'GET' && url.pathname.startsWith('/api/validation-jobs/')) {
    return getValidationJob(url.pathname.split('/').pop(), response);
  }
  if (request.method === 'POST' && url.pathname === '/api/db/save') {
    return saveMappings(request, response);
  }
  if (request.method === 'GET' && url.pathname.startsWith('/api/jobs/')) {
    return getJob(url.pathname.split('/').pop(), response);
  }
  if (request.method === 'POST' && url.pathname === '/api/validate') {
    return validateRecords(request, response);
  }
  if (request.method === 'POST' && url.pathname === '/api/download') {
    return downloadBackup(request, response);
  }

  sendJson(response, 404, { error: 'not_found' });
}

async function createJob(request, response) {
  const body = await readRequestBuffer(request);
  const parsed = parseMultipart(body, request.headers['content-type']);
  const zip = parsed.files.zip;
  if (!zip || !zip.data || !zip.data.length) {
    throw new Error('Upload the .zip file exported by TV Time.');
  }

  const clientId = String(process.env.SIMKL_CLIENT_ID || '').trim();
  if (!clientId) {
    throw new Error('Missing SIMKL_CLIENT_ID. Add the client_id to the .env file and restart the server.');
  }

  const job = makeJob(zip.name);
  job.sessionId = job.id;
  jobs.set(job.id, job);
  sendJson(response, 202, {
    jobId: job.id,
    sessionId: job.sessionId,
  });

  setImmediate(() => {
    processJob(job, zip.data, {
      clientId,
      includePlanToWatch: parsed.fields.includePlanToWatch !== 'false',
      includeRewatches: parsed.fields.includeRewatches !== 'false',
    }).catch((error) => {
      job.status = 'error';
      job.error = error.message;
      updateJobProgress(job, {
        phase: 'error',
        done: job.progress.done,
        total: job.progress.total,
      });
    });
  });
}

async function processJob(job, zipBuffer, options) {
  job.status = 'running';
  job.startedAt = Date.now();

  const session = await createSessionFromZip(zipBuffer, {
    ...options,
    sessionId: job.sessionId || job.id,
    mappingStore: getMappingStoreOptional(),
    progress(update) {
      updateJobProgress(job, update);
    },
  });

  sessions.set(session.id, session);
  await persistSession(session);
  job.status = 'done';
  job.sessionId = session.id;
  job.result = toPublicSession(session);
  updateJobProgress(job, {
    phase: 'ready for review',
    done: Math.max(1, job.progress.total),
    total: Math.max(1, job.progress.total),
  });
}

async function createValidationJob(request, response) {
  const payload = await readJsonBody(request);
  const session = await requireSession(payload.sessionId);

  const updates = payload.records || [];
  const job = makeJob('simkl-validation');
  updateJobProgress(job, {
    phase: 'preparing validation',
    done: 0,
    total: Math.max(1, updates.length),
  });
  validationJobs.set(job.id, job);
  sendJson(response, 202, { jobId: job.id });

  setImmediate(() => {
    processValidationJob(job, session, updates).catch((error) => {
      job.status = 'error';
      job.error = error.message;
      updateJobProgress(job, {
        phase: 'validation error',
        done: job.progress.done,
        total: job.progress.total,
      });
    });
  });
}

async function processValidationJob(job, session, updates) {
  job.status = 'running';
  job.startedAt = Date.now();

  const changed = await validateManualRecords(session, updates, {
    mappingStore: getMappingStoreOptional(),
    progress(update) {
      updateJobProgress(job, update);
    },
  });
  await persistSession(session);

  job.status = 'done';
  job.result = {
    records: changed,
    session: toPublicSession(session),
  };
  updateJobProgress(job, {
    phase: 'validation complete',
    done: Math.max(1, updates.length),
    total: Math.max(1, updates.length),
  });
}

function getValidationJob(jobId, response) {
  const job = validationJobs.get(jobId);
  if (!job) {
    return sendJson(response, 404, { error: 'validation_job_not_found' });
  }
  return sendJson(response, 200, publicJob(job));
}

async function getSession(sessionId, response) {
  const id = decodeURIComponent(String(sessionId || '')).trim();
  const job = jobs.get(id);
  if (job) {
    const payload = {
      job: publicJob(job),
    };
    if (job.status === 'done' && job.result) {
      payload.session = job.result;
    }
    return sendJson(response, 200, payload);
  }

  const session = await requireSession(id);
  sendJson(response, 200, {
    session: toPublicSession(session),
  });
}

function getJob(jobId, response) {
  const job = jobs.get(jobId);
  if (!job) {
    return sendJson(response, 404, { error: 'job_not_found' });
  }
  return sendJson(response, 200, publicJob(job));
}

async function validateRecords(request, response) {
  const payload = await readJsonBody(request);
  const session = await requireSession(payload.sessionId);

  const changed = await validateManualRecords(session, payload.records || [], {
    mappingStore: getMappingStoreOptional(),
  });
  await persistSession(session);
  sendJson(response, 200, {
    records: changed,
    session: toPublicSession(session),
  });
}

async function saveMappings(request, response) {
  const payload = await readJsonBody(request);
  const session = await requireSession(payload.sessionId);

  const store = getMappingStoreRequired();
  const result = await saveConfirmedMappings(session, payload.records || [], store);
  sendJson(response, 200, result);
}

async function downloadBackup(request, response) {
  const payload = await readJsonBody(request);
  const session = await requireSession(payload.sessionId);

  const download = buildDownload(session, payload.records || [], payload.exportOptions || {});
  response.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${download.filename}"`,
    'Content-Length': download.zipBuffer.length,
    'Cache-Control': 'no-store',
  });
  response.end(download.zipBuffer);
}

async function readJsonBody(request) {
  const buffer = await readRequestBuffer(request, 10 * 1024 * 1024);
  if (!buffer.length) return {};
  return JSON.parse(buffer.toString('utf8'));
}

function makeJob(filename) {
  const id = randomId();
  return {
    id,
    filename,
    status: 'queued',
    createdAt: Date.now(),
    startedAt: Date.now(),
    sessionId: null,
    result: null,
    error: '',
    progress: {
      phase: 'queued',
      done: 0,
      total: 1,
      remaining: 1,
      percent: 0,
      elapsed: '00:00:00',
      eta: '--:--:--',
    },
  };
}

function updateJobProgress(job, update) {
  const total = Math.max(1, Number(update.total) || job.progress.total || 1);
  const done = Math.min(total, Math.max(0, Number(update.done) || 0));
  const elapsedMs = Date.now() - job.startedAt;
  const remaining = Math.max(0, total - done);
  const etaMs = done > 0 ? (elapsedMs / done) * remaining : NaN;

  job.progress = {
    phase: update.phase || job.progress.phase,
    done,
    total,
    remaining,
    percent: Math.round((done / total) * 1000) / 10,
    elapsed: formatDuration(elapsedMs),
    eta: formatDuration(etaMs),
  };
}

function publicJob(job) {
  return {
    id: job.id,
    filename: job.filename,
    status: job.status,
    error: job.error,
    progress: job.progress,
    sessionId: job.sessionId || job.id,
    result: job.result,
  };
}

function sendStatic(response, fileName) {
  const safeName = path.basename(fileName);
  const filePath = path.join(PUBLIC_DIR, safeName);
  if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath)) {
    return sendJson(response, 404, { error: 'asset_not_found' });
  }

  const ext = path.extname(filePath).toLowerCase();
  const type = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
  }[ext] || 'application/octet-stream';

  response.writeHead(200, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(filePath).pipe(response);
}

function sendJson(response, status, payload) {
  const body = `${JSON.stringify(payload)}\n`;
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

function sendError(response, error) {
  const status = /not_found/i.test(error.message) ? 404 : 400;
  sendJson(response, status, {
    error: error.message,
  });
}

function startServer(options) {
  const config = options || {};
  const host = config.host || process.env.HOST || DEFAULT_HOST;
  const requestedPort = Number(config.port || process.env.PORT || DEFAULT_PORT);
  const server = createApp();

  return listenWithFallback(server, host, requestedPort, requestedPort + 10);
}

function listenWithFallback(server, host, port, maxPort) {
  return new Promise((resolve, reject) => {
    const tryListen = (candidate) => {
      server.once('error', (error) => {
        if (error.code === 'EADDRINUSE' && candidate < maxPort) {
          tryListen(candidate + 1);
          return;
        }
        reject(error);
      });

      server.listen(candidate, host, () => {
        resolve({
          server,
          host,
          port: candidate,
          url: `http://${host}:${candidate}/`,
        });
      });
    };

    tryListen(port);
  });
}

function randomId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

async function requireSession(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) {
    throw new Error('Missing session ID.');
  }

  const existing = sessions.get(id);
  if (existing) {
    return existing;
  }

  const store = getMappingStoreOptional();
  if (store && typeof store.getSession === 'function') {
    const restored = await store.getSession(id);
    if (restored) {
      restored.clientId = String(process.env.SIMKL_CLIENT_ID || '').trim();
      sessions.set(restored.id, restored);
      return restored;
    }
  }

  throw new Error('Session not found. Check the ID or upload the ZIP again.');
}

async function persistSession(session) {
  const store = getMappingStoreOptional();
  if (!store || typeof store.saveSession !== 'function') {
    return false;
  }

  try {
    await store.saveSession(session);
    return true;
  } catch (error) {
    if (session && Array.isArray(session.notes)) {
      session.notes.push(`Session was not saved to MongoDB: ${error.message}`);
    }
    return false;
  }
}

function getMappingStoreOptional() {
  if (!mappingStoreLoaded) {
    mappingStore = createMongoStoreFromEnv();
    mappingStoreLoaded = true;
  }
  return mappingStore;
}

function getMappingStoreRequired() {
  const store = getMappingStoreOptional();
  if (!store) {
    throw new Error('Missing MONGODB_URL. Configure the .env file and restart the server.');
  }
  return store;
}

module.exports = {
  createApp,
  startServer,
};
