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
      return { reads: {}, forcedUnread: {} };
    }
    try {
      const raw = await fs.promises.readFile(file, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed.reads !== 'object' || !parsed.reads) {
        return { reads: {}, forcedUnread: {} };
      }
      return {
        reads: parsed.reads,
        forcedUnread:
          parsed.forcedUnread && typeof parsed.forcedUnread === 'object'
            ? parsed.forcedUnread
            : {},
      };
    } catch {
      return { reads: {}, forcedUnread: {} };
    }
  }

  async function writeAllUnlocked(data) {
    const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random()
      .toString(36)
      .slice(2, 8)}.tmp`;
    const payload = {
      reads: data.reads || {},
      forcedUnread: data.forcedUnread || {},
    };
    await fs.promises.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await fs.promises.rename(tmp, file);
  }

  async function getAll() {
    return withLock(async () => {
      const data = await readAllUnlocked();
      return { ...data.reads };
    });
  }

  async function getState() {
    return withLock(async () => {
      const data = await readAllUnlocked();
      return {
        reads: { ...data.reads },
        forcedUnread: { ...data.forcedUnread },
      };
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
      if (data.forcedUnread) delete data.forcedUnread[wa];
      await writeAllUnlocked(data);
      return { waNumber: wa, lastReadAt: when, forcedUnread: false };
    });
  }

  async function markUnread(waNumber) {
    const wa = String(waNumber || '').replace(/\D/g, '');
    if (!wa) {
      const err = new Error('wa_required');
      err.status = 400;
      throw err;
    }
    return withLock(async () => {
      const data = await readAllUnlocked();
      // Epoch cursor → every inbound counts as unread again.
      data.reads[wa] = '1970-01-01T00:00:00.000Z';
      if (!data.forcedUnread) data.forcedUnread = {};
      data.forcedUnread[wa] = true;
      await writeAllUnlocked(data);
      return {
        waNumber: wa,
        lastReadAt: data.reads[wa],
        forcedUnread: true,
      };
    });
  }

  return { getAll, getState, get, markRead, markUnread, file };
}

module.exports = { createChatReadStore };
