const cookie = require('cookie');
const { google } = require('googleapis');

function getSession(req) {
  try {
    const cookies = cookie.parse(req.headers.cookie || '');
    if (!cookies.qbit_session) return null;
    return JSON.parse(Buffer.from(cookies.qbit_session, 'base64').toString());
  } catch {
    return null;
  }
}

function getAuthClient(session) {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  oauth2Client.setCredentials(session.tokens);
  return oauth2Client;
}

module.exports = { getSession, getAuthClient };
