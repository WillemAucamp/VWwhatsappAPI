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

function createShortcutStore(filePath = config.agent.shortcutsPath) {
  const file = path.resolve(filePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  async function readAll() {
    if (!fs.existsSync(file)) {
      const seeded = {
        shortcuts: DEFAULT_SHORTCUTS.map((s) => ({
          ...s,
          updatedAt: new Date().toISOString(),
        })),
      };
      await writeAll(seeded);
      return seeded;
    }
    try {
      const raw = await fs.promises.readFile(file, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.shortcuts)) {
        return { shortcuts: [] };
      }
      return parsed;
    } catch {
      return { shortcuts: [] };
    }
  }

  async function writeAll(data) {
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    await fs.promises.rename(tmp, file);
  }

  async function list() {
    const data = await readAll();
    return data.shortcuts
      .slice()
      .sort((a, b) => String(a.key).localeCompare(String(b.key)));
  }

  async function create({ key, text } = {}) {
    const normalized = normalizeKey(key);
    const body = String(text || '').trim();
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
    const data = await readAll();
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
    await writeAll(data);
    return row;
  }

  async function update(id, { key, text } = {}) {
    const data = await readAll();
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
      text != null ? String(text).trim() : current.text;
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
    await writeAll(data);
    return row;
  }

  async function remove(id) {
    const data = await readAll();
    const next = data.shortcuts.filter((s) => s.id !== id);
    if (next.length === data.shortcuts.length) {
      const err = new Error('shortcut_not_found');
      err.status = 404;
      throw err;
    }
    data.shortcuts = next;
    await writeAll(data);
    return { ok: true };
  }

  return { list, create, update, remove, file, normalizeKey };
}

module.exports = { createShortcutStore, normalizeKey, DEFAULT_SHORTCUTS };
