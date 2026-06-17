const { google } = require('googleapis');
const { getSession, getAuthClient } = require('../_session');

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const auth = getAuthClient(session);
    const gmail = google.gmail({ version: 'v1', auth });
    const { action, messageId, query } = req.query;

    if (action === 'read' && messageId) {
      const msg = await gmail.users.messages.get({
        userId: 'me',
        id: messageId,
        format: 'full'
      });
      const headers = msg.data.payload.headers;
      const get = (name) => headers.find(h => h.name === name)?.value || '';
      let body = '';
      const parts = msg.data.payload.parts || [];
      const textPart = parts.find(p => p.mimeType === 'text/plain');
      if (textPart?.body?.data) {
        body = Buffer.from(textPart.body.data, 'base64').toString('utf-8');
      } else if (msg.data.payload.body?.data) {
        body = Buffer.from(msg.data.payload.body.data, 'base64').toString('utf-8');
      }
      return res.json({
        id: msg.data.id,
        subject: get('Subject'),
        from: get('From'),
        date: get('Date'),
        body: body.slice(0, 3000)
      });
    }

    const list = await gmail.users.messages.list({
      userId: 'me',
      maxResults: 10,
      q: query || 'is:inbox is:unread'
    });

    const messages = list.data.messages || [];
    const previews = await Promise.all(messages.slice(0, 8).map(async (m) => {
      const full = await gmail.users.messages.get({
        userId: 'me', id: m.id, format: 'metadata',
        metadataHeaders: ['Subject', 'From', 'Date']
      });
      const h = full.data.payload.headers;
      const get = (name) => h.find(hh => hh.name === name)?.value || '';
      return {
        id: m.id,
        subject: get('Subject'),
        from: get('From'),
        date: get('Date'),
        snippet: full.data.snippet
      };
    }));

    res.json({ messages: previews });
  } catch (err) {
    console.error('Gmail error:', err);
    res.status(500).json({ error: err.message });
  }
};
