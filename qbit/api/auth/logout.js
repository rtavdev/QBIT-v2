const cookie = require('cookie');

module.exports = (req, res) => {
  res.setHeader('Set-Cookie', cookie.serialize('qbit_session', '', {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 0,
    path: '/'
  }));
  res.redirect('/');
};
