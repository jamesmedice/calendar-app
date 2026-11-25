# Shibumi Med Calendar

A small full-stack app using Node.js, Express, vanilla JavaScript, FullCalendar, Google OAuth 2.0, Google Calendar API, and Google Cloud Datastore.

## Features

- Local mode keeps bookings, payments, and client profiles in JSON files.
- Optional local Google sync uses OAuth and mirrors bookings to a configured Google Calendar, including client invitations.
- Google/production mode protects the entire app with Google Cloud IAP and stores application data in Google Cloud Datastore.
- Creates, edits, and deletes Google Calendar events with the client as an attendee.
- IAP JWT verification, OAuth state validation for Calendar linking, CSRF checks, and basic input validation.

## Requirements

- Node.js 20+
- A Google Cloud project with billing configured as required by Google Cloud
- Google Calendar API enabled
- Google Cloud Datastore enabled (only for `APP_MODE=google`)
- OAuth 2.0 Web application credentials

## Google Cloud setup

1. In Google Cloud Console, select/create a project.
2. Enable **Google Calendar API**.
3. For App Engine/Google mode, also enable **Cloud Datastore API** and create a Datastore-mode database.
4. Configure the OAuth consent screen. Add your Google account as a test user while the app is in Testing mode.
5. Create an OAuth Client ID of type **Web application** for the separate Calendar API connection.
6. Add `http://localhost:3000/auth/google/callback` for local use. For App Engine, add the production callback URL configured in protected runtime settings.
7. Copy the client ID and client secret into the local `.env` for development. Keep secrets out of source control.
8. Enable IAP for the App Engine app and grant the **IAP-secured Web App User** role to the users or groups allowed to use it.
9. Configure `APP_MODE=google`, `GOOGLE_CLOUD_PROJECT`, and `GCP_PROJECT_NUMBER` in the App Engine runtime. The app verifies IAP's signed identity assertion across the entire site and API.
10. Calendar access remains a separate OAuth connection: after IAP lets a user into the app, they connect Google Calendar to grant the Calendar scope. The token is stored under that IAP user's Datastore record.
11. The `GOOGLE_CALENDAR_ID` setting selects the calendar. The connected Google account must have edit access to it.

For Google/App Engine mode, authenticate local Datastore access with Application Default Credentials:

```bash
gcloud auth application-default login
gcloud config set project YOUR_PROJECT_ID
```

For deployment, attach a dedicated service account to App Engine with least-privilege Datastore permissions. Do not commit service-account JSON keys.

## Run locally

```bash
cp .env.example .env
# Edit .env and set all values, including a random SESSION_SECRET of 32+ characters.
npm install
npm run check
npm run dev
```

Local mode does not require an app login. For JSON bookings with Google Calendar sync, keep `APP_MODE=local`, set `GOOGLE_CALENDAR_SYNC=true`, fill in the OAuth client settings and `GOOGLE_CALENDAR_ID`, then restart and select **Collega Google Calendar**. This Google authorization connects the Calendar API only; it is not required to open the local app. Once connected, the encrypted refresh token in `data/google-auth.json` is reused for sync.

Set `GOOGLE_CALENDAR_SYNC=false` to run fully offline. For App Engine, use `APP_MODE=google`; application records then use Datastore instead of local JSON.

`dotenv/config` loads `.env`, not `.env.prod`. App Engine receives settings from `app.yaml` and protected runtime configuration; do not upload `.env.prod` or commit secrets. Set `GOOGLE_CLOUD_PROJECT`, `GCP_PROJECT_NUMBER`, `GOOGLE_CALENDAR_ID`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, and `SESSION_SECRET` in the App Engine runtime before deploying.

The IAP assertion is validated against the expected App Engine audience; do not replace this with trust in unsigned identity headers. IAP protects access to the app, while Calendar OAuth grants the distinct permission to call Google Calendar APIs.

Generate a session secret with:

```bash
openssl rand -base64 48
```

## Environment variables

