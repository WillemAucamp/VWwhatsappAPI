'use strict';

require('dotenv').config();

function parseList(value, fallback) {
  const raw = value == null || value === '' ? fallback : value;
  return String(raw)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function intEnv(name, fallback) {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

const config = {
  port: intEnv('PORT', 3000),
  nodeEnv: process.env.NODE_ENV || 'development',
  // Prefer explicit PUBLIC_BASE_URL; on Render, RENDER_EXTERNAL_URL is injected.
  publicBaseUrl: (
    process.env.PUBLIC_BASE_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    ''
  ).replace(/\/$/, ''),

  whatsapp: {
    token: process.env.WHATSAPP_TOKEN || '',
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    wabaId: process.env.WHATSAPP_WABA_ID || '',
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || 'change-me-verify-token',
    appSecret: process.env.WHATSAPP_APP_SECRET || '',
    apiVersion: process.env.WHATSAPP_API_VERSION || 'v21.0',
    graphBaseUrl: process.env.WHATSAPP_GRAPH_BASE_URL || 'https://graph.facebook.com',
  },

  agent: {
    handoverNumber: process.env.AGENT_HANDOVER_NUMBER || '',
    notifyWebhookUrl: process.env.AGENT_NOTIFY_WEBHOOK_URL || '',
  },

  session: {
    ttlMs: intEnv('SESSION_TTL_MS', 24 * 60 * 60 * 1000),
    store: (process.env.SESSION_STORE || 'file').toLowerCase(),
    storePath: process.env.SESSION_STORE_PATH || './data/sessions',
    redisUrl: process.env.REDIS_URL || '',
  },

  fsm: {
    maxInvalidAttempts: intEnv('MAX_INVALID_ATTEMPTS', 1),
    helpIntentKeywords: parseList(
      process.env.HELP_INTENT_KEYWORDS,
      'help,agent,human,stop,opt out,optout'
    ),
    reopenKeywords: parseList(
      process.env.REOPEN_KEYWORDS,
      'restart,start,hello,hi'
    ),
  },

  links: {
    applicationLink: process.env.APPLICATION_LINK || '',
    stockLink: process.env.STOCK_LINK || '',
  },

  /**
   * No-reply follow-ups while waiting on an active (non-terminal) question.
   * First nudge after `firstDelayMs`, then every `intervalMs`, up to `maxCount`.
   */
  followUp: {
    enabled: String(process.env.FOLLOW_UP_ENABLED || 'true').toLowerCase() !== 'false',
    firstDelayMs: intEnv('FOLLOW_UP_FIRST_MS', 30 * 60 * 1000),
    intervalMs: intEnv('FOLLOW_UP_INTERVAL_MS', 4 * 60 * 60 * 1000),
    maxCount: intEnv('FOLLOW_UP_MAX', 3),
    pollMs: intEnv('FOLLOW_UP_POLL_MS', 60 * 1000),
    includePrompt:
      String(process.env.FOLLOW_UP_INCLUDE_PROMPT || 'true').toLowerCase() !== 'false',
    notifyAgentOnExhausted:
      String(process.env.FOLLOW_UP_NOTIFY_ON_EXHAUSTED || 'false').toLowerCase() ===
      'true',
  },

  logger: {
    type: (process.env.LEAD_LOGGER || 'console').toLowerCase(),
    path: process.env.LEAD_LOG_PATH || './data/logs/leads.jsonl',
  },
};

module.exports = config;
