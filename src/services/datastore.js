import { Datastore } from '@google-cloud/datastore';
import { randomUUID } from 'node:crypto';

const projectId = process.env.GOOGLE_CLOUD_PROJECT;
export const datastore = new Datastore(projectId ? { projectId } : {});

const userKey = (googleId) => datastore.key(['CalendarUser', googleId]);
const metadataKey = (googleId, eventId) => datastore.key(['CalendarUser', googleId, 'EventMetadata', eventId]);
const paymentKey = (googleId, paymentId) => datastore.key(['CalendarUser', googleId, 'Payment', paymentId]);
const clientProfileKey = (googleId, email) => datastore.key(['CalendarUser', googleId, 'ClientProfile', email.toLowerCase()]);

export async function saveUser(googleId, profile, tokens) {
  const key = userKey(googleId);
  const [existing] = await datastore.get(key);
  const data = {
    googleId,
    email: profile.email ?? existing?.email ?? null,
    name: profile.name ?? existing?.name ?? null,
    picture: profile.picture ?? existing?.picture ?? null,
    updatedAt: new Date(),
  };
  // Keep a previously stored refresh token if Google omits it on subsequent logins.
  if (tokens.refresh_token) data.refreshToken = tokens.refresh_token;
  else if (existing?.refreshToken) data.refreshToken = existing.refreshToken;
  if (tokens.access_token) data.accessToken = tokens.access_token;
  if (tokens.expiry_date) data.tokenExpiry = new Date(tokens.expiry_date);
  await datastore.save({ key, data, excludeFromIndexes: ['refreshToken', 'accessToken'] });
  return data;
}

export async function getUser(googleId) {
  const [entity] = await datastore.get(userKey(googleId));
  return entity ?? null;
}

export async function saveEventMetadata(googleId, event) {
  const key = metadataKey(googleId, event.id);
  const [previous] = await datastore.get(key);
  await datastore.save({
    key,
    data: {
      googleEventId: event.id,
      title: event.summary ?? '',
      notes: event.description ?? '',
      location: event.location ?? '',
      status: event.status ?? 'confirmed',
      createdAt: previous?.createdAt ?? new Date(),
      updatedAt: new Date(),
    },
  });
}

export async function deleteEventMetadata(googleId, eventId) {
  await datastore.delete(metadataKey(googleId, eventId));
}

export async function getPayments(googleId) {
  const query = datastore.createQuery('Payment').hasAncestor(userKey(googleId));
  const [payments] = await datastore.runQuery(query);
  return payments.map(payment => ({
    ...payment,
    id: payment.id || payment[datastore.KEY]?.name || ''
  })).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export async function createPayment(googleId, data) {
  const id = randomUUID();
  const payment = {
    id,
    ...data,
    createdAt: new Date().toISOString()
  };
  await datastore.save({ key: paymentKey(googleId, id), data: payment });
  return payment;
}

export async function getClientProfiles(googleId) {
  const query = datastore.createQuery('ClientProfile').hasAncestor(userKey(googleId));
  const [profiles] = await datastore.runQuery(query);
  return profiles;
}

export async function saveClientProfile(googleId, email, data) {
  const key = clientProfileKey(googleId, email);
  const [previous] = await datastore.get(key);
  const profile = {
    email: email.toLowerCase(),
    name: data.name,
    phone: data.phone,
    notes: data.notes,
    createdAt: previous?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  await datastore.save({ key, data: profile });
  return profile;
}
