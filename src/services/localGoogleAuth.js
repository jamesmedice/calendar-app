import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../data');
const DATA_FILE = path.join(DATA_DIR, 'google-auth.json');

function encryptionKey() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('SESSION_SECRET deve contenere almeno 32 caratteri per proteggere il token Google.');
  }
  return createHash('sha256').update(secret).digest();
}

function encrypt(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: encrypted.toString('base64')
  };
}

function decrypt(value) {
  const decipher = createDecipheriv(
    'aes-256-gcm',
    encryptionKey(),
    Buffer.from(value.iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(value.authTag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext, 'base64')),
    decipher.final()
  ]).toString('utf8');
}

async function readUsers() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    return JSON.parse(await fs.readFile(DATA_FILE, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

export async function saveLocalGoogleUser(googleId, profile, tokens) {
  if (!googleId) throw new Error('Google non ha restituito un identificativo dell’account.');

  const users = await readUsers();
  const previous = users[googleId];
  const encryptedRefreshToken = tokens.refresh_token
    ? encrypt(tokens.refresh_token)
    : previous?.encryptedRefreshToken;

  if (!encryptedRefreshToken) {
    throw new Error('Google non ha restituito un token di aggiornamento. Esci e autorizza di nuovo l’account.');
  }

  users[googleId] = {
    googleId,
    email: profile.email || previous?.email || null,
    name: profile.name || previous?.name || null,
    picture: profile.picture || previous?.picture || null,
    encryptedRefreshToken,
    updatedAt: new Date().toISOString()
  };
  users.activeGoogleId = googleId;

  await fs.writeFile(DATA_FILE, JSON.stringify(users, null, 2), { mode: 0o600 });
  return getLocalGoogleUser(googleId);
}

export async function getLocalGoogleUser(googleId) {
  const users = await readUsers();
  const availableIds = Object.keys(users).filter(id =>
    id !== 'activeGoogleId' && users[id]?.encryptedRefreshToken
  );
  const selectedId = googleId ||
    (users.activeGoogleId && users[users.activeGoogleId] ? users.activeGoogleId : null) ||
    (availableIds.length === 1 ? availableIds[0] : null);
  const user = selectedId ? users[selectedId] : null;
  if (!user?.encryptedRefreshToken) return null;

  return {
    googleId: user.googleId,
    email: user.email,
    name: user.name,
    picture: user.picture,
    refreshToken: decrypt(user.encryptedRefreshToken)
  };
}
