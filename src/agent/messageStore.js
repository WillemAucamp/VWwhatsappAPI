'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const { createPostgresMessageStore } = require('./postgresMessageStore');
const { extensionForMime } = require('./inboundMedia');

/**
 * Per-number transcript for the agent desk.
 * direction: in | out
 * source: customer | bot | agent
 *
 * Backends:
 * - file (default): JSONL under AGENT_TRANSCRIPT_PATH
 * - postgres: Supabase / any Postgres via DATABASE_URL
 */

function createFileMessageStore(
  dir = config.agent.transcriptPath,
  mediaDir = config.agent.mediaPath
) {
  const root = path.resolve(dir);
  const mediaRoot = path.resolve(mediaDir);
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(mediaRoot, { recursive: true });

  function fileFor(waNumber) {
    const safe = String(waNumber || '').replace(/[^a-zA-Z0-9_+-]/g, '_');
    return path.join(root, `${safe}.jsonl`);
  }

  function publicMediaFields(row) {
    if (!row || !row.mediaKind) return row;
    const { mediaBuffer, ...rest } = row;
    return {
      ...rest,
      hasMedia: true,
    };
  }

  async function writeMediaFile(id, mimeType, buffer) {
    const ext = extensionForMime(mimeType);
    const rel = `${String(id).replace(/[^a-zA-Z0-9_-]/g, '_')}.${ext}`;
    const abs = path.join(mediaRoot, rel);
    await fs.promises.writeFile(abs, buffer);
    return { mediaPath: rel, abs };
  }

  async function append(message) {
    const waNumber = normalizeWa(message.waNumber) || String(message.waNumber || '');
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
    if (message.mediaKind) {
      row.mediaKind = String(message.mediaKind);
      row.mediaMime = message.mediaMime || message.mimeType || null;
      row.mediaFilename = message.mediaFilename || message.filename || null;
      row.mediaByteLength =
        message.mediaByteLength != null
          ? Number(message.mediaByteLength)
          : message.mediaBuffer
            ? message.mediaBuffer.length
            : null;
      if (message.mediaBuffer && message.mediaBuffer.length) {
        const saved = await writeMediaFile(
          row.id,
          row.mediaMime || 'application/octet-stream',
          message.mediaBuffer
        );
        row.mediaPath = saved.mediaPath;
      } else if (message.mediaPath) {
        row.mediaPath = String(message.mediaPath);
      }
    }
    await fs.promises.appendFile(fileFor(waNumber), `${JSON.stringify(row)}\n`, 'utf8');
    return publicMediaFields(row);
  }

  function candidateFiles(waNumber) {
    const { waLookupKeys } = require('../../public/agent/deskListFilters');
    const files = [];
    const seen = new Set();
    waLookupKeys(waNumber).forEach((id) => {
      const file = fileFor(id);
      if (file && !seen.has(file) && fs.existsSync(file)) {
        seen.add(file);
        files.push(file);
      }
    });
    return files;
  }

  async function listMessages(waNumber, { limit = 200 } = {}) {
    const files = candidateFiles(waNumber);
    if (!files.length) return [];
    const lines = [];
    for (const file of files) {
      const raw = await fs.promises.readFile(file, 'utf8');
      lines.push(...raw.split('\n').filter(Boolean));
    }
    const parsed = lines
      .map((line) => {
        try {
          return publicMediaFields(JSON.parse(line));
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
    return parsed.slice(Math.max(0, parsed.length - limit));
  }

  async function findMessage(waNumber, messageId) {
    const files = candidateFiles(waNumber);
    for (const file of files) {
      const raw = await fs.promises.readFile(file, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const row = JSON.parse(lines[i]);
          if (row && row.id === messageId) return row;
        } catch {
          // skip
        }
      }
    }
    return null;
  }

  async function readMedia(waNumber, messageId) {
    const row = await findMessage(waNumber, messageId);
    if (!row || !row.mediaKind || !row.mediaPath) return null;
    const abs = path.join(mediaRoot, path.basename(row.mediaPath));
    if (!abs.startsWith(mediaRoot) || !fs.existsSync(abs)) return null;
    const buffer = await fs.promises.readFile(abs);
    return {
      buffer,
      mimeType: row.mediaMime || 'application/octet-stream',
      filename: row.mediaFilename || path.basename(abs),
      mediaKind: row.mediaKind,
    };
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

  async function searchChats({ query, lastReadByWa = {}, limit = 40 } = {}) {
    const { waNumberMatchesQuery } = require('../../public/agent/deskListFilters');
    const chats = await listChats({ lastReadByWa });
    const cap = Math.max(1, Math.min(80, Number(limit) || 40));
    return chats.filter((chat) => waNumberMatchesQuery(chat.waNumber, query)).slice(0, cap);
  }

  async function countChats() {
    const names = await fs.promises.readdir(root);
    return names.filter((name) => name.endsWith('.jsonl')).length;
  }

  async function listWaNumbers({ limit = 20, after = '' } = {}) {
    const names = await fs.promises.readdir(root);
    const afterKey = String(after || '');
    const ids = names
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => name.slice(0, -'.jsonl'.length))
      .filter((id) => id && id > afterKey)
      .sort();
    const cap = Math.max(1, Number(limit) || 20);
    return ids.slice(0, cap);
  }

  return {
    append,
    listMessages,
    listChats,
    searchChats,
    countChats,
    listWaNumbers,
    readMedia,
    root,
    mediaRoot,
    backend: 'file',
  };
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

  return createFileMessageStore(
    opts.transcriptPath || config.agent.transcriptPath,
    opts.mediaPath || config.agent.mediaPath
  );
}

module.exports = { createMessageStore, createFileMessageStore };
