import { OAuth2Client } from 'google-auth-library';

const client = new OAuth2Client();
const issuer = 'https://cloud.google.com/iap';
let cachedPublicKeys;
let publicKeysExpiresAt = 0;
let publicKeysRequest;

async function getPublicKeys() {
  if (cachedPublicKeys && Date.now() < publicKeysExpiresAt) return cachedPublicKeys;
  if (publicKeysRequest) return publicKeysRequest;

  publicKeysRequest = client.getIapPublicKeys().then(({ pubkeys, res }) => {
    cachedPublicKeys = pubkeys;
    const cacheControl = typeof res.headers.get === 'function'
      ? res.headers.get('cache-control')
      : res.headers['cache-control'];
    const maxAge = /max-age=(\d+)/i.exec(String(cacheControl));
    const cacheDuration = maxAge ? Number(maxAge[1]) * 1000 : 5 * 60 * 1000;
    publicKeysExpiresAt = Date.now() + cacheDuration;
    return cachedPublicKeys;
  }).finally(() => {
    publicKeysRequest = null;
  });

  return publicKeysRequest;
}

export async function requireIap(req, res, next) {
  const assertion = req.get('x-goog-iap-jwt-assertion');
  const projectId = process.env.GOOGLE_CLOUD_PROJECT;
  const projectNumber = process.env.GCP_PROJECT_NUMBER;

  if (!assertion || !projectId || !projectNumber) {
    return res.status(401).json({ error: 'Autenticazione IAP richiesta.' });
  }

  const expectedAudience = `/projects/${projectNumber}/apps/${projectId}`;

  try {
    const keys = await getPublicKeys();
    const ticket = await client.verifySignedJwtWithCertsAsync(
      assertion,
      keys,
      expectedAudience,
      [issuer]
    );
    const payload = ticket.getPayload();

    if (typeof payload?.email !== 'string' || typeof payload?.sub !== 'string') {
      return res.status(401).json({ error: 'Identità IAP non valida.' });
    }

    const googleSubjectPrefix = 'accounts.google.com:';
    // Keep using the Google subject suffix for existing Datastore user keys.
    const storageId = payload.sub.startsWith(googleSubjectPrefix)
      ? payload.sub.slice(googleSubjectPrefix.length)
      : payload.sub;
    if (!storageId) {
      return res.status(401).json({ error: 'Identità IAP non valida.' });
    }

    req.user = {
      id: payload.sub,
      storageId,
      email: payload.email
    };

    next();
  } catch (error) {
    console.error('Verifica IAP non riuscita:', error.message);
    res.status(401).json({ error: 'Autenticazione IAP non riuscita.' });
  }
}
