'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const { createPostgresMessageStore } = require('./postgresMessageStore');

/**
 * Per-number transcript for the agent desk.
 * direction: in | out
 * source: customer | bot | agent
 *
 * Backends:
 * - file (default): JSONL under AGENT_TRANSCRIPT_PATH
 * - postgres: Supabase / any Postgres via DATABASE_URL
 */

function createFileMessageStore(dir = config.agent.transcriptPath) {
  const root = path.resolve(dir);
  fs.mkdirSync(root, { recursive: true });

  function fileFor(waNumber) {
    const safe = String(waNumber).replace(/[^a-zA-Z0-9_+-]/g, '_');
    return path.join(root, `${safe}.jsonl`);
  }

  async function append(message) {
    const waNumber = String(message.waNumber || '');
    if (!waNumber) return null;
    const row = {
      id:
        message.id ||
        `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      waNumber,
      direction: message.direction === 'out' ? 'out' : 'in',
      source: message.source || (message.direction === 'out' ? 'bot' : 'customer'),
      text: message.text != null ? String(message.text) : '',
      replyId: message.replyId || null,
      wamid: message.wamid || null,
      at: message.at || new Date().toISOString(),
    };
    await fs.promises.appendFile(fileFor(waNumber), `${JSON.stringify(row)}\n`, 'utf8');
    return row;
  }

  async function listMessages(waNumber, { limit = 200 } = {}) {
    const file = fileFor(waNumber);
    if (!fs.existsSync(file)) return [];
    const raw = await fs.promises.readFile(file, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    const sliced = lines.slice(Math.max(0, lines.length - limit));
    return sliced.map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter(Boolean);
  }

  async function listChats({ lastReadByWa = {} } = {}) {
    const names = await fs.promises.readdir(root);
    const chats = [];
    const reads = normalizeReadsMap(lastReadByWa);
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(root, name);
      const raw = await fs.promises.readFile(file, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      if (!lines.length) continue;
      let last = null;
      try {
        last = JSON.parse(lines[lines.length - 1]);
      } catch {
        continue;
      }
      const wa = normalizeWa(last.waNumber);
      const since = reads[wa] || null;
      let unreadCount = 0;
      let inboundTotal = 0;
      for (const line of lines) {
        let row = null;
        try {
          row = JSON.parse(line);
        } catch {
          continue;
        }
        if (!row || !isInboundRow(row)) continue;
        inboundTotal += 1;
        if (since && String(row.at) > String(since)) unreadCount += 1;
      }
      // Never opened in the desk: every customer message is still unread for staff
      // (even if the bot already replied afterward).
      if (!since) unreadCount = inboundTotal;
      const chat = {
        waNumber: wa || String(last.waNumber || ''),
        lastAt: last.at,
        lastText: last.text,
        lastDirection: last.direction,
        lastSource: last.source,
        messageCount: lines.length,
        unreadCount,
        lastReadAt: since,
      };
      chat.unreadCount = applyUnreadFloor(chat, since);
      chats.push(chat);
    }
    chats.sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));
    return chats;
  }

  return { append, listMessages, listChats, root, backend: 'file' };
}

function normalizeWa(wa) {
  return String(wa || '').replace(/\D/g, '');
}

function normalizeReadsMap(map) {
  const out = {};
  for (const [key, value] of Object.entries(map || {})) {
    const wa = normalizeWa(key);
    if (!wa) continue;
    // Keep the latest cursor if duplicates appear under different formats.
    if (!out[wa] || String(value) > String(out[wa])) out[wa] = value;
  }
  return out;
}

function isInboundRow(row) {
  if (!row) return false;
  if (row.direction === 'in') return true;
  if (row.direction === 'out') return false;
  return row.source === 'customer';
}

/** Ensure a latest customer message after last-read always shows as unread. */
function applyUnreadFloor(chat, since) {
  let n = Number(chat && chat.unreadCount) || 0;
  const customerLast =
    (chat && chat.lastDirection === 'in') ||
    (chat && chat.lastSource === 'customer');
  if (
    customerLast &&
    (!since || String(chat.lastAt) > String(since))
  ) {
    n = Math.max(n, 1);
  }
  return n;
}

/**
 * @param {string|object} [options] Directory path (tests) or { backend, databaseUrl, transcriptPath }
 */
function createMessageStore(options) {
  if (typeof options === 'string') {
    return createFileMessageStore(options);
  }

  const opts = options || {};
  const databaseUrl = opts.databaseUrl || config.agent.databaseUrl;
  const configured =
    opts.backend ||
    config.agent.messageStore ||
    (databaseUrl ? 'postgres' : 'file');
  const backend = String(configured).toLowerCase();

  if (backend === 'postgres') {
    return createPostgresMessageStore(databaseUrl);
  }

  return createFileMessageStore(opts.transcriptPath || config.agent.transcriptPath);
}

module.exports = { createMessageStore, createFileMessageStore };
