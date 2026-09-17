'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const { getSharedPool, resolveDeskSettingsBackend } = require('./pg');

const DEFAULT_SHORTCUTS = [
  {
    id: 'sc_greeting',
    key: 'greeting',
    text: 'Hi! Thanks for messaging VW Melrose. How can I help you today?',
  },
  {
    id: 'sc_hours',
    key: 'hours',
    text: 'Our dealership hours are Mon–Fri 08:00–17:00 and Sat 08:00–13:00. We are closed on Sundays.',
  },
  {
    id: 'sc_callback',
    key: 'callback',
    text: 'Thanks — I will arrange a callback for you shortly. Please confirm the best number and time.',
  },
];

const META_SEEDED = 'shortcuts_seeded';

function normalizeKey(key) {
  return String(key || '')
    .trim()
    .replace(/^\/+/, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '');
}

/** Preserve internal blank lines; only normalise CRLF and trim ends. */
function normalizeShortcutText(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[^\S\n]+$/gm, '')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '')
    .trimEnd();
}

/**
 * Shortcuts saved via the old single-line input lost all newlines.
 * Re-insert breaks before section/bullet emojis and known closing lines.
 * Leaves already-multiline text untouched.
 */
function repairCollapsedShortcutText(text) {
  const raw = String(text || '');
  if (/\n/.test(raw)) return normalizeShortcutText(raw);
  if (!/[👉🏛️🏦📊🚗📋]/.test(raw)) return normalizeShortcutText(raw);

  const repaired = raw
    .replace(/\s+([🏛️🏦📊🚗])/gu, '\n$1')
    .replace(/\s+(👉)/gu, '\n$1')
    .replace(/\s+(Because of all these variables)/g, '\n$1')
    .replace(/\s+(What I can do is)/g, '\n$1');
  return normalizeShortcutText(repaired);
}

function stampedDefaults() {
  const now = new Date().toISOString();
  return DEFAULT_SHORTCUTS.map((s) => ({ ...s, updatedAt: now }));
}

function mapShortcutRow(row) {
  const text = repairCollapsedShortcutText(row.text);
  return {
    id: row.id,
    key: row.key,
    text,
    updatedAt:
      row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : row.updatedAt || String(row.updated_at || ''),
  };
}

function newShortcutId() {
  return `sc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function createFileShortcutStore(filePath = config.agent.shortcutsPath) {
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
      const seeded = {
        shortcuts: stampedDefaults(),
        meta: { [META_SEEDED]: true },
      };
      await writeAllUnlocked(seeded);
      return seeded;
    }
    try {
      const raw = await fs.promises.readFile(file, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.shortcuts)) {
        return { shortcuts: [], meta: { [META_SEEDED]: true } };
      }
      let changed = false;
      const now = new Date().toISOString();
      parsed.shortcuts = parsed.shortcuts.map((s) => {
        const nextText = repairCollapsedShortcutText(s && s.text);
        if (nextText === (s && s.text)) return s;
        changed = true;
        return { ...s, text: nextText, updatedAt: now };
      });
      const meta =
        parsed.meta && typeof parsed.meta === 'object' ? parsed.meta : {};
      if (!meta[META_SEEDED]) {
        meta[META_SEEDED] = true;
        changed = true;
      }
      parsed.meta = meta;
      if (changed) await writeAllUnlocked(parsed);
      return parsed;
    } catch {
      return { shortcuts: [], meta: { [META_SEEDED]: true } };
    }
  }

  async function writeAllUnlocked(data) {
    const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random()
      .toString(36)
      .slice(2, 8)}.tmp`;
    await fs.promises.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    await fs.promises.rename(tmp, file);
  }

  async function list() {
    return withLock(async () => {
      const data = await readAllUnlocked();
      return data.shortcuts
        .slice()
        .sort((a, b) => String(a.key).localeCompare(String(b.key)));
    });
  }

  async function create({ key, text } = {}) {
    return withLock(async () => {
      const normalized = normalizeKey(key);
      const body = normalizeShortcutText(text);
      if (!normalized) {
        const err = new Error('shortcut_key_required');
        err.status = 400;
        throw err;
      }
      if (!body) {
        const err = new Error('shortcut_text_required');
        err.status = 400;
        throw err;
      }
      const data = await readAllUnlocked();
      if (data.shortcuts.some((s) => s.key === normalized)) {
        const err = new Error('shortcut_key_exists');
        err.status = 409;
        throw err;
      }
      const row = {
        id: newShortcutId(),
        key: normalized,
        text: body,
        updatedAt: new Date().toISOString(),
      };
      data.shortcuts.push(row);
      data.meta = { ...(data.meta || {}), [META_SEEDED]: true };
      await writeAllUnlocked(data);
      return row;
    });
  }

  async function update(id, { key, text } = {}) {
    return withLock(async () => {
      const data = await readAllUnlocked();
      const idx = data.shortcuts.findIndex((s) => s.id === id);
      if (idx < 0) {
        const err = new Error('shortcut_not_found');
        err.status = 404;
        throw err;
      }
      const current = data.shortcuts[idx];
      const nextKey =
        key != null && String(key).trim() !== ''
          ? normalizeKey(key)
          : current.key;
      const nextText =
        text != null ? normalizeShortcutText(text) : current.text;
      if (!nextKey) {
        const err = new Error('shortcut_key_required');
        err.status = 400;
        throw err;
      }
      if (!nextText) {
        const err = new Error('shortcut_text_required');
        err.status = 400;
        throw err;
      }
      if (data.shortcuts.some((s, i) => i !== idx && s.key === nextKey)) {
        const err = new Error('shortcut_key_exists');
        err.status = 409;
        throw err;
      }
      const row = {
        ...current,
        key: nextKey,
        text: nextText,
        updatedAt: new Date().toISOString(),
      };
      data.shortcuts[idx] = row;
      await writeAllUnlocked(data);
      return row;
    });
  }

  async function remove(id) {
    return withLock(async () => {
      const data = await readAllUnlocked();
      const next = data.shortcuts.filter((s) => s.id !== id);
      if (next.length === data.shortcuts.length) {
        const err = new Error('shortcut_not_found');
        err.status = 404;
        throw err;
      }
      data.shortcuts = next;
      data.meta = { ...(data.meta || {}), [META_SEEDED]: true };
      await writeAllUnlocked(data);
      return { ok: true };
    });
  }

  return {
    list,
    create,
    update,
    remove,
    file,
    normalizeKey,
    backend: 'file',
  };
}

