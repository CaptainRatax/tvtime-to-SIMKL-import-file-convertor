#!/usr/bin/env node

'use strict';

const { loadEnv } = require('./src/env');
const { startServer } = require('./src/web-server');

loadEnv();

startServer().then(({ url }) => {
  console.log(`tvtime-to-SIMKL-import-file-convertor web`);
  console.log(`Open at: ${url}`);
  console.log('Use Ctrl+C to stop the server.');
}).catch((error) => {
  console.error(`Failed to start server: ${error.message}`);
  process.exitCode = 1;
});
