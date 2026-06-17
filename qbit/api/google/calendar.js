const { google } = require('googleapis');
const { getSession, getAuthClient } = require('../_session');

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const auth = getAuthClient(session);
    const calendar = google.calendar({ version: 'v3', auth });
    const { action } = req.query;

    if (action === 'create' && req.method === 'POST') {
      const { summary, description, start, end, attendees } = req.body || {};
      const event = await calendar.events.insert({
        calendarId: 'primary',
        requestBody: {
          summary,
          description,
          start: { dateTime: start, timeZone: 'Asia/Kolkata' },
          end: { dateTime: end, timeZone: 'Asia/Kolkata' },
          attendees: attendees ? attendees.map(e => ({ email: e })) : []
        }
      });
      return res.json({ created: true, event: event.data });
    }

    const now = new Date();
    const weekLater = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    const events = await calendar.events.list({
      calendarId: 'primary',
      timeMin: now.toISOString(),
      timeMax: weekLater.toISOString(),
      maxResults: 15,
      singleEvents: true,
      orderBy: 'startTime'
    });

    res.json({ events: events.data.items || [] });
  } catch (err) {
    console.error('Calendar error:', err);
    res.status(500).json({ error: err.message });
  }
};
