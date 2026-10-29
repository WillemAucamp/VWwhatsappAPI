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

/** Cemented desk labels. Seeded once; never rewritten unless the catalog is empty. */
const DEFAULT_LABELS = [
  { id: 'lb_pre_approved', name: 'Pre-approved', color: '#067647' },
  { id: 'lb_validated', name: 'Validated', color: '#6941c6' },
  { id: 'lb_app_link_sent', name: 'App-Link sent', color: '#027eb5' },
  { id: 'lb_no_license', name: 'No License', color: '#b54708' },
  { id: 'lb_bad_credit', name: 'Bad Credit', color: '#c4530a' },
  { id: 'lb_unqualified', name: 'Unqualified', color: '#ca8a04' },
];

const OLD_BUILTIN_NAMES = ['vip', 'follow up', 'hot lead', 'complaint'];

const META_SEEDED = 'labels_seeded';

function normalizeName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').slice(0, 40);
}

function foldName(name) {
  return normalizeName(name)
    .toLowerCase()
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function namesMatch(a, b) {
  return foldName(a) === foldName(b);
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

function isLegacyBuiltinCatalog(labels) {
  if (!labels || !labels.length) return false;
  return labels.every((l) => OLD_BUILTIN_NAMES.includes(foldName(l.name)));
}

function sortLabels(labels) {
  const rank = new Map(DEFAULT_LABELS.map((l, i) => [foldName(l.name), i]));
  return (labels || []).slice().sort((a, b) => {
    const ra = rank.has(foldName(a.name)) ? rank.get(foldName(a.name)) : 1000;
    const rb = rank.has(foldName(b.name)) ? rank.get(foldName(b.name)) : 1000;
    if (ra !== rb) return ra - rb;
    return String(a.name).localeCompare(String(b.name));
  });
}

function stampedDefaultLabels() {
  const now = new Date().toISOString();
  return DEFAULT_LABELS.map((l) => ({ ...l, updatedAt: now }));
}

/**
 * First boot only: swap the old VIP catalog, or add any missing cemented
 * names. Later boots leave staff edits (renames, deletes, extras) alone.
 */
function ensureCementedLabels(labels) {
  if (isLegacyBuiltinCatalog(labels)) {
    return { labels: stampedDefaultLabels(), changed: true, replaced: true };
  }
  const next = (labels || []).map((l) => ({ ...l }));
  let changed = false;
  const now = new Date().toISOString();
  for (const def of DEFAULT_LABELS) {
    const idx = next.findIndex((l) => namesMatch(l.name, def.name));
    if (idx < 0) {
      next.push({ ...def, updatedAt: now });
      changed = true;
    } else if (next[idx].name !== def.name) {
      next[idx] = { ...next[idx], name: def.name, updatedAt: now };
      changed = true;
    }
  }
  return { labels: next, changed, replaced: false };
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
        labels: stampedDefaultLabels(),
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
      let labels = parsed.labels;
      let chatLabels =
        parsed.chatLabels && typeof parsed.chatLabels === 'object'
          ? parsed.chatLabels
          : {};
      const meta =
        parsed.meta && typeof parsed.meta === 'object' ? parsed.meta : {};
      if (isLegacyBuiltinCatalog(labels) || !meta[META_SEEDED]) {
        const ensured = ensureCementedLabels(labels);
        labels = ensured.labels;
        if (ensured.replaced) chatLabels = {};
        const nextMeta = { ...meta, [META_SEEDED]: true };
        await writeAllUnlocked({
          labels,
          chatLabels,
          meta: nextMeta,
        });
        return { labels, chatLabels, meta: nextMeta };
      }
      return { labels, chatLabels, meta };
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
      return sortLabels(data.labels);
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
      if (data.labels.some((l) => namesMatch(l.name, labelName))) {
        const err = new Error('label_name_exists');
        err.status = 409;
        throw err;
      }
      const used = data.labels.length % LABEL_COLORS.length;
      const row = {
        id: `lb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        name: labelName,
        color: normalizeColor(color, LABEL_COLORS[used]),
        updatedAt: new Date().toISOString(),
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
          (l, i) => i !== idx && namesMatch(l.name, nextName)
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

  async function addChatLabelByName(waNumber, name) {
    return withLock(async () => {
      const wa = String(waNumber || '').replace(/\D/g, '');
      const want = normalizeName(name);
      if (!wa || !want) {
        return { applied: false, reason: 'invalid' };
      }
      const data = await readAllUnlocked();
      const label = data.labels.find((l) => namesMatch(l.name, want));
      if (!label) {
        return { applied: false, reason: 'label_not_found', name: want };
      }
      const known = new Set(data.labels.map((l) => l.id));
      const current = (data.chatLabels[wa] || []).filter((id) => known.has(id));
      if (current.includes(label.id)) {
        return {
          applied: false,
          reason: 'already_set',
          waNumber: wa,
          labelIds: current,
          label,
        };
      }
      const labelIds = current.concat(label.id);
      data.chatLabels[wa] = labelIds;
      await writeAllUnlocked(data);
      return { applied: true, waNumber: wa, labelIds, label };
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
    addChatLabelByName,
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

  async function insertDefaultLabels() {
    const now = new Date().toISOString();
    for (const l of DEFAULT_LABELS) {
      await pool.query(
        `INSERT INTO agent_labels (id, name, color, updated_at)
         VALUES ($1, $2, $3, $4::timestamptz)
         ON CONFLICT (id) DO NOTHING`,
        [l.id, l.name, l.color, now]
      );
    }
  }

  async function seedIfNeeded() {
    const seeded = await getMeta(META_SEEDED);
    const alreadySeeded = seeded === '1' || seeded === 'true';
    const { rows } = await pool.query(
      `SELECT id, name, color, updated_at FROM agent_labels`
    );
    if (isLegacyBuiltinCatalog(rows.map(mapLabelRow))) {
      await pool.query(`DELETE FROM agent_chat_labels`);
      await pool.query(`DELETE FROM agent_labels`);
      await insertDefaultLabels();
      await setMeta(META_SEEDED, '1');
      return;
    }
    if (alreadySeeded) return;
    if (!rows.length) {
      await insertDefaultLabels();
      await setMeta(META_SEEDED, '1');
      return;
    }
    const now = new Date().toISOString();
    for (const def of DEFAULT_LABELS) {
      const match = rows.find((r) => namesMatch(r.name, def.name));
      if (!match) {
        await pool.query(
          `INSERT INTO agent_labels (id, name, color, updated_at)
           VALUES ($1, $2, $3, $4::timestamptz)
           ON CONFLICT (id) DO NOTHING`,
          [def.id, def.name, def.color, now]
        );
      } else if (match.name !== def.name) {
        await pool.query(
          `UPDATE agent_labels SET name = $2, updated_at = $3::timestamptz WHERE id = $1`,
          [match.id, def.name, now]
        );
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
        `SELECT id, name, color, updated_at FROM agent_labels`
      );
      return sortLabels(rows.map(mapLabelRow));
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
      const existing = await pool.query(`SELECT id, name FROM agent_labels`);
      if (existing.rows.some((r) => namesMatch(r.name, labelName))) {
        const err = new Error('label_name_exists');
        err.status = 409;
        throw err;
      }
      const { rows: countRows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM agent_labels`
      );
      const used = (countRows[0] ? countRows[0].n : 0) % LABEL_COLORS.length;
      const row = {
        id: `lb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        name: labelName,
        color: normalizeColor(color, LABEL_COLORS[used]),
        updatedAt: new Date().toISOString(),
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
      const all = await pool.query(`SELECT id, name FROM agent_labels`);
      if (all.rows.some((r) => r.id !== id && namesMatch(r.name, nextName))) {
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

  async function addChatLabelByName(waNumber, name) {
    return withLock(async () => {
      await ensureSchema();
      const wa = String(waNumber || '').replace(/\D/g, '');
      const want = normalizeName(name);
      if (!wa || !want) {
        return { applied: false, reason: 'invalid' };
      }
      const { rows } = await pool.query(
        `SELECT id, name, color, updated_at FROM agent_labels`
      );
      const label = rows.map(mapLabelRow).find((l) => namesMatch(l.name, want));
      if (!label) {
        return { applied: false, reason: 'label_not_found', name: want };
      }
      const current = await pool.query(
        `SELECT label_id FROM agent_chat_labels WHERE wa_number = $1`,
        [wa]
      );
      const ids = current.rows.map((r) => r.label_id);
      if (ids.includes(label.id)) {
        return {
          applied: false,
          reason: 'already_set',
          waNumber: wa,
          labelIds: ids,
          label,
        };
      }
      await pool.query(
        `INSERT INTO agent_chat_labels (wa_number, label_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [wa, label.id]
      );
      return {
        applied: true,
        waNumber: wa,
        labelIds: ids.concat(label.id),
        label,
      };
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
    addChatLabelByName,
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
