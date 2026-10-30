'use strict';

/**
 * In-memory webhook diagnostics for /health (no secrets).
 * Resets on process restart / Render redeploy.
 */
const stats = {
  postReceived: 0,
  postAccepted: 0,
  postRejectedSignature: 0,
  postRejectedNoSecret: 0,
  inboundExtracted: 0,
  inboundHandled: 0,
  inboundHandleErrors: 0,
  lastPostAt: null,
  lastAcceptedAt: null,
  lastRejectReason: null,
  lastInboundAt: null,
  lastInboundFrom: null,
  lastInboundType: null,
  lastError: null,
  lastSendError: null,
  lastCatalogError: null,
  lastCatalogMode: null,
  transcriptAppendFailures: 0,
  lastTranscriptAppendError: null,
  lastSkippedInboundType: null,
  /** @type {Array<{mode:string,error:string,at:string}>} */
  catalogAttempts: [],
};

function touchPost() {
  stats.postReceived += 1;
  stats.lastPostAt = new Date().toISOString();
}

function rejectSignature() {
  stats.postRejectedSignature += 1;
  stats.lastRejectReason = 'bad_signature';
}

function rejectNoSecret() {
  stats.postRejectedNoSecret += 1;
  stats.lastRejectReason = 'missing_app_secret';
}

function acceptPost() {
  stats.postAccepted += 1;
  stats.lastAcceptedAt = new Date().toISOString();
}

function recordInbound({ from, type }) {
  stats.inboundExtracted += 1;
  stats.lastInboundAt = new Date().toISOString();
  stats.lastInboundFrom = from ? String(from).replace(/\d(?=\d{4})/g, '*') : null;
  stats.lastInboundType = type || null;
}

function recordHandled() {
  stats.inboundHandled += 1;
}

function recordHandleError(err) {
  stats.inboundHandleErrors += 1;
  stats.lastError = err && err.message ? String(err.message).slice(0, 500) : String(err);
}

function recordSendError(err) {
  const msg = err && err.message ? String(err.message) : String(err);
  // Prefer the enriched message (already includes Graph code/hint); avoid
  // duplicating a huge raw JSON blob when the message already has detail.
  const alreadyDetailed = /code\s+\d+|WHATSAPP_TOKEN|expired/i.test(msg);
  const detail =
    !alreadyDetailed && err && err.response
      ? ` ${JSON.stringify(err.response).slice(0, 180)}`
      : '';
  stats.lastSendError = `${msg}${detail}`.slice(0, 500);
  stats.lastError = stats.lastSendError;
}

function recordTranscriptAppendError(err) {
  stats.transcriptAppendFailures += 1;
  stats.lastTranscriptAppendError = err && err.message
    ? String(err.message).slice(0, 500)
    : String(err);
  stats.lastError = stats.lastTranscriptAppendError;
}

function recordSkippedInboundType(type) {
  stats.lastSkippedInboundType = type ? String(type) : null;
}

function recordCatalogError(err, mode) {
  const msg = err && err.message ? String(err.message) : String(err);
  const responseDetail =
    err && err.response ? ` ${JSON.stringify(err.response).slice(0, 220)}` : '';
  const full = `${msg}${responseDetail}`.slice(0, 500);
  stats.lastCatalogError = full;
  stats.lastCatalogMode = mode || null;
  stats.catalogAttempts = Array.isArray(stats.catalogAttempts)
    ? stats.catalogAttempts.slice(-8)
    : [];
  stats.catalogAttempts.push({
    mode: mode || null,
    error: full,
    at: new Date().toISOString(),
  });
}

function snapshot() {
  return { ...stats };
}

module.exports = {
  touchPost,
  rejectSignature,
  rejectNoSecret,
  acceptPost,
  recordInbound,
  recordHandled,
  recordHandleError,
  recordSendError,
  recordTranscriptAppendError,
  recordSkippedInboundType,
  recordCatalogError,
  snapshot,
};
