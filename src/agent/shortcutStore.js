'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');

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

function createShortcutStore(filePath = config.agent.shortcutsPath) {
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
        shortcuts: DEFAULT_SHORTCUTS.map((s) => ({
          ...s,
          updatedAt: new Date().toISOString(),
        })),
      };
      await writeAllUnlocked(seeded);
      return seeded;
    }
    try {
      const raw = await fs.promises.readFile(file, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.shortcuts)) {
        return { shortcuts: [] };
      }
      let changed = false;
      const now = new Date().toISOString();
      parsed.shortcuts = parsed.shortcuts.map((s) => {
        const nextText = repairCollapsedShortcutText(s && s.text);
        if (nextText === (s && s.text)) return s;
        changed = true;
        return { ...s, text: nextText, updatedAt: now };
      });
      if (changed) {
        await writeAllUnlocked(parsed);
      }
      return parsed;
    } catch {
      return { shortcuts: [] };
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
        id: `sc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        key: normalized,
        text: body,
        updatedAt: new Date().toISOString(),
      };
      data.shortcuts.push(row);
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
      if (
        data.shortcuts.some((s, i) => i !== idx && s.key === nextKey)
      ) {
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
      await writeAllUnlocked(data);
      return { ok: true };
    });
  }

  return { list, create, update, remove, file, normalizeKey };
}

module.exports = {
  createShortcutStore,
  normalizeKey,
  normalizeShortcutText,
  repairCollapsedShortcutText,
  DEFAULT_SHORTCUTS,
};
