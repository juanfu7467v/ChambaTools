import crypto from 'crypto';
import { Readable } from 'stream';
import { google } from 'googleapis';
import admin from './firebaseCompat.js';

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const IDENTITY_SCOPES = ['openid', 'email'];
const TOKEN_FIELD = 'googleDrive';
const TOKEN_ALGORITHM = 'aes-256-gcm';
const TOKEN_VERSION = 1;
const DRIVE_FOLDER_NAME = 'FacilitoTools';
const DRIVE_SUBFOLDER_NAME = 'Comprobantes';
const DRIVE_FOLDER_PATH = `${DRIVE_FOLDER_NAME}/${DRIVE_SUBFOLDER_NAME}`;

function getConfig() {
  return {
    clientId: process.env.GOOGLE_DRIVE_CLIENT_ID?.trim(),
    clientSecret: process.env.GOOGLE_DRIVE_CLIENT_SECRET?.trim(),
    redirectUri: process.env.GOOGLE_DRIVE_REDIRECT_URI?.trim()
      || `${(process.env.PUBLIC_APP_URL || process.env.HOST_URL || '').replace(/\/$/, '')}/api/google-drive/callback`,
    encryptionKey: process.env.GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY?.trim()
  };
}

export function isGoogleDriveConfigured() {
  const config = getConfig();
  return Boolean(config.clientId && config.clientSecret && config.redirectUri && config.encryptionKey);
}

function getOAuthClient() {
  const config = getConfig();
  if (!isGoogleDriveConfigured()) {
    throw new Error('Google Drive no está configurado en el servidor.');
  }
  return new google.auth.OAuth2(config.clientId, config.clientSecret, config.redirectUri);
}

function getEncryptionKey() {
  const raw = getConfig().encryptionKey;
  if (!raw) throw new Error('Falta GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY.');
  return crypto.createHash('sha256').update(raw).digest();
}

function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(TOKEN_ALGORITHM, getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [TOKEN_VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}

function decrypt(value) {
  const [version, ivText, tagText, dataText] = String(value || '').split('.');
  if (Number(version) !== TOKEN_VERSION || !ivText || !tagText || !dataText) throw new Error('Token de Google Drive inválido.');
  const decipher = crypto.createDecipheriv(TOKEN_ALGORITHM, getEncryptionKey(), Buffer.from(ivText, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(dataText, 'base64url')), decipher.final()]).toString('utf8');
}

function encodeUid(uid) {
  return Buffer.from(uid, 'utf8').toString('base64url');
}

function decodeUid(encodedUid) {
  return Buffer.from(encodedUid, 'base64url').toString('utf8');
}

async function findOrCreateFolder(drive, name, parentId = 'root') {
  const escapedName = name.replace(/'/g, "\\'");
  const response = await drive.files.list({
    q: `name = '${escapedName}' and mimeType = 'application/vnd.google-apps.folder' and '${parentId}' in parents and trashed = false`,
    spaces: 'drive',
    fields: 'files(id,name)',
    pageSize: 1
  });
  if (response.data.files?.[0]?.id) return response.data.files[0].id;
  const created = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId]
    },
    fields: 'id,name'
  });
  return created.data.id;
}

async function ensureComprobantesFolder(drive, stored = {}) {
  let folderId = stored.folderId;
  let subfolderId = stored.subfolderId;
  if (!folderId) folderId = await findOrCreateFolder(drive, DRIVE_FOLDER_NAME);
  if (!subfolderId) subfolderId = await findOrCreateFolder(drive, DRIVE_SUBFOLDER_NAME, folderId);
  return { folderId, subfolderId };
}

function signState(uid, issuedAt, nonce) {
  const payload = `${encodeUid(uid)}.${issuedAt}.${nonce}`;
  const signature = crypto.createHmac('sha256', getEncryptionKey()).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function getUidFromGoogleDriveState(state) {
  const [encodedUid] = String(state || '').split('.');
  if (!encodedUid) return null;
  try { return decodeUid(encodedUid); } catch (_) { return null; }
}

function verifyState(state, uid) {
  const [encodedUid, issuedAtText, nonce, signature, ...extra] = String(state || '').split('.');
  const issuedAt = Number(issuedAtText);
  if (!encodedUid || !issuedAtText || !nonce || !signature || extra.length || getUidFromGoogleDriveState(state) !== uid || !Number.isFinite(issuedAt)) return false;
  if (Date.now() - issuedAt > 10 * 60 * 1000) return false;
  const payload = `${encodedUid}.${issuedAtText}.${nonce}`;
  const expected = crypto.createHmac('sha256', getEncryptionKey()).update(payload).digest('base64url');
  const provided = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return provided.length === expectedBuffer.length && crypto.timingSafeEqual(provided, expectedBuffer);
}

export function buildGoogleDriveAuthorizationUrl(uid) {
  const oauth = getOAuthClient();
  const state = signState(uid, Date.now(), crypto.randomBytes(16).toString('hex'));
  return oauth.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [DRIVE_SCOPE, ...IDENTITY_SCOPES],
    state
  });
}

