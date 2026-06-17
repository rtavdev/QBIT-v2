const cookie = require('cookie');

module.exports = (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  try {
    const cookies = cookie.parse(req.headers.cookie || '');
    if (!cookies.qbit_session) return res.json({ authenticated: false });
    const session = JSON.parse(Buffer.from(cookies.qbit_session, 'base64').toString());
    res.json({ authenticated: true, user: session.user });
  } catch {
    res.json({ authenticated: false });
  }
};