function createPostgresShortcutStore(connectionString, opts = {}) {
  if (!connectionString) {
    throw new Error('DATABASE_URL is required for the postgres shortcut store');
  }
  const pool = getSharedPool(connectionString);
  const fileFallback = path.resolve(opts.filePath || config.agent.shortcutsPath);
  let ready = null;
  let chain = Promise.resolve();

  function withLock(fn) {
    const run = chain.then(fn, fn);
    chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async function getMeta(key) {
    const { rows } = await pool.query(
      `SELECT value FROM agent_desk_meta WHERE key = $1`,
      [key]
    );
    return rows[0] ? rows[0].value : null;
  }

  async function setMeta(key, value) {
    await pool.query(
      `INSERT INTO agent_desk_meta (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, String(value)]
    );
  }

  async function insertRow(row) {
    await pool.query(
      `INSERT INTO agent_shortcuts (id, key, text, updated_at)
       VALUES ($1, $2, $3, $4::timestamptz)
       ON CONFLICT (id) DO NOTHING`,
      [row.id, row.key, row.text, row.updatedAt || new Date().toISOString()]
    );
  }

  async function importFromFileIfPresent() {
    if (!fs.existsSync(fileFallback)) return { found: false, imported: 0 };
    try {
      const parsed = JSON.parse(fs.readFileSync(fileFallback, 'utf8'));
      if (!parsed || !Array.isArray(parsed.shortcuts)) {
        return { found: false, imported: 0 };
      }
      let imported = 0;
      for (const raw of parsed.shortcuts) {
        const key = normalizeKey(raw && raw.key);
        const text = repairCollapsedShortcutText(raw && raw.text);
        if (!key || !text) continue;
        await insertRow({
          id: raw.id || newShortcutId(),
          key,
          text,
          updatedAt: raw.updatedAt || new Date().toISOString(),
        });
        imported += 1;
      }
      // File existed (even empty): honour staff deletes, never reseed defaults.
      return { found: true, imported };
    } catch {
      return { found: false, imported: 0 };
    }
  }

  async function seedIfNeeded() {
    const seeded = await getMeta(META_SEEDED);
    if (seeded === '1' || seeded === 'true') return;
    const { rows } = await pool.query(`SELECT id FROM agent_shortcuts LIMIT 1`);
    if (rows.length) {
      await setMeta(META_SEEDED, '1');
      return;
    }
    const fromFile = await importFromFileIfPresent();
    if (!fromFile.found) {
      for (const row of stampedDefaults()) {
        await insertRow(row);
      }
    }
    await setMeta(META_SEEDED, '1');
  }

  function ensureSchema() {
    if (!ready) {
      ready = (async () => {
        await pool.query(`
CREATE TABLE IF NOT EXISTS agent_desk_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`);
        await pool.query(`
CREATE TABLE IF NOT EXISTS agent_shortcuts (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  text TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`);
        await seedIfNeeded();
      })().catch((err) => {
        ready = null;
        throw err;
      });
    }
    return ready;
  }

  async function list() {
    return withLock(async () => {
      await ensureSchema();
      const { rows } = await pool.query(
        `SELECT id, key, text, updated_at FROM agent_shortcuts ORDER BY key ASC`
      );
      return rows.map(mapShortcutRow);
    });
  }

  async function create({ key, text } = {}) {
    return withLock(async () => {
      await ensureSchema();
      const normalized = normalizeKey(key);
      const body = normalizeShortcutText(text);
      if (!normalized) {
        const err = new Error('shortcut_key_required');
        err.status = 400;
        throw err;
      }
      if (!body) {
        const err = new Error('shortcut_text_required');
        err.status = 400;
        throw err;
      }
      const existing = await pool.query(`SELECT id FROM agent_shortcuts WHERE key = $1`, [
        normalized,
      ]);
      if (existing.rows.length) {
        const err = new Error('shortcut_key_exists');
        err.status = 409;
        throw err;
      }
      const row = {
        id: newShortcutId(),
        key: normalized,
        text: body,
        updatedAt: new Date().toISOString(),
      };
      await pool.query(
        `INSERT INTO agent_shortcuts (id, key, text, updated_at)
         VALUES ($1, $2, $3, $4::timestamptz)`,
        [row.id, row.key, row.text, row.updatedAt]
      );
      await setMeta(META_SEEDED, '1');
      return row;
    });
  }

  async function update(id, { key, text } = {}) {
    return withLock(async () => {
      await ensureSchema();
      const { rows } = await pool.query(
        `SELECT id, key, text, updated_at FROM agent_shortcuts WHERE id = $1`,
        [id]
      );
      if (!rows.length) {
        const err = new Error('shortcut_not_found');
        err.status = 404;
        throw err;
      }
      const current = mapShortcutRow(rows[0]);
      const nextKey =
        key != null && String(key).trim() !== ''
          ? normalizeKey(key)
          : current.key;
      const nextText =
        text != null ? normalizeShortcutText(text) : current.text;
      if (!nextKey) {
        const err = new Error('shortcut_key_required');
        err.status = 400;
        throw err;
      }
      if (!nextText) {
        const err = new Error('shortcut_text_required');
        err.status = 400;
        throw err;
      }
      const clash = await pool.query(
        `SELECT id FROM agent_shortcuts WHERE key = $1 AND id <> $2`,
        [nextKey, id]
      );
      if (clash.rows.length) {
        const err = new Error('shortcut_key_exists');
        err.status = 409;
        throw err;
      }
      const updatedAt = new Date().toISOString();
      await pool.query(
        `UPDATE agent_shortcuts
         SET key = $2, text = $3, updated_at = $4::timestamptz
         WHERE id = $1`,
        [id, nextKey, nextText, updatedAt]
      );
      return { id, key: nextKey, text: nextText, updatedAt };
    });
  }

  async function remove(id) {
    return withLock(async () => {
      await ensureSchema();
      const result = await pool.query(`DELETE FROM agent_shortcuts WHERE id = $1`, [
        id,
      ]);
      if (!result.rowCount) {
        const err = new Error('shortcut_not_found');
        err.status = 404;
        throw err;
      }
      await setMeta(META_SEEDED, '1');
      return { ok: true };
    });
  }

  return {
    list,
    create,
    update,
    remove,
    file: fileFallback,
    normalizeKey,
    backend: 'postgres',
  };
}

/**
 * @param {string|object} [options] File path (tests) or { backend, databaseUrl, filePath }
 */
function createShortcutStore(options) {
  if (typeof options === 'string') {
    return createFileShortcutStore(options);
  }
  const opts = options || {};
  const { backend, databaseUrl } = resolveDeskSettingsBackend(opts);
  if (backend === 'postgres') {
    return createPostgresShortcutStore(databaseUrl, opts);
  }
  return createFileShortcutStore(opts.filePath || config.agent.shortcutsPath);
}

module.exports = {
  createShortcutStore,
  createFileShortcutStore,
  createPostgresShortcutStore,
  normalizeKey,
  normalizeShortcutText,
  repairCollapsedShortcutText,
  DEFAULT_SHORTCUTS,
};
