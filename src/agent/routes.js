'use strict';

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const { createShortcutStore } = require('./shortcutStore');
const { createLabelStore } = require('./labelStore');

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

function createAgentRouter({
  engine,
  sessionStore,
  messageStore,
  shortcutStore,
  labelStore,
  sendMessage,
} = {}) {
  const router = express.Router();
  const password = config.agent.deskPassword;
  const enabled = config.agent.deskEnabled && Boolean(password);
  const shortcuts = shortcutStore || createShortcutStore();
  const labels = labelStore || createLabelStore();

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
    res.sendFile(path.join(__dirname, '../../public/agent/index.html'));
  });

  router.get('/api/status', (_req, res) => {
    res.json({
      enabled,
      passwordConfigured: Boolean(password),
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

  router.get('/api/chats', requireAuth, async (_req, res) => {
    try {
      const [chats, labelBundle] = await Promise.all([
        messageStore.listChats(),
        labels.getChatLabelsMap(),
      ]);
      const labelById = new Map(
        (labelBundle.labels || []).map((l) => [l.id, l])
      );
      const enriched = [];
      for (const chat of chats) {
        const session = await sessionStore.get(chat.waNumber);
        const labelIds = labelBundle.chatLabels[chat.waNumber] || [];
        enriched.push({
          ...chat,
          status: session ? session.status : 'unknown',
          currentState: session ? session.currentState : null,
          agentTakenOver: Boolean(session && session.agentTakenOver),
          labelIds,
          labels: labelIds
            .map((id) => labelById.get(id))
            .filter(Boolean)
            .map((l) => ({ id: l.id, name: l.name, color: l.color })),
        });
      }
      res.json({ chats: enriched });
    } catch (err) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  router.get('/api/chats/:wa', requireAuth, async (req, res) => {
    try {
      const wa = String(req.params.wa || '').replace(/\D/g, '');
      const [messages, session, labelIds, allLabels] = await Promise.all([
        messageStore.listMessages(wa),
        sessionStore.get(wa),
        labels.getChatLabelIds(wa),
        labels.listLabels(),
      ]);
      const labelById = new Map(allLabels.map((l) => [l.id, l]));
      res.json({
        waNumber: wa,
        messages,
        labelIds,
        labels: labelIds
          .map((id) => labelById.get(id))
          .filter(Boolean)
          .map((l) => ({ id: l.id, name: l.name, color: l.color })),
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

  router.post('/api/chats/:wa/takeover', requireAuth, async (req, res) => {
    try {
      const wa = String(req.params.wa || '').replace(/\D/g, '');
      const result = await engine.takeOver(wa);
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
