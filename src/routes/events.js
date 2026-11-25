import { Router } from 'express';
import { calendarForUser, configuredCalendarId } from '../services/googleCalendar.js';
import { getLocalGoogleUser } from '../services/localGoogleAuth.js';
import {
  getUser,
  saveEventMetadata,
  deleteEventMetadata
} from '../services/datastore.js';

import * as localStorage from '../services/localStorage.js';

const router = Router();
const LOCAL = process.env.APP_MODE !== 'google';
const LOCAL_GOOGLE_SYNC = LOCAL && process.env.GOOGLE_CALENDAR_SYNC === 'true';

const asyncRoute = fn => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const cleanText = (value, max = 2000) =>
  typeof value === 'string' ? value.trim().slice(0, max) : '';
const validEmail = email =>
  /^[^\s@/\\]+@[^\s@/\\]+\.[^\s@/\\]+$/.test(email) && email.length <= 254;

function clientEmailFor(event) {
  return event?.extendedProperties?.private?.clientEmail ||
    event?.attendees?.find(attendee => !attendee.organizer && !attendee.self && attendee.email)?.email ||
    '';
}

function validateEvent(data) {
  const start = Date.parse(data.start);
  const end = Date.parse(data.end);

  return typeof data.title === 'string' &&
    Boolean(data.title.trim()) &&
    validEmail(data.clientEmail) &&
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    end > start;
}

function eventResponse(event, clientEmail = clientEmailFor(event)) {
  return {
    id: event.id,
    title: event.summary || '(Senza titolo)',
    clientEmail,
    start: event.start?.dateTime || event.start?.date,
    end: event.end?.dateTime || event.end?.date,
    allDay: Boolean(event.start?.date && !event.start?.dateTime),
    description: event.description || '',
    location: event.location || '',
    htmlLink: event.htmlLink
  };
}

function localEventResponse(event, syncError) {
  return {
    ...event,
    allDay: Boolean(event.start && /^\d{4}-\d{2}-\d{2}$/.test(event.start)),
    ...(syncError ? { syncError } : {})
  };
}

function googleDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? { date: value }
    : { dateTime: new Date(value).toISOString() };
}

function googleEventResource(event, existing) {
  const previousClientEmail = clientEmailFor(existing).toLowerCase();
  const attendees = (existing?.attendees || [])
    .filter(attendee =>
      attendee.email &&
      !attendee.organizer &&
      !attendee.self &&
      String(attendee.email).toLowerCase() !== previousClientEmail &&
      String(attendee.email).toLowerCase() !== event.clientEmail.toLowerCase()
    )
    .map(attendee => ({ email: attendee.email }));

  attendees.push({ email: event.clientEmail });

  return {
    summary: event.title,
    description: event.description || '',
    location: event.location || '',
    attendees,
    extendedProperties: {
      private: {
        ...existing?.extendedProperties?.private,
        clientEmail: event.clientEmail,
        localBookingId: event.id
      }
    },
    start: googleDate(event.start),
    end: googleDate(event.end)
  };
}

function remoteEventMatches(remote, event) {
  const remoteStart = remote.start?.dateTime || remote.start?.date;
  const remoteEnd = remote.end?.dateTime || remote.end?.date;
  return remote.summary === event.title &&
    Date.parse(remoteStart) === Date.parse(event.start) &&
    Date.parse(remoteEnd) === Date.parse(event.end) &&
    (remote.description || '') === (event.description || '') &&
    (remote.location || '') === (event.location || '') &&
    clientEmailFor(remote).toLowerCase() === event.clientEmail.toLowerCase();
}

async function getCalendar(req) {
  const user = LOCAL
    ? await getLocalGoogleUser()
    : await getUser(req.user.storageId);
  if (!user) {
    throw new Error(LOCAL
      ? 'Collega un account Google Calendar dalla pagina iniziale per sincronizzare.'
      : 'Collega Google Calendar per continuare.');
  }
  return calendarForUser(user);
}

async function syncLocalEvent(calendar, event) {
  if (!validEmail(event.clientEmail)) {
    throw new Error(`L’appuntamento "${event.title}" richiede un’email cliente per la sincronizzazione.`);
  }

  const calendarId = configuredCalendarId();
  let remote;
  if (event.googleEventId) {
    try {
      const { data } = await calendar.events.get({ calendarId, eventId: event.googleEventId });
      remote = data;
    } catch (error) {
      if (error.code !== 404) throw error;
    }
  }

  if (!remote) {
    const { data: matches } = await calendar.events.list({
      calendarId,
      privateExtendedProperty: `localBookingId=${event.id}`,
      maxResults: 1
    });
    remote = matches.items?.[0];
  }

  if (!remote) {
    const { data } = await calendar.events.insert({
      calendarId,
      sendUpdates: 'all',
      resource: googleEventResource(event)
    });
    remote = data;
  } else if (!remoteEventMatches(remote, event)) {
    const { data } = await calendar.events.patch({
      calendarId,
      eventId: remote.id,
      sendUpdates: 'all',
      resource: googleEventResource(event, remote)
    });
    remote = data;
  }

  if (!remote.id) throw new Error('Google non ha restituito l’ID dell’appuntamento.');
  const linked = await localStorage.linkGoogleEvent(event.id, remote.id);
  if (!linked) throw new Error('Appuntamento locale non trovato dopo la sincronizzazione Google.');
  return linked;
}