export async function completeGoogleDriveAuthorization(code, state, uid, db) {
  if (!verifyState(state, uid)) throw new Error('La autorización de Google Drive expiró o no es válida.');
  const oauth = getOAuthClient();
  const { tokens } = await oauth.getToken(code);
  if (!tokens.refresh_token) throw new Error('Google no entregó un refresh token. Vuelve a autorizar el acceso.');
  oauth.setCredentials(tokens);
  const oauth2 = google.oauth2({ version: 'v2', auth: oauth });
  const { data: profile } = await oauth2.userinfo.get();
  await db.collection('usuarios').doc(uid).set({
    [TOKEN_FIELD]: {
      refreshToken: encrypt(tokens.refresh_token),
      googleEmail: profile.email || null,
      connectedAt: admin.firestore.FieldValue.serverTimestamp(),
      scope: [DRIVE_SCOPE, ...IDENTITY_SCOPES].join(' ')
    }
  }, { merge: true });
}

export async function getGoogleDriveStatus(uid, db) {
  if (!isGoogleDriveConfigured()) return { configured: false, connected: false };
  const snap = await db.collection('usuarios').doc(uid).get();
  const data = snap.exists ? snap.data()?.[TOKEN_FIELD] : null;
  let googleEmail = data?.googleEmail || null;
  if (data?.refreshToken && !googleEmail) {
    try {
      const oauth = getOAuthClient();
      oauth.setCredentials({ refresh_token: decrypt(data.refreshToken) });
      const drive = google.drive({ version: 'v3', auth: oauth });
      const { data: about } = await drive.about.get({ fields: 'user(emailAddress)' });
      googleEmail = about.user?.emailAddress || null;
      if (googleEmail) {
        await db.collection('usuarios').doc(uid).set({ [TOKEN_FIELD]: { googleEmail } }, { merge: true });
      }
    } catch (_) {
      // Una autorización antigua puede no permitir consultar el correo; la conexión sigue válida.
    }
  }
  return {
    configured: true,
    connected: Boolean(data?.refreshToken),
    googleEmail,
    folderPath: DRIVE_FOLDER_PATH,
    folderReady: Boolean(data?.subfolderId),
    connectedAt: data?.connectedAt || null
  };
}

export async function disconnectGoogleDrive(uid, db) {
  await db.collection('usuarios').doc(uid).set({ [TOKEN_FIELD]: admin.firestore.FieldValue.delete() }, { merge: true });
}

export async function savePdfToGoogleDrive(uid, filename, pdfBuffer, db) {
  const snap = await db.collection('usuarios').doc(uid).get();
  const stored = snap.exists ? snap.data()?.[TOKEN_FIELD] : null;
  if (!stored?.refreshToken) return { connected: false, saved: false };

  const oauth = getOAuthClient();
  oauth.setCredentials({ refresh_token: decrypt(stored.refreshToken) });
  const drive = google.drive({ version: 'v3', auth: oauth });
  const folders = await ensureComprobantesFolder(drive, stored);
  if (folders.folderId !== stored.folderId || folders.subfolderId !== stored.subfolderId) {
    await db.collection('usuarios').doc(uid).set({ [TOKEN_FIELD]: folders }, { merge: true });
  }
  const response = await drive.files.create({
    requestBody: {
      name: filename,
      mimeType: 'application/pdf',
      parents: [folders.subfolderId]
    },
    media: { mimeType: 'application/pdf', body: Readable.from(pdfBuffer) },
    fields: 'id,name,webViewLink,createdTime,parents'
  });
  return { connected: true, saved: true, folderPath: DRIVE_FOLDER_PATH, file: response.data };
}