| Variable | Purpose |
|---|---|
| `APP_MODE` | `local` keeps app data in JSON; `google` uses Datastore for Google/App Engine mode |
| `GOOGLE_CALENDAR_SYNC` | Set `true` with `APP_MODE=local` to sync JSON bookings to Google Calendar |
| `PORT` | HTTP port (default 3000) |
| `NODE_ENV` | Set `production` when deployed |
| `APP_BASE_URL` | Canonical app URL; informational in this starter |
| `SESSION_SECRET` | Signs the session cookie; use a long random secret |
| `GOOGLE_CLIENT_ID` | OAuth web client ID |
| `GOOGLE_CLIENT_SECRET` | OAuth web client secret |
| `GOOGLE_REDIRECT_URI` | Must match the URI registered in Google Cloud |
| `GOOGLE_CLOUD_PROJECT` | Google Cloud project ID (required for Datastore mode) |
| `GCP_PROJECT_NUMBER` | Google Cloud project number used to verify the App Engine IAP audience |
| `GOOGLE_CALENDAR_ID` | Target calendar ID; defaults to `primary` until configured |
| `GOOGLE_CALENDAR_NAME` | Name used when creating the dedicated calendar |
| `GOOGLE_CALENDAR_TIME_ZONE` | Time zone assigned to the new calendar (default `Europe/Rome`) |

## API routes

- `GET /api/me` — verified IAP user and Calendar connection status in Google mode
- `GET /api/events?start=ISO&end=ISO` — list events from the configured calendar
- `POST /api/events/google-calendar` — create the dedicated calendar and return its ID
- `POST /api/events` — create event (`title`, `clientEmail`, `start`, `end`, optional `description`, `location`)
- `PUT /api/events/:id` — update event fields
- `DELETE /api/events/:id` — delete event
- `GET /auth/google` — connect or change the Google Calendar account after IAP login
- `POST /auth/logout` — end the OAuth/session connection; IAP controls app access
- `GET /health` — health check

## Datastore data model

- `CalendarUser/{Google subject ID}`: IAP-linked user, Calendar account details, and Calendar refresh/access token. Google IAP subjects retain the Google subject suffix used by existing records.
- `CalendarUser/{Google subject ID}/EventMetadata/{Google event ID}`: title, notes, location, status and timestamps.

In local sync mode, JSON remains the source of truth for bookings, payments, and profiles. Events are sent to Google with `sendUpdates=all`, and each JSON booking keeps its `googleEventId`; failed syncs remain pending and retry when the calendar is loaded. Refresh tokens are encrypted locally. In Google mode, Google Calendar is the source of truth for events and Datastore stores the account link, payments, profiles, and event metadata.

## Before production — important

This is a runnable starter, not a production security review. In particular:

1. **Protect refresh tokens.** Local mode encrypts its token file with `SESSION_SECRET`; Google mode stores OAuth tokens in Datastore. In production, use Cloud KMS/envelope encryption, restrict service-account access, and implement token rotation/revocation. Never expose tokens to the browser.
2. **Use a persistent session store.** The default `express-session` MemoryStore is development-only. Configure a production session store (for example a supported Redis or Firestore-backed store), and set HTTPS-only cookies.
3. Add CSRF protection for state-changing routes, rate limiting, request schema validation, audit logging, and stricter Content Security Policy.
4. Restrict OAuth scopes to the minimum your features need and publish/verify the OAuth consent screen as appropriate for your audience.
5. For multi-user deployment, ensure every record and API operation is scoped to the authenticated Google subject ID.
6. Add pagination for calendars with large event volumes and handle Google API quota/retry errors.
7. The UI loads FullCalendar from jsDelivr. Self-host/pin assets and configure a strict CSP for production.

## Notes

- The app requests the Google Calendar scope and uses `GOOGLE_CALENDAR_ID`; it falls back to `primary` if the setting is empty.
- Google may not return a refresh token on every authorization. The save logic preserves an existing refresh token when a subsequent OAuth response omits it; `prompt=consent` is used to request offline access.
- The app uses the default calendar timezone behavior and submits event times as ISO timestamps from the browser's local timezone.
