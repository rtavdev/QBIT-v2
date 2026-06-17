const { google } = require('googleapis');
const { getSession, getAuthClient } = require('../_session');

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const auth = getAuthClient(session);
    const drive = google.drive({ version: 'v3', auth });
    const { query } = req.query;

    const q = query
      ? `name contains '${query}' and trashed=false`
      : "trashed=false and mimeType != 'application/vnd.google-apps.folder'";

    const files = await drive.files.list({
      q,
      pageSize: 15,
      fields: 'files(id,name,mimeType,modifiedTime,size,webViewLink)'
    });

    res.json({ files: files.data.files || [] });
  } catch (err) {
    console.error('Drive error:', err);
    res.status(500).json({ error: err.message });
  }
};
