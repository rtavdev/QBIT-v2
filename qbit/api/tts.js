/**
 * Qbit Text-to-Speech API Route
 * Google Cloud TTS -> MP3 streaming via Vercel Serverless
 * Zero npm dependencies for auth - uses raw JWT + HTTPS fetch
 */
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).setHeader('Allow', 'POST').end();
  }

  const { text } = req.body || {};
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return res.status(400).json({ error: 'text field is required' });
  }

  const safeText = text.trim().slice(0, 5000);

  try {
    const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;

    if (!credentialsJson) {
      console.error('Missing GOOGLE_APPLICATION_CREDENTIALS_JSON');
      return res.status(500).json({ error: 'TTS service not configured' });
    }

    let credentials;
    try {
      credentials = JSON.parse(credentialsJson);
    } catch {
      return res.status(500).json({ error: 'Invalid credentials format' });
    }

    const token = await getAccessToken(credentials);

    // Build SSML - escape XML special chars using numeric entities to survive auto-formatters
    var amp = '\x26amp;';
    var lt = '\x26lt;';
    var gt = '\x26gt;';
    var quot = '\x26quot;';
    var apos = '\x26apos;';
    var escaped = safeText
      .replace(/\x26/g, amp)
      .replace(/</g, lt)
      .replace(/>/g, gt)
      .replace(/\x22/g, quot)
      .replace(/\x27/g, apos);
    var ssml = '<speak><prosody rate="1.0" pitch="0" volume="medium">' + escaped + '</prosody></speak>';

    var ttsPayload = {
      input: { ssml: ssml },
      voice: {
        languageCode: 'en-US',
        name: 'en-US-Neural2-J'
      },
      audioConfig: {
        audioEncoding: 'MP3',
        speakingRate: 1.0,
        pitch: 0,
        volumeGainDb: 0
      }
    };

    var ttsRes = await fetch(
      'https://texttospeech.googleapis.com/v1/text:synthesize',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(ttsPayload)
      }
    );

    if (!ttsRes.ok) {
      var errBody = await ttsRes.text();
      console.error('Google TTS error:', ttsRes.status, errBody);
      return res.status(502).json({ error: 'TTS synthesis failed' });
    }

    var ttsData = await ttsRes.json();
    var audioBuffer = Buffer.from(ttsData.audioContent, 'base64');

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', audioBuffer.length);
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.status(200).send(audioBuffer);
  } catch (err) {
    console.error('TTS error:', err);
    res.status(500).json({ error: 'Internal TTS error' });
  }
};

/**
 * Obtain a short-lived Google OAuth2 access token from a service account JSON key.
 * Uses raw JWT + RSA-SHA256 signing via Node crypto - no extra dependencies.
 */
async function getAccessToken(credentials) {
  var crypto = require('crypto');
  var privateKey = credentials.private_key;
  var clientEmail = credentials.client_email;

  function base64UrlEncode(obj) {
    return Buffer.from(JSON.stringify(obj))
      .toString('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
  }

  var header = { alg: 'RS256', typ: 'JWT' };
  var now = Math.floor(Date.now() / 1000);
  var claim = {
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  };

  var signatureInput = base64UrlEncode(header) + '.' + base64UrlEncode(claim);
  var sign = crypto.createSign('RSA-SHA256');
  sign.update(signatureInput);
  var signature = sign.sign(privateKey, 'base64');
  var jwt = signatureInput + '.' + signature.replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  var tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    })
  });

  if (!tokenRes.ok) {
    var errBody = await tokenRes.text();
    throw new Error('Token exchange failed: ' + tokenRes.status + ' ' + errBody);
  }

  var tokenData = await tokenRes.json();
  return tokenData.access_token;
}