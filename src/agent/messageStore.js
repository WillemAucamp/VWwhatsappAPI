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

  async function listChats() {
    const names = await fs.promises.readdir(root);
    const chats = [];
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
      chats.push({
        waNumber: last.waNumber,
        lastAt: last.at,
        lastText: last.text,
        lastDirection: last.direction,
        lastSource: last.source,
        messageCount: lines.length,
      });
    }
    chats.sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));
    return chats;
  }

  return { append, listMessages, listChats, root, backend: 'file' };
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
