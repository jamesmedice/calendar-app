import { Router } from 'express';
import { getClientProfiles, getPayments, saveClientProfile } from '../services/datastore.js';
import * as localStorage from '../services/localStorage.js';

const router = Router();
const LOCAL = process.env.APP_MODE !== 'google';
const asyncRoute = fn => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const cleanText = (value, max) =>
  typeof value === 'string' ? value.trim().slice(0, max) : '';
const validEmail = email =>
  /^[^\s@/\\]+@[^\s@/\\]+\.[^\s@/\\]+$/.test(email) && email.length <= 254;

async function loadClients(req) {
  const [profiles, payments] = LOCAL
    ? await Promise.all([localStorage.getClientProfiles(), localStorage.getPayments()])
    : await Promise.all([
      getClientProfiles(req.user.storageId),
      getPayments(req.user.storageId)
    ]);

  const clients = new Map();
  profiles.forEach(profile => {
    clients.set(profile.email.toLowerCase(), {
      ...profile,
      paymentCount: 0,
      bookingIds: new Set()
    });
  });
  payments.forEach(payment => {
    const email = String(payment.clientEmail || '').trim().toLowerCase();
    if (!email) return;
    const client = clients.get(email) || {
      email,
      name: '',
      phone: '',
      notes: '',
      paymentCount: 0,
      bookingIds: new Set()
    };
    client.paymentCount += 1;
    if (payment.eventId) client.bookingIds.add(payment.eventId);
    clients.set(email, client);
  });

  return { clients: [...clients.values()]
    .map(({ bookingIds, ...client }) => ({ ...client, bookingCount: bookingIds.size }))
    .sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email)), payments };
}

router.get('/', asyncRoute(async (req, res) => {
  const { clients } = await loadClients(req);
  res.json(clients);
}));

router.get('/:email', asyncRoute(async (req, res) => {
  const email = cleanText(req.params.email, 254).toLowerCase();
  if (!validEmail(email)) return res.status(400).json({ error: 'Inserisci un indirizzo email cliente valido.' });

  const { clients, payments } = await loadClients(req);
  const profile = clients.find(client => client.email.toLowerCase() === email);
  const clientPayments = payments
    .filter(payment => String(payment.clientEmail || '').trim().toLowerCase() === email)
    .sort((a, b) => String(b.examDate).localeCompare(String(a.examDate)));

  if (!profile) return res.status(404).json({ error: 'Scheda cliente non trovata.' });

  const bookings = new Map();
  clientPayments.forEach(payment => {
    if (!payment.eventId) return;
    const existing = bookings.get(payment.eventId);
    if (existing) {
      existing.paymentCount += 1;
    } else {
      bookings.set(payment.eventId, {
        eventId: payment.eventId,
        title: payment.eventTitle || 'Calendar booking',
        start: payment.examDate,
        paymentCount: 1
      });
    }
  });

  res.json({
    profile: {
      email: profile.email,
      name: profile.name || '',
      phone: profile.phone || '',
      notes: profile.notes || '',
      paymentCount: clientPayments.length,
      bookingCount: bookings.size
    },
    payments: clientPayments,
    bookings: [...bookings.values()].sort((a, b) => String(b.start).localeCompare(String(a.start)))
  });
}));

router.put('/:email', asyncRoute(async (req, res) => {
  const email = cleanText(req.params.email, 254).toLowerCase();
  if (!validEmail(email)) return res.status(400).json({ error: 'Inserisci un indirizzo email cliente valido.' });

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const profile = {
    name: cleanText(body.name, 120),
    phone: cleanText(body.phone, 40),
    notes: cleanText(body.notes, 2000)
  };
  const saved = LOCAL
    ? await localStorage.saveClientProfile(email, profile)
    : await saveClientProfile(req.user.storageId, email, profile);
  res.json(saved);
}));

export default router;
