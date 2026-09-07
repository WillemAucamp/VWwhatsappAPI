'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');

const LABEL_COLORS = [
  '#128c7e',
  '#027eb5',
  '#c4530a',
  '#b42318',
  '#6941c6',
  '#067647',
  '#363f72',
  '#b54708',
];

const DEFAULT_LABELS = [
  { id: 'lb_vip', name: 'VIP', color: '#128c7e' },
  { id: 'lb_followup', name: 'Follow-up', color: '#027eb5' },
  { id: 'lb_hot', name: 'Hot lead', color: '#c4530a' },
  { id: 'lb_complaint', name: 'Complaint', color: '#b42318' },
];

function normalizeName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').slice(0, 40);
}

function normalizeColor(color, fallback = LABEL_COLORS[0]) {
  const raw = String(color || '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw.toLowerCase();
  return fallback;
}

function createLabelStore(filePath = config.agent.labelsPath) {
  const file = path.resolve(filePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  async function readAll() {
    if (!fs.existsSync(file)) {
      const seeded = {
        labels: DEFAULT_LABELS.map((l) => ({
          ...l,
          updatedAt: new Date().toISOString(),
        })),
        chatLabels: {},
      };
      await writeAll(seeded);
      return seeded;
    }
    try {
      const raw = await fs.promises.readFile(file, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.labels)) {
        return { labels: [], chatLabels: {} };
      }
      return {
        labels: parsed.labels,
        chatLabels:
          parsed.chatLabels && typeof parsed.chatLabels === 'object'
            ? parsed.chatLabels
            : {},
      };
    } catch {
      return { labels: [], chatLabels: {} };
    }
  }

  async function writeAll(data) {
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    await fs.promises.rename(tmp, file);
  }

  async function listLabels() {
    const data = await readAll();
    return data.labels
      .slice()
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  async function createLabel({ name, color } = {}) {
    const labelName = normalizeName(name);
    if (!labelName) {
      const err = new Error('label_name_required');
      err.status = 400;
      throw err;
    }
    const data = await readAll();
    if (
      data.labels.some(
        (l) => l.name.toLowerCase() === labelName.toLowerCase()
      )
    ) {
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
    await writeAll(data);
    return row;
  }

  async function updateLabel(id, { name, color } = {}) {
    const data = await readAll();
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
    await writeAll(data);
    return row;
  }

  async function removeLabel(id) {
    const data = await readAll();
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
    await writeAll(data);
    return { ok: true };
  }

  async function getChatLabelIds(waNumber) {
    const wa = String(waNumber || '').replace(/\D/g, '');
    const data = await readAll();
    const known = new Set(data.labels.map((l) => l.id));
    return (data.chatLabels[wa] || []).filter((id) => known.has(id));
  }

  async function getChatLabelsMap() {
    const data = await readAll();
    const known = new Set(data.labels.map((l) => l.id));
    const out = {};
    for (const [wa, ids] of Object.entries(data.chatLabels || {})) {
      const clean = (ids || []).filter((id) => known.has(id));
      if (clean.length) out[wa] = clean;
    }
    return { labels: data.labels, chatLabels: out };
  }

  async function setChatLabels(waNumber, labelIds = []) {
    const wa = String(waNumber || '').replace(/\D/g, '');
    if (!wa) {
      const err = new Error('wa_required');
      err.status = 400;
      throw err;
    }
    const data = await readAll();
    const known = new Set(data.labels.map((l) => l.id));
    const unique = [];
    for (const id of Array.isArray(labelIds) ? labelIds : []) {
      const lid = String(id || '');
      if (!lid || !known.has(lid) || unique.includes(lid)) continue;
      unique.push(lid);
    }
    if (unique.length) data.chatLabels[wa] = unique;
    else delete data.chatLabels[wa];
    await writeAll(data);
    return { waNumber: wa, labelIds: unique };
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
  };
}

module.exports = {
  createLabelStore,
  LABEL_COLORS,
  DEFAULT_LABELS,
};
