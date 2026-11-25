import { Router } from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { google } from 'googleapis';
import { createOAuthClient } from '../services/googleCalendar.js';
import { saveUser } from '../services/datastore.js';
import { saveLocalGoogleUser } from '../services/localGoogleAuth.js';

const router = Router();
const SCOPES = ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/calendar'];
const LOCAL_MODE = process.env.APP_MODE !== 'google';
const LOCAL_GOOGLE_SYNC = LOCAL_MODE && process.env.GOOGLE_CALENDAR_SYNC === 'true';

router.get('/google', (req, res) => {
  const state = randomBytes(32).toString('hex');
  req.session.oauthState = state;
  const url = createOAuthClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state,
  });
  res.redirect(url);
});

router.get('/google/callback', async (req, res, next) => {
  try {
    const expected = req.session.oauthState;
    const received = String(req.query.state ?? '');
    delete req.session.oauthState;
    if (!expected || expected.length !== received.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(received))) {
      return res.status(400).send('Sessione di accesso non valida. Riprova ad accedere.');
    }
    if (req.query.error) return res.redirect('/?error=google_access_denied');
    if (!req.query.code) return res.status(400).send('Codice di autorizzazione mancante.');

    const oauth = createOAuthClient();
    const { tokens } = await oauth.getToken(String(req.query.code));
    oauth.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth });
    const { data: profile } = await oauth2.userinfo.get();
    if (!profile.id) throw new Error('Google non ha restituito un identificativo dell’account.');

    const userId = LOCAL_GOOGLE_SYNC ? profile.id : req.user.storageId;
    if (LOCAL_GOOGLE_SYNC) await saveLocalGoogleUser(userId, profile, tokens);
    else await saveUser(userId, profile, tokens);
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.save((saveErr) => saveErr ? next(saveErr) : res.redirect('/'));
    });
  } catch (error) { next(error); }
});

router.post('/logout', (req, res, next) => {
  req.session.destroy((error) => {
    if (error) return next(error);
    res.clearCookie('calendar.sid');
    res.json({ ok: true });
  });
});

export default router;
