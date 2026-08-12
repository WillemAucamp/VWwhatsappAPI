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

  whatsapp: {
    token: process.env.WHATSAPP_TOKEN || '',
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
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

  logger: {
    type: (process.env.LEAD_LOGGER || 'console').toLowerCase(),
    path: process.env.LEAD_LOG_PATH || './data/logs/leads.jsonl',
  },
};

module.exports = config;
