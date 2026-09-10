'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const { getSharedPool, resolveDeskSettingsBackend } = require('./pg');

const LABEL_COLORS = [
  '#128c7e',
  '#027eb5',
  '#c4530a',
  '#b42318',
  '#6941c6',
  '#067647',
  '#363f72',
  '#b54708',
  '#ca8a04', // yellow
];

const DEFAULT_LABELS = [
  { id: 'lb_vip', name: 'VIP', color: '#128c7e' },
  { id: 'lb_followup', name: 'Follow-up', color: '#027eb5' },
  { id: 'lb_hot', name: 'Hot lead', color: '#c4530a' },
  { id: 'lb_complaint', name: 'Complaint', color: '#b42318' },
];

const META_SEEDED = 'labels_seeded';

function normalizeName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').slice(0, 40);
}

function normalizeColor(color, fallback = LABEL_COLORS[0]) {
  const raw = String(color || '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw.toLowerCase();
  return fallback;
}

function mapLabelRow(row) {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    updatedAt:
      row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : row.updatedAt || String(row.updated_at || ''),
  };
}

function createFileLabelStore(filePath = config.agent.labelsPath) {
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
        labels: DEFAULT_LABELS.map((l) => ({
          ...l,
          updatedAt: new Date().toISOString(),
        })),
        chatLabels: {},
        meta: { [META_SEEDED]: true },
      };
      await writeAllUnlocked(seeded);
      return seeded;
    }
    try {
      const raw = await fs.promises.readFile(file, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.labels)) {
        return { labels: [], chatLabels: {}, meta: {} };
      }
      return {
        labels: parsed.labels,
        chatLabels:
          parsed.chatLabels && typeof parsed.chatLabels === 'object'
            ? parsed.chatLabels
            : {},
        meta: parsed.meta && typeof parsed.meta === 'object' ? parsed.meta : {},
      };
    } catch {
      return { labels: [], chatLabels: {}, meta: {} };
    }
  }

  async function writeAllUnlocked(data) {
    const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random()
      .toString(36)
      .slice(2, 8)}.tmp`;
    await fs.promises.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    await fs.promises.rename(tmp, file);
  }

  async function listLabels() {
    return withLock(async () => {
      const data = await readAllUnlocked();
      return data.labels
        .slice()
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    });
  }

  async function createLabel({ name, color } = {}) {
    return withLock(async () => {
      const labelName = normalizeName(name);
      if (!labelName) {
        const err = new Error('label_name_required');
        err.status = 400;
        throw err;
      }
      const data = await readAllUnlocked();
      const existingIdx = data.labels.findIndex(
        (l) => l.name.toLowerCase() === labelName.toLowerCase()
      );
      const now = new Date().toISOString();
      data.meta = data.meta || {};
      data.meta[META_SEEDED] = true;
      // Same name as a default (or prior) label → replace it permanently.
      if (existingIdx >= 0) {
        const current = data.labels[existingIdx];
        const row = {
          ...current,
          name: labelName,
          color: normalizeColor(color, current.color),
          updatedAt: now,
        };
        data.labels[existingIdx] = row;
        await writeAllUnlocked(data);
        return row;
      }
      const used = data.labels.length % LABEL_COLORS.length;
      const row = {
        id: `lb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        name: labelName,
        color: normalizeColor(color, LABEL_COLORS[used]),
        updatedAt: now,
      };
      data.labels.push(row);
      await writeAllUnlocked(data);
      return row;
    });
  }

  async function updateLabel(id, { name, color } = {}) {
    return withLock(async () => {
      const data = await readAllUnlocked();
      const idx = data.labels.findIndex((l) => l.id === id);
      if (idx < 0) {
        const err = new Error('label_not_found');
        err.status = 404;
        throw err;
      }
      const current = data.labels[idx];
      const nextName =
        name != null && String(name).trim() !== ''
          ? normalizeName(name)
          : current.name;
      if (!nextName) {
        const err = new Error('label_name_required');
        err.status = 400;
        throw err;
      }
      if (
        data.labels.some(
          (l, i) =>
            i !== idx && l.name.toLowerCase() === nextName.toLowerCase()
        )
      ) {
        const err = new Error('label_name_exists');
        err.status = 409;
        throw err;
      }
      const row = {
        ...current,
        name: nextName,
        color:
          color != null
            ? normalizeColor(color, current.color)
            : current.color,
        updatedAt: new Date().toISOString(),
      };
      data.labels[idx] = row;
      await writeAllUnlocked(data);
      return row;
    });
  }

  async function removeLabel(id) {
    return withLock(async () => {
      const data = await readAllUnlocked();
      const next = data.labels.filter((l) => l.id !== id);
      if (next.length === data.labels.length) {
        const err = new Error('label_not_found');
        err.status = 404;
        throw err;
      }
      data.labels = next;
      for (const wa of Object.keys(data.chatLabels)) {
        data.chatLabels[wa] = (data.chatLabels[wa] || []).filter(
          (lid) => lid !== id
        );
        if (!data.chatLabels[wa].length) delete data.chatLabels[wa];
      }
      data.meta = data.meta || {};
      data.meta[META_SEEDED] = true;
      await writeAllUnlocked(data);
      return { ok: true };
    });
  }

  async function getChatLabelIds(waNumber) {
    return withLock(async () => {
      const wa = String(waNumber || '').replace(/\D/g, '');
      const data = await readAllUnlocked();
      const known = new Set(data.labels.map((l) => l.id));
      return (data.chatLabels[wa] || []).filter((id) => known.has(id));
    });
  }

  async function getChatLabelsMap() {
    return withLock(async () => {
      const data = await readAllUnlocked();
      const known = new Set(data.labels.map((l) => l.id));
      const out = {};
      for (const [wa, ids] of Object.entries(data.chatLabels || {})) {
        const clean = (ids || []).filter((id) => known.has(id));
        if (clean.length) out[wa] = clean;
      }
      return { labels: data.labels, chatLabels: out };
    });
  }

  async function setChatLabels(waNumber, labelIds = []) {
    return withLock(async () => {
      const wa = String(waNumber || '').replace(/\D/g, '');
      if (!wa) {
        const err = new Error('wa_required');
        err.status = 400;
        throw err;
      }
      const data = await readAllUnlocked();
      const known = new Set(data.labels.map((l) => l.id));
      const unique = [];
      for (const id of Array.isArray(labelIds) ? labelIds : []) {
        const lid = String(id || '');
        if (!lid || !known.has(lid) || unique.includes(lid)) continue;
        unique.push(lid);
      }
      if (unique.length) data.chatLabels[wa] = unique;
      else delete data.chatLabels[wa];
      await writeAllUnlocked(data);
      return { waNumber: wa, labelIds: unique };
    });
  }

  return {
    listLabels,
    createLabel,
    updateLabel,
    removeLabel,
    getChatLabelIds,
    getChatLabelsMap,
    setChatLabels,
    file,
    colors: LABEL_COLORS.slice(),
    backend: 'file',
  };
}

