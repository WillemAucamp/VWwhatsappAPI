'use strict';

const { Pool } = require('pg');

/**
 * Shared Postgres helpers for agent desk stores (transcripts, shortcuts, labels, reads).
 */

/**
 * Supabase passwords often include ! @ # etc. If those are left raw in the
 * URI, some hosts (Render env parsing / URL libraries) reject the string.
 * Re-encode only the password segment when needed.
 */
function encodePassword(password) {
  // encodeURIComponent leaves ! ' ( ) * unescaped; percent-encode those too.
  return encodeURIComponent(password).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function normalizeDatabaseUrl(connectionString) {
  const raw = String(connectionString || '').trim();
  if (!raw) return raw;
  const m = raw.match(/^(postgres(?:ql)?:\/\/)([^:/?@]+):([^@]+)@(.+)$/i);
  if (!m) return raw;
  const [, scheme, user, password, rest] = m;
  let decoded = password;
  try {
    decoded = decodeURIComponent(password);
  } catch {
    decoded = password;
  }
  return `${scheme}${user}:${encodePassword(decoded)}@${rest}`;
}

const pools = new Map();

function getSharedPool(connectionString) {
  const normalizedUrl = normalizeDatabaseUrl(connectionString);
  if (!normalizedUrl) {
    throw new Error('DATABASE_URL is required for MESSAGE_STORE=postgres');
  }
  const existing = pools.get(normalizedUrl);
  if (existing) return existing;

  const pool = new Pool({
    connectionString: normalizedUrl,
    ssl: normalizedUrl.includes('localhost')
      ? undefined
      : { rejectUnauthorized: false },
    max: 5,
    connectionTimeoutMillis: 15000,
  });
  pools.set(normalizedUrl, pool);
  return pool;
}

/**
 * Desk settings (shortcuts / labels / unread) must survive redeploys.
 * Prefer Postgres whenever DATABASE_URL is set — even if MESSAGE_STORE=file —
 * so staff edits are not wiped and reseeded with code defaults.
 */
function resolveDeskSettingsBackend(opts = {}) {
  const databaseUrl =
    opts.databaseUrl != null
      ? opts.databaseUrl
      : require('../config').agent.databaseUrl;
  if (opts.backend) {
    const backend =
      String(opts.backend).toLowerCase() === 'postgres' ? 'postgres' : 'file';
    return { backend, databaseUrl };
  }
  if (databaseUrl) {
    return { backend: 'postgres', databaseUrl };
  }
  return { backend: 'file', databaseUrl: '' };
}

/** Resolve file vs postgres the same way message transcripts do. */
function resolveAgentStoreBackend(opts = {}) {
  const databaseUrl =
    opts.databaseUrl != null
      ? opts.databaseUrl
      : require('../config').agent.databaseUrl;
  const configured =
    opts.backend ||
    require('../config').agent.messageStore ||
    (databaseUrl ? 'postgres' : 'file');
  return {
    backend: String(configured).toLowerCase() === 'postgres' ? 'postgres' : 'file',
    databaseUrl,
  };
}

module.exports = {
  encodePassword,
  normalizeDatabaseUrl,
  getSharedPool,
  resolveAgentStoreBackend,
  resolveDeskSettingsBackend,
};
