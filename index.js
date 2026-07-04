#!/usr/bin/env node

'use strict';

const { main } = require('./src/core');

main().catch((error) => {
  console.error(`\nError: ${error.message}`);
  if (process.env.DEBUG) {
    console.error(error.stack);
  }
  process.exitCode = 1;
});