router.post('/google-calendar', asyncRoute(async (req, res) => {
  if (LOCAL && !LOCAL_GOOGLE_SYNC) {
    return res.status(409).json({ error: 'Collega Google per creare un calendario dedicato.' });
  }
  if (process.env.GOOGLE_CALENDAR_ID) {
    return res.status(409).json({ error: 'GOOGLE_CALENDAR_ID è già configurato.' });
  }

  const calendar = await getCalendar(req);
  const summary = process.env.GOOGLE_CALENDAR_NAME || 'Shibumi Med — Appuntamenti';
  const { data: calendarList } = await calendar.calendarList.list({
    minAccessRole: 'owner',
    maxResults: 250
  });
  const existing = (calendarList.items || []).find(item => item.summary === summary);
  if (existing?.id) {
    return res.json({ calendarId: existing.id, calendarName: summary, created: false });
  }

  const { data: created } = await calendar.calendars.insert({
    resource: {
      summary,
      timeZone: process.env.GOOGLE_CALENDAR_TIME_ZONE || 'Europe/Rome'
    }
  });
  if (!created.id) throw new Error('Google non ha restituito l’ID del nuovo calendario.');

  res.status(201).json({
    calendarId: created.id,
    calendarName: created.summary || summary,
    created: true
  });
}));

// GET EVENTS
router.get('/', asyncRoute(async (req, res) => {
  const timeMin = req.query.start ||
    new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1).toISOString();

  const timeMax = req.query.end ||
    new Date(new Date().getFullYear(), new Date().getMonth() + 2, 1).toISOString();

  if (!Number.isFinite(Date.parse(timeMin)) ||
      !Number.isFinite(Date.parse(timeMax)) ||
      Date.parse(timeMin) >= Date.parse(timeMax)) {
    return res.status(400).json({ error: 'Intervallo di date non valido.' });
  }

  if (LOCAL && !LOCAL_GOOGLE_SYNC) {
    return res.json(await localStorage.getEvents(timeMin, timeMax));
  }

  if (LOCAL_GOOGLE_SYNC) {
    const events = await localStorage.getEvents(timeMin, timeMax);
    let calendar;
    try {
      calendar = await getCalendar(req);
    } catch (error) {
      return res.json(events.map(event => localEventResponse(event, error.message)));
    }

    const syncErrors = new Map();

    for (const event of events) {
      if (!event.googleSyncPending && event.googleEventId) continue;
      try {
        await syncLocalEvent(calendar, event);
      } catch (error) {
        syncErrors.set(event.id, error.message);
      }
    }

    const refreshed = await localStorage.getEvents(timeMin, timeMax);
    return res.json(refreshed.map(event =>
      localEventResponse(event, syncErrors.get(event.id))
    ));
  }

  const calendar = await getCalendar(req);

  const { data } = await calendar.events.list({
    calendarId: configuredCalendarId(),
    timeMin: new Date(timeMin).toISOString(),
    timeMax: new Date(timeMax).toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 250
  });
  const events = (data.items || []).filter(event =>
    event.status !== 'cancelled' && event.start && event.end
  );

  await Promise.all(events.map(event =>
    localStorage.saveGoogleEvent(req.user.storageId, event, clientEmailFor(event))
  ));

  res.json(events.map(event => eventResponse(event)));
}));

// CREATE EVENT
router.post('/', asyncRoute(async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const eventData = {
    title: cleanText(body.title, 200),
    clientEmail: cleanText(body.clientEmail, 254).toLowerCase(),
    start: body.start,
    end: body.end,
    description: cleanText(body.description),
    location: cleanText(body.location, 500)
  };

  if (!validateEvent(eventData)) {
    return res.status(400).json({ error: 'Inserisci titolo, email cliente e date valide.' });
  }

  if (LOCAL) {
    const event = await localStorage.createEvent({
      ...eventData,
      googleSyncPending: LOCAL_GOOGLE_SYNC
    });
    if (!LOCAL_GOOGLE_SYNC) return res.status(201).json(event);

    try {
      const calendar = await getCalendar(req);
      return res.status(201).json(localEventResponse(await syncLocalEvent(calendar, event)));
    } catch (error) {
      return res.status(202).json(localEventResponse(event, error.message));
    }
  }

  const calendar = await getCalendar(req);
  const { data: event } = await calendar.events.insert({
    calendarId: configuredCalendarId(),
    sendUpdates: 'all',
    resource: {
      summary: eventData.title,
      description: eventData.description,
      location: eventData.location,
      attendees: [{ email: eventData.clientEmail }],
      extendedProperties: { private: { clientEmail: eventData.clientEmail } },
      start: { dateTime: new Date(eventData.start).toISOString() },
      end: { dateTime: new Date(eventData.end).toISOString() }
    }
  });

  await saveEventMetadata(req.user.storageId, event);
  await localStorage.saveGoogleEvent(req.user.storageId, event, eventData.clientEmail);

  res.status(201).json(eventResponse(event, eventData.clientEmail));
}));

