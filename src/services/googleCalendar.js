import { google } from 'googleapis';

export function createOAuthClient() {
  const missing = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI']
    .filter(key => !process.env[key]);
  if (missing.length) {
    throw new Error(`Configura ${missing.join(', ')} per collegare Google Calendar.`);
  }

  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI,
  );
}

export function configuredCalendarId() {
  return process.env.GOOGLE_CALENDAR_ID || 'primary';
}

export async function calendarForUser(user) {
  if (!user?.refreshToken) throw new Error('Account Google non collegato. Accedi di nuovo.');
  const auth = createOAuthClient();
  auth.setCredentials({ refresh_token: user.refreshToken });
  return google.calendar({ version: 'v3', auth });
}
