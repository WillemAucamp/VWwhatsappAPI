'use strict';

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const { createShortcutStore } = require('./shortcutStore');
const { createLabelStore } = require('./labelStore');
const { createChatReadStore } = require('./chatReadStore');
const {
  inferDeskLabelNames,
  syncInferredDeskLabels,
} = require('./deskAutoLabels');
const { waNumberMatchesQuery } = require('../../public/agent/deskListFilters');

function timingSafeEqualStr(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function sendStoreError(res, err) {
  const status = err && err.status ? err.status : 500;
  return res.status(status).json({ error: err.message || String(err) });
}

function publicLabels(labelIds, labelById) {
  return (labelIds || [])
    .map((id) => labelById.get(id))
    .filter(Boolean)
    .map((l) => ({ id: l.id, name: l.name, color: l.color }));
}

function withTimeout(promise, ms, fallback) {
  const wait = Number(ms);
  if (!promise || !(wait > 0)) return Promise.resolve(fallback);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), wait);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      }
    );
  });
}

/**
 * Attach funnel labels from the live session and/or transcript.
 * Inbox list must stay light: never scan full transcripts there (that timed
 * out on Render and made the desk look empty). Thread open may scan once;
 * empty scans are remembered for this process.
 */
function createAutoLabelSync({ labels, messageStore }) {
  const scannedEmpty = new Set();

  async function syncChat(
    waNumber,
    {
      session,
      messages,
      lastText,
      allowTranscriptScan = true,
      existingLabelIds,
    } = {}
  ) {
    const wa = String(waNumber || '').replace(/\D/g, '');
    if (!wa) return [];
    let hints = { session, messages, lastText };
    let inferred = inferDeskLabelNames(hints);
    if (
      !inferred.length &&
      messages == null &&
      allowTranscriptScan &&
      !scannedEmpty.has(wa) &&
      messageStore &&
      typeof messageStore.listMessages === 'function'
    ) {
      const loaded = await messageStore.listMessages(wa, { limit: 150 });
      hints = { session, messages: loaded, lastText };
      inferred = inferDeskLabelNames(hints);
      if (!inferred.length) scannedEmpty.add(wa);
    }
    if (!inferred.length) {
      if (Array.isArray(existingLabelIds)) return existingLabelIds;
      return labels.getChatLabelIds(wa);
    }
    scannedEmpty.delete(wa);
    await syncInferredDeskLabels(labels, wa, hints);
    return labels.getChatLabelIds(wa);
  }

  return { syncChat };
}

