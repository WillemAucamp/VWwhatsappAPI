'use strict';

const config = require('../config');
const copy = require('../content/copy');

function copyStatus() {
  const keys = Object.keys(copy);
  const blankKeys = keys.filter((key) => {
    const value = copy[key];
    return value == null || String(value).trim() === '';
  });
  return {
    total: keys.length,
    filled: keys.length - blankKeys.length,
    blank: blankKeys.length,
    blankKeys,
    greetingFilled: Boolean(copy.greeting_prompt && String(copy.greeting_prompt).trim()),
  };
}

/**
 * Local readiness snapshot — no Graph call, no secrets.
 * Used by /health, startup logs, and scripts/check-meta.js.
 */
function getMetaReadiness() {
  const w = config.whatsapp;
  const production = config.nodeEnv === 'production';
  const token = Boolean(w.token);
  const phoneNumberId = Boolean(w.phoneNumberId);
  const verifyTokenConfigured =
    Boolean(w.verifyToken) && w.verifyToken !== 'change-me-verify-token';
  const appSecret = Boolean(w.appSecret);
  const copyInfo = copyStatus();

  const missing = [];
  if (!token) missing.push('WHATSAPP_TOKEN');
  if (!phoneNumberId) missing.push('WHATSAPP_PHONE_NUMBER_ID');
  if (!verifyTokenConfigured) missing.push('WHATSAPP_VERIFY_TOKEN');
  if (production && !appSecret) missing.push('WHATSAPP_APP_SECRET');

  const warnings = [];
  if (!appSecret && !production) {
    warnings.push('WHATSAPP_APP_SECRET unset — webhook HMAC is off until production or secret is set');
  }
  if (!config.publicBaseUrl) {
    warnings.push('PUBLIC_BASE_URL unset — Meta cannot reach /webhook until this is a public https URL');
  }
  if (!copyInfo.greetingFilled || copyInfo.blank > 0) {
    warnings.push(
      `src/content/copy.js has ${copyInfo.blank} blank key(s) — empty WhatsApp bodies / incomplete menus`
    );
  }

  return {
    production,
    token,
    phoneNumberId,
    wabaId: Boolean(w.wabaId),
    verifyTokenConfigured,
    appSecret,
    publicBaseUrl: config.publicBaseUrl || null,
    webhookPath: '/webhook',
    webhookUrl: config.publicBaseUrl ? `${config.publicBaseUrl}/webhook` : null,
    canSend: token && phoneNumberId,
    canVerifyWebhook: verifyTokenConfigured,
    webhookSignatureRequired: appSecret || production,
    copy: copyInfo,
    missing,
    warnings,
    readyToPlugIn:
      missing.length === 0 &&
      Boolean(config.publicBaseUrl) &&
      copyInfo.greetingFilled &&
      copyInfo.blank === 0,
  };
}

function formatReadinessReport(readiness = getMetaReadiness()) {
  const lines = [
    `[meta] send: ${readiness.canSend ? 'yes' : 'NO'}  webhook-verify: ${
      readiness.canVerifyWebhook ? 'yes' : 'NO'
    }  hmac: ${readiness.webhookSignatureRequired ? 'required' : 'optional'}`,
    `[meta] copy: ${readiness.copy.filled}/${readiness.copy.total} keys filled`,
  ];
  if (readiness.webhookUrl) {
    lines.push(`[meta] webhook URL: ${readiness.webhookUrl}`);
  }
  for (const item of readiness.missing) {
    lines.push(`[meta] missing ${item}`);
  }
  for (const warning of readiness.warnings) {
    lines.push(`[meta] warn: ${warning}`);
  }
  return lines.join('\n');
}

module.exports = {
  getMetaReadiness,
  copyStatus,
  formatReadinessReport,
};
