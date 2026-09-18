'use strict';

const { normalizeWa } = require('./chatMetaStore');

const BULK_ACTIONS = new Set([
  'mark_read',
  'mark_unread',
  'add_label',
  'remove_label',
  'archive',
  'delete',
  'clear',
]);

const UNDOABLE_ACTIONS = new Set([
  'delete',
  'archive',
  'clear',
  'remove_label',
]);

function normalizeChatIds(chatIds) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(chatIds) ? chatIds : []) {
    const wa = normalizeWa(raw);
    if (!wa || seen.has(wa)) continue;
    seen.add(wa);
    out.push(wa);
  }
  return out;
}

function badRequest(message, details) {
  const err = new Error(message);
  err.status = 400;
  if (details) err.details = details;
  return err;
}

function notFound(message) {
  const err = new Error(message);
  err.status = 404;
  return err;
}

/**
 * Run a bulk desk action against existing stores.
 * chatIds are WhatsApp numbers (desk chat keys), not UUIDs.
 */
async function executeBulkAction(
  {
    action,
    chatIds,
    payload = {},
    chatReads,
    labels,
    chatMeta,
    undoStore,
  } = {}
) {
  if (!BULK_ACTIONS.has(action)) {
    throw badRequest('Invalid action', `Unknown action: ${action}`);
  }
  const ids = normalizeChatIds(chatIds);
  if (!ids.length) {
    throw badRequest('Invalid action', 'chatIds required');
  }

  const metaMap =
    chatMeta && typeof chatMeta.getMap === 'function'
      ? await chatMeta.getMap()
      : {};
  for (const wa of ids) {
    const row = metaMap[wa];
    if (row && row.deletedAt) {
      throw notFound('Chat was deleted');
    }
  }

  let updatedCount = 0;
  let previous = null;
  const labelId =
    payload && payload.labelId != null ? String(payload.labelId) : '';

  if (action === 'mark_read') {
    const at = new Date().toISOString();
    for (const wa of ids) {
      await chatReads.markRead(wa, at);
      updatedCount += 1;
    }
  } else if (action === 'mark_unread') {
    for (const wa of ids) {
      await chatReads.markUnread(wa);
      updatedCount += 1;
    }
  } else if (action === 'add_label') {
    if (!labelId) throw badRequest('Invalid action', 'labelId required');
    const catalog = await labels.listLabels();
    const found = (catalog || []).find((l) => l.id === labelId);
    if (!found) throw notFound('Label not found');
    for (const wa of ids) {
      const current = await labels.getChatLabelIds(wa);
      if (current.includes(labelId)) {
        updatedCount += 1;
        continue;
      }
      await labels.setChatLabels(wa, current.concat(labelId));
      updatedCount += 1;
    }
  } else if (action === 'remove_label') {
    if (!labelId) throw badRequest('Invalid action', 'labelId required');
    const catalog = await labels.listLabels();
    const found = (catalog || []).find((l) => l.id === labelId);
    if (!found) throw notFound('Label not found');
    previous = { labelId, chatLabels: {} };
    for (const wa of ids) {
      const current = await labels.getChatLabelIds(wa);
      previous.chatLabels[wa] = current.slice();
      if (!current.includes(labelId)) {
        updatedCount += 1;
        continue;
      }
      await labels.setChatLabels(
        wa,
        current.filter((id) => id !== labelId)
      );
      updatedCount += 1;
    }
  } else if (action === 'archive') {
    await chatMeta.archiveMany(ids);
    updatedCount = ids.length;
  } else if (action === 'delete') {
    await chatMeta.softDeleteMany(ids);
    updatedCount = ids.length;
  } else if (action === 'clear') {
    previous = { cleared: {} };
    for (const wa of ids) {
      const row = metaMap[wa] || {};
      previous.cleared[wa] = row.clearedAt || null;
    }
    await chatMeta.clearMany(ids);
    updatedCount = ids.length;
  }

  let undoToken = null;
  if (UNDOABLE_ACTIONS.has(action) && undoStore) {
    const entry = undoStore.create({
      action,
      chatIds: ids,
      previous,
      labelId: labelId || undefined,
    });
    undoToken = entry.undoToken;
  }

  return {
    success: true,
    action,
    updatedCount,
    undoToken: undoToken || undefined,
    chatIds: ids,
  };
}

async function executeUndo({ undoToken, chatReads, labels, chatMeta, undoStore }) {
  if (!undoStore) {
    const err = new Error('Undo token expired or invalid');
    err.status = 410;
    throw err;
  }
  const entry = undoStore.consume(undoToken);
  if (!entry) {
    const err = new Error('Undo token expired or invalid');
    err.status = 410;
    throw err;
  }

  const ids = normalizeChatIds(entry.chatIds);
  let restoredCount = 0;

  if (entry.action === 'delete') {
    await chatMeta.undeleteMany(ids);
    restoredCount = ids.length;
  } else if (entry.action === 'archive') {
    await chatMeta.unarchiveMany(ids);
    restoredCount = ids.length;
  } else if (entry.action === 'clear') {
    const cleared = (entry.previous && entry.previous.cleared) || {};
    const entries = ids.map((wa) => ({
      waNumber: wa,
      clearedAt: Object.prototype.hasOwnProperty.call(cleared, wa)
        ? cleared[wa]
        : null,
    }));
    await chatMeta.unclearedMany(entries);
    restoredCount = ids.length;
  } else if (entry.action === 'remove_label') {
    const labelId =
      entry.labelId ||
      (entry.previous && entry.previous.labelId) ||
      '';
    const snap = (entry.previous && entry.previous.chatLabels) || {};
    for (const wa of ids) {
      const prior = snap[wa];
      if (Array.isArray(prior)) {
        await labels.setChatLabels(wa, prior);
      } else if (labelId) {
        const current = await labels.getChatLabelIds(wa);
        if (!current.includes(labelId)) {
          await labels.setChatLabels(wa, current.concat(labelId));
        }
      }
      restoredCount += 1;
    }
  } else {
    const err = new Error('Undo token expired or invalid');
    err.status = 410;
    throw err;
  }

  // chatReads unused today but kept for parity / future undo of read actions
  void chatReads;

  return {
    success: true,
    action: entry.action,
    restoredCount,
    chatIds: ids,
  };
}

module.exports = {
  BULK_ACTIONS,
  UNDOABLE_ACTIONS,
  normalizeChatIds,
  executeBulkAction,
  executeUndo,
};
