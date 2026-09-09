'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

/**
 * Unresolved git conflict markers in src/app.js are a SyntaxError on require —
 * the whole bot (webhook, FSM, scheduler, agent desk) never boots.
 */
function testAppJsHasNoConflictMarkers() {
  const appPath = path.join(__dirname, '..', 'src', 'app.js');
  const source = fs.readFileSync(appPath, 'utf8');
  assert.ok(!source.includes('<<<<<<<'), 'src/app.js must not contain <<<<<<<');
  assert.ok(!source.includes('>>>>>>>'), 'src/app.js must not contain >>>>>>>');
  // Lone ======= lines are conflict markers; allow ===== only inside strings/comments
  // by checking the standard 7-char git conflict separator on its own line.
  assert.ok(
    !/^=======+$/m.test(source),
    'src/app.js must not contain a git conflict ======= separator line'
  );
  // eslint-disable-next-line no-console
  console.log('✓ src/app.js has no unresolved conflict markers');
}

function testCreateAppLoads() {
  // Clearing require cache so a prior failed load cannot mask the check.
  const appPath = require.resolve('../src/app');
  delete require.cache[appPath];
  const { createApp } = require('../src/app');
  assert.strictEqual(typeof createApp, 'function');
  // eslint-disable-next-line no-console
  console.log('✓ require(src/app) succeeds (createApp export)');
}

testAppJsHasNoConflictMarkers();
testCreateAppLoads();
