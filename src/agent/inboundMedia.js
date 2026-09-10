'use strict';

/**
 * Shared rules for inbound customer image/document media.
 */

const IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

const DOCUMENT_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
]);

const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

function normalizeMime(mimeType) {
  const mime = String(mimeType || '')
    .trim()
    .toLowerCase()
    .split(';')[0];
  if (mime === 'image/jpg') return 'image/jpeg';
  return mime;
}

function extensionForMime(mimeType) {
  const mime = normalizeMime(mimeType);
  switch (mime) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'application/pdf':
      return 'pdf';
    case 'application/msword':
      return 'doc';
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return 'docx';
    case 'application/vnd.ms-excel':
      return 'xls';
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
      return 'xlsx';
    case 'text/plain':
      return 'txt';
    default:
      return 'bin';
  }
}

function sanitizeFilename(name, mimeType) {
  const raw = String(name || '')
    .replace(/[/\\?%*:|"<>]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  if (raw) return raw;
  return `file.${extensionForMime(mimeType)}`;
}

function assertInboundMedia({ kind, mimeType, byteLength }) {
  const mime = normalizeMime(mimeType);
  const mediaKind = kind === 'document' ? 'document' : 'image';
  if (mediaKind === 'image') {
    if (!IMAGE_MIME_TYPES.has(mime)) {
      const err = new Error('Unsupported inbound image type');
      err.code = 'INBOUND_MEDIA_TYPE_UNSUPPORTED';
      err.status = 415;
      throw err;
    }
    if (!byteLength || byteLength > MAX_IMAGE_BYTES) {
      const err = new Error('Inbound image must be under 16MB');
      err.code = 'INBOUND_MEDIA_TOO_LARGE';
      err.status = 413;
      throw err;
    }
  } else {
    if (!DOCUMENT_MIME_TYPES.has(mime) && !IMAGE_MIME_TYPES.has(mime)) {
      const err = new Error('Unsupported inbound document type');
      err.code = 'INBOUND_MEDIA_TYPE_UNSUPPORTED';
      err.status = 415;
      throw err;
    }
    if (!byteLength || byteLength > MAX_DOCUMENT_BYTES) {
      const err = new Error('Inbound document must be under 20MB');
      err.code = 'INBOUND_MEDIA_TOO_LARGE';
      err.status = 413;
      throw err;
    }
  }
  return { mediaKind, mimeType: mime };
}

function placeholderText({ mediaKind, filename, caption }) {
  const cap = caption != null ? String(caption).trim() : '';
  if (mediaKind === 'image') {
    return cap || '[Image]';
  }
  const name = filename ? String(filename) : 'file';
  return cap ? `${cap}\n[Document: ${name}]` : `[Document: ${name}]`;
}

module.exports = {
  IMAGE_MIME_TYPES,
  DOCUMENT_MIME_TYPES,
  MAX_IMAGE_BYTES,
  MAX_DOCUMENT_BYTES,
  normalizeMime,
  extensionForMime,
  sanitizeFilename,
  assertInboundMedia,
  placeholderText,
};
