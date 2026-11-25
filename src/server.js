
import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import authRoutes from './routes/auth.js';
import eventRoutes from './routes/events.js';
import paymentRoutes from './routes/payments.js';
import clientRoutes from './routes/clients.js';
import { requireIap } from './middleware/requireIap.js';
import { getUser } from './services/datastore.js';
import { getLocalGoogleUser } from './services/localGoogleAuth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

const isProduction = process.env.NODE_ENV === 'production';
const LOCAL_MODE = process.env.APP_MODE !== 'google';
const LOCAL_GOOGLE_SYNC = LOCAL_MODE && process.env.GOOGLE_CALENDAR_SYNC === 'true';
const GOOGLE_AUTH_ENABLED = !LOCAL_MODE || LOCAL_GOOGLE_SYNC;

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  throw new Error('SESSION_SECRET must be set to a random value of at least 32 characters.');
}

if (!LOCAL_MODE && (!process.env.GOOGLE_CLOUD_PROJECT || !process.env.GCP_PROJECT_NUMBER)) {
  throw new Error('Set GOOGLE_CLOUD_PROJECT and GCP_PROJECT_NUMBER to enable IAP authentication.');
}

if (isProduction) app.set('trust proxy', 1);

app.use(helmet({ contentSecurityPolicy: false }));

app.use(express.json({ limit: '100kb' }));

app.use(session({
  name: 'calendar.sid',
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000
  },
}));

if (LOCAL_MODE) {
  app.use((req, res, next) => {
    const remoteAddress = req.socket.remoteAddress;
    if (!['::1', '127.0.0.1', '::ffff:127.0.0.1'].includes(remoteAddress)) {
      return res.status(403).send('La modalità locale è disponibile solo da questo computer.');
    }
    next();
  });
} else {
  app.use(requireIap);
}

// ==================================
// FRONTEND
// ==================================


const publicPath = path.join(__dirname, '..', 'public');

app.use(express.static(publicPath));

app.get('/', (req, res) => {
  res.sendFile(path.join(publicPath, 'index.html'));
});

// ==================================
// CSRF PROTECTION
// ==================================

function requireCsrf(req, res, next) {
  const expected = req.session.csrfToken;
  const received = String(req.get('x-csrf-token') || '');

  if (
    !expected ||
    expected.length !== received.length ||
    !timingSafeEqual(Buffer.from(expected), Buffer.from(received))
  ) {
    return res.status(403).json({
      error: 'Token di sicurezza non valido. Aggiorna la pagina e riprova.'
    });
  }

  next();
}

// ==================================
// CURRENT USER
// ==================================

app.get('/api/me', async (req, res, next) => {
  try {
    req.session.csrfToken ||= randomBytes(32).toString('hex');

    if (LOCAL_MODE) {
      const localGoogleUser = LOCAL_GOOGLE_SYNC
        ? await getLocalGoogleUser()
        : null;

      return res.json({
        authenticated: true,
        mode: 'local',
        user: localGoogleUser
          ? {
              name: localGoogleUser.name,
              email: localGoogleUser.email,
              picture: localGoogleUser.picture
            }
          : { name: 'Local User', email: 'local@localhost' },
        googleSyncEnabled: LOCAL_GOOGLE_SYNC,
        calendarConnected: Boolean(localGoogleUser),
        calendarConfigured: Boolean(process.env.GOOGLE_CALENDAR_ID),
        csrfToken: req.session.csrfToken
      });
    }

    const calendarUser = await getUser(req.user.storageId);

    res.json({
      authenticated: true,
      mode: 'google',
      user: {
        email: req.user.email,
        calendarEmail: calendarUser?.email || null
      },
      calendarConfigured: Boolean(process.env.GOOGLE_CALENDAR_ID),
      calendarConnected: Boolean(calendarUser?.refreshToken),
      csrfToken: req.session.csrfToken
    });

  } catch (error) {
    next(error);
  }
});

// ==================================
// AUTHENTICATION
// ==================================

if (GOOGLE_AUTH_ENABLED) {
  app.use('/auth/logout', requireCsrf);
  app.use('/auth', authRoutes);
}

// ==================================
// CALENDAR EVENTS API
// ==================================

app.use(
  '/api/events',

  (req, res, next) => {
    if (!LOCAL_MODE && !req.user?.id) {
      return res.status(401).json({
        error: 'Autenticazione IAP richiesta.'
      });
    }

    next();
  },

  (req, res, next) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      return requireCsrf(req, res, next);
    }

    next();
  },

  eventRoutes
);

app.use(
  '/api/payments',

  (req, res, next) => {
    if (!LOCAL_MODE && !req.user?.id) {
      return res.status(401).json({
        error: 'Autenticazione IAP richiesta.'
      });
    }

    next();
  },

  (req, res, next) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      return requireCsrf(req, res, next);
    }

    next();
  },

  paymentRoutes
);

app.use(
  '/api/clients',

  (req, res, next) => {
    if (!LOCAL_MODE && !req.user?.id) {
      return res.status(401).json({
        error: 'Autenticazione IAP richiesta.'
      });
    }

    next();
  },

  (req, res, next) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      return requireCsrf(req, res, next);
    }

    next();
  },

  clientRoutes
);

// ==================================
// ERROR HANDLER
// ==================================

app.use((err, req, res, next) => {
  console.error(err);

  res.status(err.status || 500).json({
    error: isProduction ? 'Errore interno del server.' : err.message
  });
});

// ==================================
// START SERVER
// ==================================

const port = Number(process.env.PORT || 3000);

app.listen(port, () => {
  console.log(`Applicazione avviata su http://localhost:${port}`);
});
