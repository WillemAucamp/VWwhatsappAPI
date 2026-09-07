'use strict';

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');

function timingSafeEqualStr(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function createAgentRouter({
  engine,
  sessionStore,
  messageStore,
  sendMessage,
} = {}) {
  const router = express.Router();
  const password = config.agent.deskPassword;
  const enabled = config.agent.deskEnabled && Boolean(password);

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
      const chats = await messageStore.listChats();
      const enriched = [];
      for (const chat of chats) {
        const session = await sessionStore.get(chat.waNumber);
        enriched.push({
          ...chat,
          status: session ? session.status : 'unknown',
          currentState: session ? session.currentState : null,
          agentTakenOver: Boolean(session && session.agentTakenOver),
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
      const [messages, session] = await Promise.all([
        messageStore.listMessages(wa),
        sessionStore.get(wa),
      ]);
      res.json({
        waNumber: wa,
        messages,
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