function createPostgresLabelStore(connectionString, opts = {}) {
  if (!connectionString) {
    throw new Error('DATABASE_URL is required for MESSAGE_STORE=postgres');
  }
  const pool = getSharedPool(connectionString);
  const fileFallback = path.resolve(opts.filePath || config.agent.labelsPath);
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

  async function tryImportFromFile() {
    if (!fs.existsSync(fileFallback)) return null;
    try {
      const raw = await fs.promises.readFile(fileFallback, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.labels)) return null;
      return {
        labels: parsed.labels.map((l) => ({
          id: l.id || `lb_${Date.now().toString(36)}`,
          name: normalizeName(l.name),
          color: normalizeColor(l.color),
          updatedAt: l.updatedAt || new Date().toISOString(),
        })),
        chatLabels:
          parsed.chatLabels && typeof parsed.chatLabels === 'object'
            ? parsed.chatLabels
            : {},
      };
    } catch {
      return null;
    }
  }

  async function seedIfNeeded() {
    const seeded = await getMeta(META_SEEDED);
    if (seeded === '1' || seeded === 'true') return;

    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM agent_labels`
    );
    if (rows[0] && rows[0].n > 0) {
      await setMeta(META_SEEDED, '1');
      return;
    }

    const imported = await tryImportFromFile();
    const seedLabels =
      imported && imported.labels && imported.labels.length
        ? imported.labels
        : DEFAULT_LABELS.map((l) => ({
            ...l,
            updatedAt: new Date().toISOString(),
          }));

    for (const l of seedLabels) {
      await pool.query(
        `INSERT INTO agent_labels (id, name, color, updated_at)
         VALUES ($1, $2, $3, $4::timestamptz)
         ON CONFLICT (id) DO NOTHING`,
        [l.id, l.name, l.color, l.updatedAt]
      );
    }

    if (imported && imported.chatLabels) {
      for (const [wa, ids] of Object.entries(imported.chatLabels)) {
        for (const lid of ids || []) {
          await pool.query(
            `INSERT INTO agent_chat_labels (wa_number, label_id)
             VALUES ($1, $2)
             ON CONFLICT DO NOTHING`,
            [String(wa).replace(/\D/g, ''), lid]
          );
        }
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
CREATE TABLE IF NOT EXISTS agent_labels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`);
        await pool.query(`
CREATE TABLE IF NOT EXISTS agent_chat_labels (
  wa_number TEXT NOT NULL,
  label_id TEXT NOT NULL REFERENCES agent_labels(id) ON DELETE CASCADE,
  PRIMARY KEY (wa_number, label_id)
)`);
        await seedIfNeeded();
      })().catch((err) => {
        ready = null;
        throw err;
      });
    }
    return ready;
  }

  async function listLabels() {
    return withLock(async () => {
      await ensureSchema();
      const { rows } = await pool.query(
        `SELECT id, name, color, updated_at FROM agent_labels ORDER BY name ASC`
      );
      return rows.map(mapLabelRow);
    });
  }

  async function createLabel({ name, color } = {}) {
    return withLock(async () => {
      await ensureSchema();
      const labelName = normalizeName(name);
      if (!labelName) {
        const err = new Error('label_name_required');
        err.status = 400;
        throw err;
      }
      const existing = await pool.query(
        `SELECT id, name, color, updated_at FROM agent_labels WHERE lower(name) = lower($1)`,
        [labelName]
      );
      const updatedAt = new Date().toISOString();
      if (existing.rowCount) {
        const current = mapLabelRow(existing.rows[0]);
        const nextColor = normalizeColor(color, current.color);
        await pool.query(
          `UPDATE agent_labels
           SET name = $2, color = $3, updated_at = $4::timestamptz
           WHERE id = $1`,
          [current.id, labelName, nextColor, updatedAt]
        );
        await setMeta(META_SEEDED, '1');
        return {
          id: current.id,
          name: labelName,
          color: nextColor,
          updatedAt,
        };
      }
      const { rows: countRows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM agent_labels`
      );
      const used = (countRows[0] ? countRows[0].n : 0) % LABEL_COLORS.length;
      const row = {
        id: `lb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        name: labelName,
        color: normalizeColor(color, LABEL_COLORS[used]),
        updatedAt,
      };
      await pool.query(
        `INSERT INTO agent_labels (id, name, color, updated_at)
         VALUES ($1, $2, $3, $4::timestamptz)`,
        [row.id, row.name, row.color, row.updatedAt]
      );
      await setMeta(META_SEEDED, '1');
      return row;
    });
  }

  async function updateLabel(id, { name, color } = {}) {
    return withLock(async () => {
      await ensureSchema();
      const { rows } = await pool.query(
        `SELECT id, name, color, updated_at FROM agent_labels WHERE id = $1`,
        [id]
      );
      if (!rows.length) {
        const err = new Error('label_not_found');
        err.status = 404;
        throw err;
      }
      const current = mapLabelRow(rows[0]);
      const nextName =
        name != null && String(name).trim() !== ''
          ? normalizeName(name)
          : current.name;
      if (!nextName) {
        const err = new Error('label_name_required');
        err.status = 400;
        throw err;
      }
      const clash = await pool.query(
        `SELECT 1 FROM agent_labels WHERE lower(name) = lower($1) AND id <> $2`,
        [nextName, id]
      );
      if (clash.rowCount) {
        const err = new Error('label_name_exists');
        err.status = 409;
        throw err;
      }
      const nextColor =
        color != null ? normalizeColor(color, current.color) : current.color;
      const updatedAt = new Date().toISOString();
      await pool.query(
        `UPDATE agent_labels
         SET name = $2, color = $3, updated_at = $4::timestamptz
         WHERE id = $1`,
        [id, nextName, nextColor, updatedAt]
      );
      return { id, name: nextName, color: nextColor, updatedAt };
    });
  }

  async function removeLabel(id) {
    return withLock(async () => {
      await ensureSchema();
      const result = await pool.query(`DELETE FROM agent_labels WHERE id = $1`, [
        id,
      ]);
      if (!result.rowCount) {
        const err = new Error('label_not_found');
        err.status = 404;
        throw err;
      }
      await setMeta(META_SEEDED, '1');
      return { ok: true };
    });
  }

  async function getChatLabelIds(waNumber) {
    return withLock(async () => {
      await ensureSchema();
      const wa = String(waNumber || '').replace(/\D/g, '');
      const { rows } = await pool.query(
        `SELECT label_id FROM agent_chat_labels WHERE wa_number = $1`,
        [wa]
      );
      return rows.map((r) => r.label_id);
    });
  }

  async function getChatLabelsMap() {
    return withLock(async () => {
      await ensureSchema();
      const labels = await pool.query(
        `SELECT id, name, color, updated_at FROM agent_labels`
      );
      const chats = await pool.query(
        `SELECT wa_number, label_id FROM agent_chat_labels`
      );
      const out = {};
      for (const row of chats.rows) {
        if (!out[row.wa_number]) out[row.wa_number] = [];
        out[row.wa_number].push(row.label_id);
      }
      return {
        labels: labels.rows.map(mapLabelRow),
        chatLabels: out,
      };
    });
  }

  async function setChatLabels(waNumber, labelIds = []) {
    return withLock(async () => {
      await ensureSchema();
      const wa = String(waNumber || '').replace(/\D/g, '');
      if (!wa) {
        const err = new Error('wa_required');
        err.status = 400;
        throw err;
      }
      const known = await pool.query(`SELECT id FROM agent_labels`);
      const knownSet = new Set(known.rows.map((r) => r.id));
      const unique = [];
      for (const id of Array.isArray(labelIds) ? labelIds : []) {
        const lid = String(id || '');
        if (!lid || !knownSet.has(lid) || unique.includes(lid)) continue;
        unique.push(lid);
      }
      await pool.query(`DELETE FROM agent_chat_labels WHERE wa_number = $1`, [
        wa,
      ]);
      for (const lid of unique) {
        await pool.query(
          `INSERT INTO agent_chat_labels (wa_number, label_id) VALUES ($1, $2)`,
          [wa, lid]
        );
      }
      return { waNumber: wa, labelIds: unique };
    });
  }

  return {
    listLabels,
    createLabel,
    updateLabel,
    removeLabel,
    getChatLabelIds,
    getChatLabelsMap,
    setChatLabels,
    file: fileFallback,
    colors: LABEL_COLORS.slice(),
    backend: 'postgres',
  };
}

/**
 * @param {string|object} [options] File path (tests) or { backend, databaseUrl, filePath }
 */
function createLabelStore(options) {
  if (typeof options === 'string') {
    return createFileLabelStore(options);
  }
  const opts = options || {};
  const { backend, databaseUrl } = resolveDeskSettingsBackend(opts);
  if (backend === 'postgres') {
    return createPostgresLabelStore(databaseUrl, opts);
  }
  return createFileLabelStore(opts.filePath || config.agent.labelsPath);
}

module.exports = {
  createLabelStore,
  createFileLabelStore,
  createPostgresLabelStore,
  LABEL_COLORS,
  DEFAULT_LABELS,
};