// UPDATE EVENT
router.put('/:id', asyncRoute(async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const data = {};

  if (body.title !== undefined) data.title = cleanText(body.title, 200);
  if (body.clientEmail !== undefined) data.clientEmail = cleanText(body.clientEmail, 254).toLowerCase();
  if (body.description !== undefined) data.description = cleanText(body.description);
  if (body.location !== undefined) data.location = cleanText(body.location, 500);
  if (body.start !== undefined) data.start = body.start;
  if (body.end !== undefined) data.end = body.end;

  if (LOCAL) {
    const existing = await localStorage.getEvents(
      '1970-01-01T00:00:00.000Z',
      '9999-12-31T23:59:59.999Z'
    );
    const current = existing.find(event => event.id === req.params.id);
    if (!current) return res.status(404).json({ error: 'Appuntamento non trovato.' });

    const candidate = { ...current, ...data };
    if (!validateEvent(candidate)) {
      return res.status(400).json({ error: 'Inserisci titolo, email cliente e date valide.' });
    }

    const updated = await localStorage.updateEvent(req.params.id, {
      ...data,
      ...(LOCAL_GOOGLE_SYNC ? { googleSyncPending: true } : {})
    });
    if (!updated) return res.status(404).json({ error: 'Appuntamento non trovato.' });
    if (!LOCAL_GOOGLE_SYNC) return res.json(updated);

    try {
      const calendar = await getCalendar(req);
      return res.json(localEventResponse(await syncLocalEvent(calendar, updated)));
    } catch (error) {
      return res.status(202).json(localEventResponse(updated, error.message));
    }
  }

  const calendar = await getCalendar(req);
  const calendarId = configuredCalendarId();
  const { data: current } = await calendar.events.get({
    calendarId,
    eventId: req.params.id
  });
  const candidate = {
    title: data.title ?? current.summary ?? '',
    clientEmail: data.clientEmail ?? clientEmailFor(current),
    start: data.start ?? current.start?.dateTime ?? current.start?.date,
    end: data.end ?? current.end?.dateTime ?? current.end?.date
  };
  if (!validateEvent(candidate)) {
    return res.status(400).json({ error: 'Inserisci titolo, email cliente e date valide.' });
  }

  const patch = {};
  if (data.title !== undefined) patch.summary = data.title;
  if (data.description !== undefined) patch.description = data.description;
  if (data.location !== undefined) patch.location = data.location;

  if (data.start !== undefined)
    patch.start = { dateTime: new Date(data.start).toISOString() };

  if (data.end !== undefined)
    patch.end = { dateTime: new Date(data.end).toISOString() };

  if (data.clientEmail !== undefined) {
    const previousEmail = clientEmailFor(current).toLowerCase();
    const attendees = (current.attendees || [])
      .filter(attendee =>
        attendee.email &&
        !attendee.organizer &&
        !attendee.self &&
        String(attendee.email).toLowerCase() !== previousEmail &&
        String(attendee.email).toLowerCase() !== data.clientEmail
      )
      .map(attendee => ({ email: attendee.email }));
    attendees.push({ email: data.clientEmail });
    patch.attendees = attendees;
    patch.extendedProperties = {
      private: {
        ...current.extendedProperties?.private,
        clientEmail: data.clientEmail
      }
    };
  }

  const { data: event } = await calendar.events.patch({
    calendarId,
    eventId: req.params.id,
    sendUpdates: 'all',
    resource: patch
  });

  await saveEventMetadata(req.user.storageId, event);
  await localStorage.saveGoogleEvent(req.user.storageId, event, candidate.clientEmail);

  res.json(eventResponse(event, candidate.clientEmail));
}));

// DELETE EVENT
router.delete('/:id', asyncRoute(async (req, res) => {
  if (LOCAL) {
    if (LOCAL_GOOGLE_SYNC) {
      const events = await localStorage.getEvents(
        '1970-01-01T00:00:00.000Z',
        '9999-12-31T23:59:59.999Z'
      );
      const event = events.find(record => record.id === req.params.id);
      if (!event) return res.status(404).json({ error: 'Appuntamento non trovato.' });

      if (event.googleEventId) {
        const calendar = await getCalendar(req);
        try {
          await calendar.events.delete({
            calendarId: configuredCalendarId(),
            eventId: event.googleEventId,
            sendUpdates: 'all'
          });
        } catch (error) {
          if (error.code !== 404) throw error;
        }
      }
    }

    const deleted = await localStorage.deleteEvent(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Appuntamento non trovato.' });
    return res.status(204).end();
  }

  const calendar = await getCalendar(req);
  try {
    await calendar.events.delete({
      calendarId: configuredCalendarId(),
      eventId: req.params.id,
      sendUpdates: 'all'
    });
  } catch (error) {
    if (error.code !== 404) throw error;
  }

  await deleteEventMetadata(req.user.storageId, req.params.id);
  await localStorage.deleteGoogleEvent(req.user.storageId, req.params.id);
  res.status(204).end();
}));

export default router;
