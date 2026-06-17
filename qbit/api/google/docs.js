const { google } = require('googleapis');
const { getSession, getAuthClient } = require('../_session');

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  const { type, fileId } = req.query;
  if (!fileId) return res.status(400).json({ error: 'fileId required' });

  try {
    const auth = getAuthClient(session);

    if (type === 'sheet') {
      const sheets = google.sheets({ version: 'v4', auth });
      const data = await sheets.spreadsheets.values.get({
        spreadsheetId: fileId,
        range: 'A1:Z100'
      });
      return res.json({ values: data.data.values || [] });
    }

    const docs = google.docs({ version: 'v1', auth });
    const doc = await docs.documents.get({ documentId: fileId });
    const text = (doc.data.body?.content || [])
      .flatMap(el => el.paragraph?.elements || [])
      .map(el => el.textRun?.content || '')
      .join('')
      .slice(0, 4000);

    res.json({ title: doc.data.title, text });
  } catch (err) {
    console.error('Docs/Sheets error:', err);
    res.status(500).json({ error: err.message });
  }
};
