'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');

/**
 * Pluggable lead logger.
 * Backends: console | file | json (jsonl)
 * Swap later for Sheets/CRM by implementing the same logLead(record) shape.
 */

function buildRecord({
  waNumber,
  timestamp,
  exitReason,
  path: statePath,
  interruptedFrom,
  meta,
}) {
  return {
    waNumber,
    timestamp: timestamp || new Date().toISOString(),
    exitReason,
    path: Array.isArray(statePath) ? [...statePath] : [],
    interruptedFrom: interruptedFrom || null,
    meta: meta || {},
  };
}

class ConsoleLeadLogger {
  async logLead(record) {
    // Structured console output — no CRM hardcoding
    // eslint-disable-next-line no-console
    console.log('[lead]', JSON.stringify(record));
    return record;
  }
}

class FileLeadLogger {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  async logLead(record) {
    fs.appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, 'utf8');
    return record;
  }
}

class JsonLeadLogger extends FileLeadLogger {}

function createLeadLogger(override) {
  const type = (override || config.logger.type || 'console').toLowerCase();
  if (type === 'file' || type === 'json') {
    return new FileLeadLogger(config.logger.path);
  }
  return new ConsoleLeadLogger();
}

module.exports = {
  createLeadLogger,
  buildRecord,
  ConsoleLeadLogger,
  FileLeadLogger,
  JsonLeadLogger,
};
