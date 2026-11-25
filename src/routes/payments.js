import { Router } from 'express';
import { calendarForUser, configuredCalendarId } from '../services/googleCalendar.js';
import { createPayment, getPayments, getUser } from '../services/datastore.js';
import * as localStorage from '../services/localStorage.js';

const router = Router();
const LOCAL = process.env.APP_MODE !== 'google';
const PAYMENT_STATUSES = new Set(['In Attesa', 'Pagato', 'Annullato']);

const asyncRoute = fn => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const cleanText = (value, max = 254) =>
  typeof value === 'string' ? value.trim().slice(0, max) : '';

async function getBooking(req, eventId) {
  if (LOCAL) return localStorage.getEvent(eventId);

  const user = await getUser(req.user.storageId);
  if (!user) throw new Error('Profilo utente non trovato.');

  const calendar = await calendarForUser(user);
  try {
    const { data: event } = await calendar.events.get({
      calendarId: configuredCalendarId(),
      eventId
    });
    return {
      id: event.id,
      title: event.summary || '(No title)',
      start: event.start?.dateTime || event.start?.date
    };
  } catch (error) {
    if (error.code === 404) return null;
    throw error;
  }
}

router.get('/', asyncRoute(async (req, res) => {
  res.json(LOCAL
    ? await localStorage.getPayments()
    : await getPayments(req.user.storageId));
}));

router.post('/', asyncRoute(async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const clientEmail = cleanText(body.clientEmail);
  const amount = Number(body.amount);
  const eventId = body.eventId == null ? '' : cleanText(body.eventId, 512);
  const status = cleanText(body.status, 32);

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail)) {
    return res.status(400).json({ error: 'Inserisci un indirizzo email cliente valido.' });
  }

  if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000) {
    return res.status(400).json({ error: 'Inserisci un importo maggiore di 0 e non superiore a 1.000.000.' });
  }

  if (!PAYMENT_STATUSES.has(status)) {
    return res.status(400).json({ error: 'Seleziona uno stato di pagamento valido.' });
  }

  let booking = null;
  let examDate = body.examDate;

  if (eventId) {
    booking = await getBooking(req, eventId);
    if (!booking) {
      return res.status(404).json({ error: 'Impossibile trovare l’appuntamento selezionato.' });
    }
    examDate = booking.start;
  }

  if (typeof examDate !== 'string' || !Number.isFinite(Date.parse(examDate))) {
    return res.status(400).json({ error: 'Seleziona una data e un’ora valide per l’appuntamento.' });
  }

  const paymentData = {
    clientEmail,
    eventId: eventId || null,
    eventTitle: booking?.title || '',
    amount,
    status,
    examDate
  };

  const payment = LOCAL
    ? await localStorage.createPayment(paymentData)
    : await createPayment(req.user.storageId, paymentData);

  res.status(201).json(payment);
}));

export default router;
