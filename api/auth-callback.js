// /api/auth-callback — Google OAuth callback handler
// Exchanges auth code for tokens, saves to localStorage.
// Vercel Edge Runtime.

export const config = { runtime: "edge", regions: ["iad1"] };

const TOKEN_URL = "https://oauth2.googleapis.com/token";

export default async function handler(req) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");

  if (!code) {
    return new Response("Missing authorization code", { status: 400 });
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return new Response("Google OAuth credentials not configured", { status: 500 });
  }

  const host = req.headers.get("host") || "localhost:3000";
  const protocol = host.includes("localhost") ? "http" : "https";
  const redirectUri = `${protocol}://${host}/api/auth-callback`;

  try {
    const tokenRes = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenRes.ok) {
      const errBody = await tokenRes.text();
      return new Response(`Token exchange failed: ${errBody}`, { status: 502 });
    }

    const tokens = await tokenRes.json();
    const tokenData = JSON.stringify({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || "",
      expires_at: Date.now() + (tokens.expires_in || 3600) * 1000,
    });

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Qbit — Google Connected</title>
  <style>
    body { background: #05070d; color: #e8efff; font-family: monospace; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; text-align: center; }
    .box { padding: 2.5rem; border: 1px solid #b6ff3c; background: #0a0e18; }
    h1 { color: #b6ff3c; font-family: Syne, sans-serif; }
    p { color: #7c8aa8; }
    .ok { color: #38e8ff; }
  </style>
</head>
<body>
  <div class="box">
    <h1>✓ Connected</h1>
    <p>Your Google Calendar is now linked to <span class="ok">Qbit</span>.</p>
    <p class="ok">You may close this tab.</p>
  </div>
  <script>
    try {
      window.opener.postMessage({ type: "google-oauth-tokens", data: ${tokenData} }, "*");
      window.close();
    } catch(e) {}
  </script>
</body>
</html>`;

    return new Response(html, {
      headers: { "content-type": "text/html;charset=utf-8" },
    });
  } catch (err) {
    return new Response(`OAuth callback error: ${err.message}`, { status: 500 });
  }
}