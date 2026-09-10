'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const files = [
  'manual-test.js',
  'critical-bugs.test.js',
  'terminal-send-failure.test.js',
  'terminal-outbound-retry.test.js',
  'terminal-persist-before-lead.test.js',
  'pending-lead-flush.test.js',
  'pending-lead-restart-idempotency.test.js',
  'pending-lead-prepersist.test.js',
  'pending-lead-ttl.test.js',
  'pending-terminal-outbound-ttl.test.js',
  'scheduler-terminal-outbound-retry.test.js',
  'followup-inbound-race.test.js',
  'webhook-dedupe.test.js',
  'inbound-media.test.js',
  'followup-tick-isolation.test.js',
  'meta-readiness.test.js',
  'transport-graph.test.js',
  'catalog-product-list.test.js',
  'agent-desk.test.js',
  'message-store.test.js',
];

let failed = 0;
for (const file of files) {
  const full = path.join(__dirname, file);
  // eslint-disable-next-line no-console
  console.log(`\n======== ${file} ========`);
  const result = spawnSync(process.execPath, [full], { stdio: 'inherit' });
  if (result.status !== 0) failed += 1;
}

if (failed) {
  // eslint-disable-next-line no-console
  console.error(`\n${failed} test file(s) failed`);
  process.exit(1);
}

// eslint-disable-next-line no-console
console.log('\nAll test files passed.');
