'use strict';

const DEFAULT_LIMIT = 80 * 1024 * 1024;

async function readRequestBuffer(request, limitBytes) {
  const limit = limitBytes || DEFAULT_LIMIT;
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      throw new Error(`Upload too large. Limit: ${Math.round(limit / 1024 / 1024)} MB.`);
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

function parseMultipart(buffer, contentType) {
  const boundary = getBoundary(contentType);
  if (!boundary) {
    throw new Error('Content-Type multipart/form-data is missing a boundary.');
  }

  const delimiter = Buffer.from(`--${boundary}`);
  const headerSeparator = Buffer.from('\r\n\r\n');
  const fields = {};
  const files = {};

  let cursor = buffer.indexOf(delimiter);
  while (cursor !== -1) {
    cursor += delimiter.length;

    if (buffer[cursor] === 45 && buffer[cursor + 1] === 45) {
      break;
    }
    if (buffer[cursor] === 13 && buffer[cursor + 1] === 10) {
      cursor += 2;
    }

    const headerEnd = buffer.indexOf(headerSeparator, cursor);
    if (headerEnd === -1) break;

    const headerText = buffer.subarray(cursor, headerEnd).toString('utf8');
    const headers = parsePartHeaders(headerText);
    const disposition = parseDisposition(headers['content-disposition'] || '');
    const next = buffer.indexOf(delimiter, headerEnd + headerSeparator.length);
    if (next === -1) break;

    let dataEnd = next;
    if (buffer[dataEnd - 2] === 13 && buffer[dataEnd - 1] === 10) {
      dataEnd -= 2;
    }
    const data = buffer.subarray(headerEnd + headerSeparator.length, dataEnd);

    if (disposition.name) {
      if (disposition.filename) {
        files[disposition.name] = {
          name: disposition.filename,
          type: headers['content-type'] || 'application/octet-stream',
          data,
        };
      } else {
        fields[disposition.name] = data.toString('utf8');
      }
    }

    cursor = next;
  }

  return { fields, files };
}

function getBoundary(contentType) {
  const match = String(contentType || '').match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  return match ? (match[1] || match[2]).trim() : '';
}

function parsePartHeaders(text) {
  const headers = {};
  for (const line of text.split(/\r?\n/)) {
    const index = line.indexOf(':');
    if (index === -1) continue;
    headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }
  return headers;
}

function parseDisposition(value) {
  const result = {};
  for (const part of String(value || '').split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim().toLowerCase();
    let data = part.slice(index + 1).trim();
    if (data.startsWith('"') && data.endsWith('"')) {
      data = data.slice(1, -1).replace(/\\"/g, '"');
    }
    result[key] = data;
  }
  return result;
}

module.exports = {
  readRequestBuffer,
  parseMultipart,
};
