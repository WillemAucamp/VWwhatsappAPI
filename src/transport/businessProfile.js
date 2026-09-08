'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');

/**
 * WhatsApp Cloud API business profile helpers (profile picture via Resumable Upload).
 * Docs: POST /{phone-number-id}/whatsapp_business_profile with profile_picture_handle.
 */

function requireCredentials() {
  const token = config.whatsapp.token;
  const phoneNumberId = config.whatsapp.phoneNumberId;
  if (!token || !phoneNumberId) {
    const err = new Error(
      'WhatsApp Cloud API credentials missing (WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID)'
    );
    err.code = 'WHATSAPP_CONFIG_MISSING';
    throw err;
  }
  return { token, phoneNumberId };
}

function graphUrl(resourcePath, query = {}) {
  const { graphBaseUrl, apiVersion } = config.whatsapp;
  const url = new URL(`${graphBaseUrl}/${apiVersion}/${resourcePath}`);
  for (const [key, value] of Object.entries(query)) {
    if (value != null && value !== '') url.searchParams.set(key, String(value));
  }
  return url;
}

async function parseJsonResponse(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const graph = (data && data.error) || {};
    const detail = [graph.message, graph.code != null ? `code ${graph.code}` : '']
      .filter(Boolean)
      .join(' · ');
    const err = new Error(
      `WhatsApp Graph failed: ${res.status}${detail ? ` (${detail})` : ''}`
    );
    err.status = res.status;
    err.code = graph.code;
    err.response = data;
    throw err;
  }
  return data;
}

/**
 * Start a Resumable Upload session and return the session id (upload:…).
 * @param {{fileName:string,fileLength:number,fileType?:string,appId?:string,token?:string}} opts
 */
async function createUploadSession(opts = {}) {
  const { token } = opts.token
    ? { token: opts.token }
    : requireCredentials();
  const appId = opts.appId || config.whatsapp.appId;
  if (!appId) {
    const err = new Error(
      'WHATSAPP_APP_ID missing — Meta App Dashboard → Settings → Basic → App ID'
    );
    err.code = 'WHATSAPP_APP_ID_MISSING';
    throw err;
  }
  const fileName = opts.fileName || 'profile.jpg';
  const fileLength = Number(opts.fileLength);
  const fileType = opts.fileType || 'image/jpeg';
  if (!Number.isFinite(fileLength) || fileLength <= 0) {
    const err = new Error('fileLength required');
    err.code = 'WHATSAPP_UPLOAD_INVALID';
    throw err;
  }

  const url = graphUrl(`${appId}/uploads`, {
    file_name: fileName,
    file_length: fileLength,
    file_type: fileType,
    access_token: token,
  });
  const res = await fetch(url, { method: 'POST' });
  const data = await parseJsonResponse(res);
  if (!data.id) {
    const err = new Error('Upload session response missing id');
    err.response = data;
    throw err;
  }
  return data;
}

/**
 * Upload binary bytes into an open session; returns { h: handle }.
 * @param {string} sessionId upload session id from createUploadSession
 * @param {Buffer} bytes
 * @param {{token?:string,fileOffset?:number}} [opts]
 */
async function uploadFileBytes(sessionId, bytes, opts = {}) {
  const { token } = opts.token
    ? { token: opts.token }
    : requireCredentials();
  const id = String(sessionId || '').replace(/^upload:/, '');
  if (!id) {
    const err = new Error('upload session id required');
    err.code = 'WHATSAPP_UPLOAD_INVALID';
    throw err;
  }
  const { graphBaseUrl, apiVersion } = config.whatsapp;
  const url = `${graphBaseUrl}/${apiVersion}/upload:${id}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `OAuth ${token}`,
      file_offset: String(opts.fileOffset || 0),
      'Content-Type': 'application/octet-stream',
    },
    body: bytes,
  });
  return parseJsonResponse(res);
}

/**
 * Apply a profile_picture_handle on the configured business phone number.
 * @param {string} handle
 * @param {{token?:string,phoneNumberId?:string}} [opts]
 */
async function updateBusinessProfilePicture(handle, opts = {}) {
  const creds = opts.token && opts.phoneNumberId
    ? { token: opts.token, phoneNumberId: opts.phoneNumberId }
    : requireCredentials();
  if (!handle) {
    const err = new Error('profile_picture_handle required');
    err.code = 'WHATSAPP_PROFILE_HANDLE_MISSING';
    throw err;
  }
  const url = graphUrl(`${creds.phoneNumberId}/whatsapp_business_profile`);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${creds.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      profile_picture_handle: handle,
    }),
  });
  return parseJsonResponse(res);
}

async function getBusinessProfile(opts = {}) {
  const creds = opts.token && opts.phoneNumberId
    ? { token: opts.token, phoneNumberId: opts.phoneNumberId }
    : requireCredentials();
  const fields =
    opts.fields ||
    'about,address,description,email,profile_picture_url,websites,vertical';
  const url = graphUrl(`${creds.phoneNumberId}/whatsapp_business_profile`, {
    fields,
  });
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${creds.token}` },
  });
  return parseJsonResponse(res);
}

/**
 * Upload a local JPEG/PNG and set it as the WhatsApp business profile picture.
 * @param {string} filePath
 * @param {{appId?:string,mimeType?:string}} [opts]
 */
async function setProfilePictureFromFile(filePath, opts = {}) {
  const resolved = path.resolve(filePath);
  const bytes = await fs.promises.readFile(resolved);
  const fileName = path.basename(resolved);
  const lower = fileName.toLowerCase();
  const mimeType =
    opts.mimeType ||
    (lower.endsWith('.png')
      ? 'image/png'
      : lower.endsWith('.jpg') || lower.endsWith('.jpeg')
        ? 'image/jpeg'
        : 'image/jpeg');

  const session = await createUploadSession({
    fileName,
    fileLength: bytes.length,
    fileType: mimeType,
    appId: opts.appId,
  });
  const uploaded = await uploadFileBytes(session.id, bytes);
  const handle = uploaded.h || uploaded.handle;
  if (!handle) {
    const err = new Error('Upload response missing profile picture handle');
    err.response = uploaded;
    throw err;
  }
  const updated = await updateBusinessProfilePicture(handle);
  return { session, uploaded, handle, updated };
}

function defaultProfilePicturePath() {
  return path.join(__dirname, '../../public/agent/profile.jpg');
}

module.exports = {
  createUploadSession,
  uploadFileBytes,
  updateBusinessProfilePicture,
  getBusinessProfile,
  setProfilePictureFromFile,
  defaultProfilePicturePath,
};
