'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');

/**
 * Agent-desk-only "last opened" cursors per WhatsApp number.
 * Does not touch bot sessions, webhooks, or message transcripts.
 */

function createChatReadStore(filePath = config.agent.chatReadsPath) {
  const file = path.resolve(filePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let chain = Promise.resolve();

  function withLock(fn) {
    const run = chain.then(fn, fn);
    chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async function readAllUnlocked() {
    if (!fs.existsSync(file)) {
      return { reads: {} };
    }
    try {
      const raw = await fs.promises.readFile(file, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed.reads !== 'object' || !parsed.reads) {
        return { reads: {} };
      }
      return { reads: parsed.reads };
    } catch {
      return { reads: {} };
    }
  }

  async function writeAllUnlocked(data) {
    const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random()
      .toString(36)
      .slice(2, 8)}.tmp`;
    await fs.promises.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    await fs.promises.rename(tmp, file);
  }

  async function getAll() {
    return withLock(async () => {
      const data = await readAllUnlocked();
      return { ...data.reads };
    });
  }

  async function get(waNumber) {
    const wa = String(waNumber || '').replace(/\D/g, '');
    if (!wa) return null;
    const all = await getAll();
    return all[wa] || null;
  }

  async function markRead(waNumber, at = new Date().toISOString()) {
    const wa = String(waNumber || '').replace(/\D/g, '');
    if (!wa) {
      const err = new Error('wa_required');
      err.status = 400;
      throw err;
    }
    const when = at || new Date().toISOString();
    return withLock(async () => {
      const data = await readAllUnlocked();
      data.reads[wa] = when;
      await writeAllUnlocked(data);
      return { waNumber: wa, lastReadAt: when };
    });
  }

  return { getAll, get, markRead, file };
}

module.exports = { createChatReadStore };
