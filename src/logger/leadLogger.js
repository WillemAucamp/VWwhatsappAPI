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

/**
 * Stable fingerprint matching FsmEngine._leadKey. Used so a successful
 * append + failed session marker still cannot double-write after restart.
 */
function leadFingerprint(record) {
  if (!record) return '';
  const pathKey = Array.isArray(record.path) ? record.path.join('>') : '';
  return `${record.waNumber}|${record.exitReason}|${pathKey}|${record.timestamp}`;
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
    /** @type {Set<string>|null} lazy index of fingerprints already on disk */
    this._keys = null;
  }

  _ensureKeyIndex() {
    if (this._keys) return;
    this._keys = new Set();
    if (!fs.existsSync(this.filePath)) return;
    let text = '';
    try {
      text = fs.readFileSync(this.filePath, 'utf8');
    } catch {
      return;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const key = leadFingerprint(JSON.parse(line));
        if (key) this._keys.add(key);
      } catch {
        // skip corrupt lines
      }
    }
  }

  async logLead(record) {
    const key = leadFingerprint(record);
    if (key) {
      this._ensureKeyIndex();
      if (this._keys.has(key)) {
        return record;
      }
    }
    fs.appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, 'utf8');
    if (key) {
      this._ensureKeyIndex();
      this._keys.add(key);
    }
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
  leadFingerprint,
  ConsoleLeadLogger,
  FileLeadLogger,
  JsonLeadLogger,
};