function createAgentRouter({
  engine,
  sessionStore,
  messageStore,
  shortcutStore,
  labelStore,
  chatReadStore,
  sendMessage,
} = {}) {
  const router = express.Router();
  const password = config.agent.deskPassword;
  const enabled = config.agent.deskEnabled && Boolean(password);
  const shortcuts = shortcutStore || createShortcutStore();
  const labels = labelStore || createLabelStore();
  const chatReads = chatReadStore || createChatReadStore();
  const autoLabels = createAutoLabelSync({ labels, messageStore });

  function requireAuth(req, res, next) {
    if (!enabled) {
      return res.status(503).json({
        error: 'agent_desk_disabled',
        message:
          'Set AGENT_DESK_ENABLED=true and AGENT_DESK_PASSWORD on the host',
      });
    }
    const header = req.get('authorization') || '';
    const bearer = header.toLowerCase().startsWith('bearer ')
      ? header.slice(7).trim()
      : '';
    const cookie = parseCookie(req.get('cookie') || '').agent_desk || '';
    const provided = bearer || cookie;
    if (!timingSafeEqualStr(provided, password)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    return next();
  }

  router.get('/', (_req, res) => {
    const file = path.join(__dirname, '../../public/agent/index.html');
    res.sendFile(file, (err) => {
      if (!err) return;
      // eslint-disable-next-line no-console
      console.error('[agent-desk] UI file missing:', file, err.message);
      if (!res.headersSent) {
        res
          .status(500)
          .type('text')
          .send(
            'Agent desk UI missing from server image. Dockerfile must COPY public ./public — then redeploy.'
          );
      }
    });
  });

  router.use(
    '/static',
    express.static(path.join(__dirname, '../../public/agent'))
  );

  router.get('/api/status', async (_req, res) => {
    const diagnostics = require('../webhook/diagnostics');
    const snap = diagnostics.snapshot();
    let chatCount = null;
    let chatListError = null;
    try {
      if (messageStore && typeof messageStore.countChats === 'function') {
        chatCount = await messageStore.countChats();
      } else if (messageStore && typeof messageStore.listChats === 'function') {
        const chats = await messageStore.listChats();
        chatCount = Array.isArray(chats) ? chats.length : null;
      }
    } catch (err) {
      chatListError = err && err.message ? err.message : String(err);
    }
    res.json({
      enabled,
      passwordConfigured: Boolean(password),
      transcriptPath: config.agent.transcriptPath,
      sessionStorePath: config.session.storePath,
      lastSendError: snap.lastSendError || null,
      webhookSignatureRejects: snap.postRejectedSignature || 0,
      chatCount,
      chatListError,
      inboxList: 'raw-list-2026-09-10',
      emergency: Boolean(config.agent.deskEmergency),
      transcriptAppendFailures: snap.transcriptAppendFailures || 0,
      lastTranscriptAppendError: snap.lastTranscriptAppendError || null,
      lastSkippedInboundType: snap.lastSkippedInboundType || null,
    });
  });

  router.post('/api/login', express.json(), (req, res) => {
    if (!enabled) {
      return res.status(503).json({ error: 'agent_desk_disabled' });
    }
    const bodyPassword = req.body && req.body.password;
    if (!timingSafeEqualStr(bodyPassword, password)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    res.setHeader(
      'Set-Cookie',
      `agent_desk=${encodeURIComponent(password)}; Path=/agent; HttpOnly; SameSite=Lax; Max-Age=86400${
        config.nodeEnv === 'production' ? '; Secure' : ''
      }`
    );
    return res.json({ ok: true });
  });

  router.post('/api/logout', (_req, res) => {
    res.setHeader(
      'Set-Cookie',
      'agent_desk=; Path=/agent; HttpOnly; SameSite=Lax; Max-Age=0'
    );
    res.json({ ok: true });
  });

  router.get('/api/stored/:wa', requireAuth, async (req, res) => {
    try {
      const wa = String(req.params.wa || '').replace(/\D/g, '');
      if (!wa) {
        return res.status(400).json({ error: 'wa_required', stored: false });
      }
      const messages = await messageStore.listMessages(wa, { limit: 1 });
      const last = messages && messages.length ? messages[messages.length - 1] : null;
      res.json({
        waNumber: last
          ? String(last.waNumber || wa).replace(/\D/g, '') || wa
          : wa,
        stored: Boolean(last),
        lastText: last ? last.text : null,
        lastAt: last ? last.at : null,
        lastDirection: last ? last.direction : null,
        lastSource: last ? last.source : null,
        messageCount: last ? 1 : 0,
      });
    } catch (err) {
      return sendStoreError(res, err);
    }
  });

  router.get('/api/chats', requireAuth, async (req, res) => {
    try {
      const emergency =
        Boolean(config.agent.deskEmergency) ||
        String((req.query && req.query.emergency) || '') === '1';
      const enrichMs = Number(config.agent.inboxEnrichMs) || 1500;
      const listMs = Number(config.agent.inboxListMs) || 8000;

      let readsMap = {};
      let forcedUnread = {};
      let labelBundle = { labels: [], chatLabels: {} };
      const sessionByWa = new Map();

      if (!emergency) {
        const [readState, labelsMap, sessions] = await Promise.all([
          withTimeout(
            typeof chatReads.getState === 'function'
              ? chatReads.getState()
              : chatReads.getAll().then((reads) => ({ reads, forcedUnread: {} })),
            enrichMs,
            null
          ),
          withTimeout(labels.getChatLabelsMap(), enrichMs, null),
          sessionStore && typeof sessionStore.listAll === 'function'
            ? withTimeout(sessionStore.listAll(), enrichMs, null)
            : Promise.resolve(null),
        ]);
        if (readState) {
          readsMap = readState.reads || readState;
          forcedUnread = readState.forcedUnread || {};
        }
        if (labelsMap && typeof labelsMap === 'object') {
          labelBundle = labelsMap;
        }
        if (Array.isArray(sessions)) {
          for (const session of sessions) {
            const wa = String((session && session.waNumber) || '').replace(/\D/g, '');
            if (wa) sessionByWa.set(wa, session);
          }
        }
      }

      const query = String((req.query && (req.query.q || req.query.search)) || '').trim();
      const searching = String(query).replace(/\D/g, '').length >= 4;

      let chats = await withTimeout(
        messageStore.listChats({ lastReadByWa: readsMap }),
        listMs,
        null
      );
      if (!Array.isArray(chats)) {
        chats = await withTimeout(messageStore.listChats(), listMs, []);
      }
      if (!Array.isArray(chats)) chats = [];
      if (searching) {
        chats = chats.filter((chat) =>
          waNumberMatchesQuery(chat.waNumber, query)
        );
      }

      const labelById = new Map((labelBundle.labels || []).map((l) => [l.id, l]));
      const enriched = chats.map((chat) => {
        const existingLabelIds = (labelBundle.chatLabels &&
          labelBundle.chatLabels[chat.waNumber]) || [];
        const session = sessionByWa.get(chat.waNumber) || null;
        let unreadCount = Number(chat.unreadCount) || 0;
        if (forcedUnread[chat.waNumber]) {
          unreadCount = Math.max(unreadCount, 1);
        }
        return {
          ...chat,
          unreadCount,
          forcedUnread: Boolean(forcedUnread[chat.waNumber]),
          status: session ? session.status : 'bot',
          currentState: session ? session.currentState : null,
          agentTakenOver: Boolean(session && session.agentTakenOver),
          labelIds: existingLabelIds,
          labels: publicLabels(existingLabelIds, labelById),
        };
      });
      res.json({
        chats: enriched,
        emergency,
        inbox: 'raw-list-2026-09-10',
        search: searching ? query : null,
      });
    } catch (err) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  router.post('/api/chats/:wa/unread', requireAuth, async (req, res) => {
    try {
      const wa = String(req.params.wa || '').replace(/\D/g, '');
      if (!wa) {
        return res.status(400).json({ error: 'wa_required' });
      }
      if (typeof chatReads.markUnread !== 'function') {
        return res.status(500).json({ error: 'mark_unread_unavailable' });
      }
      const marked = await chatReads.markUnread(wa);
      res.json({ ok: true, ...marked });
    } catch (err) {
      return sendStoreError(res, err);
    }
  });

  router.get('/api/chats/:wa', requireAuth, async (req, res) => {
    try {
      const wa = String(req.params.wa || '').replace(/\D/g, '');
      const [messages, session] = await Promise.all([
        messageStore.listMessages(wa),
        sessionStore.get(wa),
      ]);
      let labelIds = [];
      let allLabels = [];
      try {
        allLabels = await labels.listLabels();
        labelIds = await autoLabels.syncChat(wa, { session, messages });
      } catch (_) {
        try {
          labelIds = await labels.getChatLabelIds(wa);
        } catch {
          labelIds = [];
        }
        if (!allLabels.length) {
          try {
            allLabels = await labels.listLabels();
          } catch {
            allLabels = [];
          }
        }
      }
      // Opening a thread marks it read for the agent desk (bot path untouched).
      let lastReadAt = null;
      try {
        const marked = await chatReads.markRead(wa);
        lastReadAt = marked.lastReadAt;
      } catch (_) {
        lastReadAt = null;
      }
      const labelById = new Map(allLabels.map((l) => [l.id, l]));
      res.json({
        waNumber: wa,
        messages,
        lastReadAt,
        labelIds,
        labels: publicLabels(labelIds, labelById),
        session: session
          ? {
              status: session.status,
              currentState: session.currentState,
              agentTakenOver: Boolean(session.agentTakenOver),
              path: session.path || [],
              lastExitReason: session.lastExitReason || null,
              updatedAt: session.updatedAt || null,
            }
          : null,
      });
    } catch (err) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  router.get('/api/chats/:wa/messages/:id/media', requireAuth, async (req, res) => {
    try {
      const wa = String(req.params.wa || '').replace(/\D/g, '');
      const id = String(req.params.id || '');
      if (!wa || !id) {
        return res.status(400).json({ error: 'wa_and_id_required' });
      }
      if (!messageStore || typeof messageStore.readMedia !== 'function') {
        return res.status(501).json({ error: 'media_not_supported' });
      }
      const media = await messageStore.readMedia(wa, id);
      if (!media || !media.buffer) {
        return res.status(404).json({ error: 'media_not_found' });
      }
      const filename = String(media.filename || 'file').replace(/[/\\]/g, '_');
      res.setHeader('Content-Type', media.mimeType || 'application/octet-stream');
      res.setHeader(
        'Content-Disposition',
        (media.mediaKind === 'image' ? 'inline' : 'attachment') +
          '; filename="' +
          filename.replace(/"/g, '') +
          '"'
      );
      res.setHeader('Cache-Control', 'private, max-age=3600');
      return res.send(Buffer.from(media.buffer));
    } catch (err) {
      return sendStoreError(res, err);
    }
  });

  router.put('/api/chats/:wa/labels', requireAuth, express.json(), async (req, res) => {
    try {
      const wa = String(req.params.wa || '').replace(/\D/g, '');
      const labelIds = req.body && Array.isArray(req.body.labelIds)
        ? req.body.labelIds
        : [];
      const result = await labels.setChatLabels(wa, labelIds);
      const allLabels = await labels.listLabels();
      const labelById = new Map(allLabels.map((l) => [l.id, l]));
      res.json({
        ok: true,
        ...result,
        labels: result.labelIds
          .map((id) => labelById.get(id))
          .filter(Boolean)
          .map((l) => ({ id: l.id, name: l.name, color: l.color })),
      });
    } catch (err) {
      return sendStoreError(res, err);
    }
  });

  router.post('/api/chats/:wa/reply', requireAuth, async (req, res) => {
    try {
      const wa = String(req.params.wa || '').replace(/\D/g, '');
      const text = req.body && req.body.text != null ? String(req.body.text).trim() : '';
      if (!wa || !text) {
        return res.status(400).json({ error: 'wa_and_text_required' });
      }

      // Ensure chat is under agent control so the bot stays quiet.
      if (engine && typeof engine.takeOver === 'function') {
        await engine.takeOver(wa, { silent: true });
      }

      const result = await sendMessage(wa, {
        text,
        meta: { source: 'agent', stateId: null },
      });
      const wamid =
        result &&
        result.messages &&
        result.messages[0] &&
        result.messages[0].id
          ? result.messages[0].id
          : null;

      res.json({
        ok: true,
        message: {
          waNumber: wa,
          direction: 'out',
          source: 'agent',
          text,
          wamid,
          at: new Date().toISOString(),
        },
        graph: result,
      });
    } catch (err) {
      res.status(502).json({
        error: err.message || String(err),
        response: err.response || undefined,
      });
    }
  });

  // Paste-image sends from the desk (base64 JSON; keep text /reply unchanged).
  router.post(
    '/api/chats/:wa/reply-media',
    requireAuth,
    express.json({ limit: '24mb' }),
    async (req, res) => {
      try {
        const wa = String(req.params.wa || '').replace(/\D/g, '');
        const caption =
          req.body && req.body.caption != null
            ? String(req.body.caption).trim()
            : req.body && req.body.text != null
              ? String(req.body.text).trim()
              : '';
        const imageBase64 =
          req.body && req.body.imageBase64 != null
            ? String(req.body.imageBase64).replace(/^data:[^;]+;base64,/, '')
            : '';
        const mimeType =
          (req.body && (req.body.mimeType || req.body.mediaMimeType)) || 'image/png';
        const filename =
          (req.body && req.body.filename) || undefined;
        if (!wa || !imageBase64) {
          return res.status(400).json({ error: 'wa_and_image_required' });
        }

        let buffer;
        try {
          buffer = Buffer.from(imageBase64, 'base64');
        } catch (_) {
          return res.status(400).json({ error: 'invalid_image_base64' });
        }
        if (!buffer.length) {
          return res.status(400).json({ error: 'empty_image' });
        }

        if (engine && typeof engine.takeOver === 'function') {
          await engine.takeOver(wa, { silent: true });
        }

        const result = await sendMessage(wa, {
          type: 'image',
          mediaBuffer: buffer,
          mimeType,
          filename,
          text: caption,
          meta: { source: 'agent', stateId: null },
        });
        const wamid =
          result &&
          result.messages &&
          result.messages[0] &&
          result.messages[0].id
            ? result.messages[0].id
            : null;
        const text = caption || '[Image]';

        res.json({
          ok: true,
          message: {
            waNumber: wa,
            direction: 'out',
            source: 'agent',
            text,
            wamid,
            at: new Date().toISOString(),
          },
          graph: result,
        });
      } catch (err) {
        const status = err && err.status >= 400 && err.status < 600 ? err.status : 502;
        res.status(status).json({
          error: err.message || String(err),
          code: err.code || undefined,
          response: err.response || undefined,
        });
      }
    }
  );

  router.post('/api/chats/:wa/takeover', requireAuth, async (req, res) => {
    try {
      const wa = String(req.params.wa || '').replace(/\D/g, '');
      // Silent: staff takeover must not send any bot WhatsApp message.
      const result = await engine.takeOver(wa, { silent: true });
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  router.post('/api/chats/:wa/release', requireAuth, async (req, res) => {
    try {
      const wa = String(req.params.wa || '').replace(/\D/g, '');
      const result = await engine.releaseToBot(wa);
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  // —— Shortcuts (type "/" in composer) ——
  router.get('/api/shortcuts', requireAuth, async (_req, res) => {
    try {
      const list = await shortcuts.list();
      res.json({ shortcuts: list });
    } catch (err) {
      return sendStoreError(res, err);
    }
  });

  router.post('/api/shortcuts', requireAuth, express.json(), async (req, res) => {
    try {
      const row = await shortcuts.create({
        key: req.body && req.body.key,
        text: req.body && req.body.text,
      });
      res.status(201).json({ shortcut: row });
    } catch (err) {
      return sendStoreError(res, err);
    }
  });

  router.put('/api/shortcuts/:id', requireAuth, express.json(), async (req, res) => {
    try {
      const row = await shortcuts.update(req.params.id, {
        key: req.body && req.body.key,
        text: req.body && req.body.text,
      });
      res.json({ shortcut: row });
    } catch (err) {
      return sendStoreError(res, err);
    }
  });

  router.delete('/api/shortcuts/:id', requireAuth, async (req, res) => {
    try {
      await shortcuts.remove(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      return sendStoreError(res, err);
    }
  });

  // —— Labels ——
  router.get('/api/labels', requireAuth, async (_req, res) => {
    try {
      const list = await labels.listLabels();
      res.json({ labels: list, colors: labels.colors || [] });
    } catch (err) {
      return sendStoreError(res, err);
    }
  });

  router.post('/api/labels', requireAuth, express.json(), async (req, res) => {
    try {
      const row = await labels.createLabel({
        name: req.body && req.body.name,
        color: req.body && req.body.color,
      });
      res.status(201).json({ label: row });
    } catch (err) {
      return sendStoreError(res, err);
    }
  });

  router.put('/api/labels/:id', requireAuth, express.json(), async (req, res) => {
    try {
      const row = await labels.updateLabel(req.params.id, {
        name: req.body && req.body.name,
        color: req.body && req.body.color,
      });
      res.json({ label: row });
    } catch (err) {
      return sendStoreError(res, err);
    }
  });

  router.delete('/api/labels/:id', requireAuth, async (req, res) => {
    try {
      await labels.removeLabel(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      return sendStoreError(res, err);
    }
  });

  return router;
}

function parseCookie(header) {
  const out = {};
  String(header || '')
    .split(';')
    .forEach((part) => {
      const [k, ...rest] = part.trim().split('=');
      if (!k) return;
      out[k] = decodeURIComponent(rest.join('=') || '');
    });
  return out;
}

module.exports = { createAgentRouter };
