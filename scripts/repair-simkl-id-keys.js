#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');

const {
  SIMKL_INTERNAL_JSON_NAME,
  ZipArchive,
  createZip,
} = require('../src/core');

function main() {
  const input = process.argv[2];
  if (!input || input === '--help' || input === '-h') {
    printHelp();
    return;
  }

  const inputPath = path.resolve(input);
  if (!fs.existsSync(inputPath)) {
    throw new Error(`File not found: ${inputPath}`);
  }

  const backup = readBackup(inputPath);
  const fixedCount = normalizeSimklIds(backup);
  const outputPath = makeOutputPath(inputPath);
  const jsonText = `${JSON.stringify(backup, null, 2)}\n`;
  fs.writeFileSync(outputPath, createZip([
    { name: SIMKL_INTERNAL_JSON_NAME, data: Buffer.from(jsonText, 'utf8') },
  ]));

  console.log(`Fixed IDs: ${fixedCount}`);
  console.log(`Repaired ZIP: ${outputPath}`);
}

function readBackup(inputPath) {
  const buffer = fs.readFileSync(inputPath);
  if (path.extname(inputPath).toLowerCase() === '.zip') {
    const zip = ZipArchive.fromBuffer(buffer);
    const jsonEntry = zip.getEntry(SIMKL_INTERNAL_JSON_NAME) ||
      [...zip.entries.values()].find((entry) => entry.name.toLowerCase().endsWith('.json'));
    if (!jsonEntry) {
      throw new Error('ZIP does not contain an internal JSON file.');
    }
    return JSON.parse(zip.readBuffer(jsonEntry).toString('utf8'));
  }

  return JSON.parse(buffer.toString('utf8'));
}

function normalizeSimklIds(value) {
  let fixed = 0;

  visit(value, (object) => {
    if (!object.ids || typeof object.ids !== 'object') {
      return;
    }

    if (object.ids.simkl_id && !object.ids.simkl) {
      object.ids.simkl = object.ids.simkl_id;
      fixed += 1;
    }
    if (object.ids.simkl_id) {
      delete object.ids.simkl_id;
    }
  });

  return fixed;
}

function visit(value, callback) {
  if (!value || typeof value !== 'object') {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      visit(item, callback);
    }
    return;
  }

  callback(value);
  for (const child of Object.values(value)) {
    visit(child, callback);
  }
}

function makeOutputPath(inputPath) {
  const directory = path.dirname(inputPath);
  const name = path.basename(inputPath, path.extname(inputPath));
  return path.join(directory, `${name}-ids-fixed.zip`);
}

function printHelp() {
  console.log(`Usage:
  node scripts/repair-simkl-id-keys.js <SimklBackup.zip|SimklBackup.json>

Creates a new ZIP containing SimklBackup.json, replacing ids.simkl_id with ids.simkl.`);
}

main();
