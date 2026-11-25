
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../data');
const DATA_FILE = path.join(DATA_DIR, 'events.json');
const PAYMENTS_FILE = path.join(DATA_DIR, 'payments.json');
const CLIENT_PROFILES_FILE = path.join(DATA_DIR, 'clients.json');

async function readEvents() {
  await fs.mkdir(DATA_DIR, { recursive: true });

  try {
    return JSON.parse(await fs.readFile(DATA_FILE, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function writeEvents(events) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(DATA_FILE, JSON.stringify(events, null, 2));
}

async function readPayments() {
  await fs.mkdir(DATA_DIR, { recursive: true });

  try {
    return JSON.parse(await fs.readFile(PAYMENTS_FILE, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function writePayments(payments) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(PAYMENTS_FILE, JSON.stringify(payments, null, 2));
}

async function readClientProfiles() {
  await fs.mkdir(DATA_DIR, { recursive: true });

  try {
    return JSON.parse(await fs.readFile(CLIENT_PROFILES_FILE, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function writeClientProfiles(profiles) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(CLIENT_PROFILES_FILE, JSON.stringify(profiles, null, 2));
}

export async function getEvents(start, end) {
  const events = await readEvents();

  return events.filter(event =>
    !event.ownerId &&
    new Date(event.start) < new Date(end) &&
    new Date(event.end) > new Date(start)
  );
}

export async function getEvent(id) {
  const events = await readEvents();
  return events.find(event => !event.ownerId && event.id === id) || null;
}

export async function getPayments() {
  return (await readPayments()).sort((a, b) =>
    String(b.createdAt).localeCompare(String(a.createdAt))
  );
}

export async function createPayment(data) {
  const payments = await readPayments();
  const payment = {
    id: randomUUID(),
    ...data,
    createdAt: new Date().toISOString()
  };

  payments.push(payment);
  await writePayments(payments);
  return payment;
}

export async function getClientProfiles() {
  return readClientProfiles();
}

export async function saveClientProfile(email, data) {
  const profiles = await readClientProfiles();
  const normalizedEmail = email.toLowerCase();
  const index = profiles.findIndex(profile => profile.email.toLowerCase() === normalizedEmail);
  const previous = index < 0 ? null : profiles[index];
  const profile = {
    email: normalizedEmail,
    name: data.name,
    phone: data.phone,
    notes: data.notes,
    createdAt: previous?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  if (index < 0) profiles.push(profile);
  else profiles[index] = profile;
  await writeClientProfiles(profiles);
  return profile;
}

export async function createEvent(data) {
  const events = await readEvents();

  const event = {
    id: randomUUID(),
    title: data.title,
    clientEmail: data.clientEmail,
    ...(data.googleSyncPending ? { googleSyncPending: true } : {}),
    start: new Date(data.start).toISOString(),
    end: new Date(data.end).toISOString(),
    description: data.description || '',
    location: data.location || ''
  };

  events.push(event);
  await writeEvents(events);

  return event;
}

export async function updateEvent(id, data) {
  const events = await readEvents();
  const index = events.findIndex(event => !event.ownerId && event.id === id);

  if (index === -1) return null;

  const oldEvent = events[index];

  const updated = {
    ...oldEvent,
    ...data,
    start: data.start
      ? new Date(data.start).toISOString()
      : oldEvent.start,
    end: data.end
      ? new Date(data.end).toISOString()
      : oldEvent.end
  };

  events[index] = updated;
  await writeEvents(events);

  return updated;
}

export async function linkGoogleEvent(id, googleEventId) {
  const events = await readEvents();
  const index = events.findIndex(event => !event.ownerId && event.id === id);
  if (index < 0) return null;

  const updated = {
    ...events[index],
    googleEventId,
    googleSyncPending: false
  };
  events[index] = updated;
  await writeEvents(events);
  return updated;
}

export async function saveGoogleEvent(ownerId, event, clientEmail) {
  if (!ownerId || !event?.id) {
    throw new Error('Informazioni insufficienti per salvare l’appuntamento Google.');
  }

  const events = await readEvents();
  const index = events.findIndex(record =>
    record.ownerId === ownerId && record.googleEventId === event.id
  );
  const previous = index < 0 ? null : events[index];
  const attendeeEmail = event.attendees?.find(attendee =>
    !attendee.organizer && !attendee.self && attendee.email
  )?.email;
  const record = {
    id: previous?.id || randomUUID(),
    ownerId,
    googleEventId: event.id,
    title: event.summary || '',
    clientEmail: clientEmail || event.extendedProperties?.private?.clientEmail || attendeeEmail || '',
    start: event.start?.dateTime || event.start?.date,
    end: event.end?.dateTime || event.end?.date,
    description: event.description || '',
    location: event.location || ''
  };

  if (index < 0) events.push(record);
  else events[index] = record;
  await writeEvents(events);
  return record;
}

export async function deleteGoogleEvent(ownerId, googleEventId) {
  const events = await readEvents();
  const filtered = events.filter(record =>
    !(record.ownerId === ownerId && record.googleEventId === googleEventId)
  );

  if (filtered.length === events.length) return false;

  await writeEvents(filtered);
  return true;
}

export async function deleteEvent(id) {
  const events = await readEvents();
  const filtered = events.filter(event => event.ownerId || event.id !== id);

  if (filtered.length === events.length) return false;

  await writeEvents(filtered);
  return true;
}
