// /api/gmail — Send email via Google Gmail API
// Vercel Edge Runtime
// POST with { to, subject, body } + Authorization: Bearer token

export const config = { runtime: "edge", regions: ["iad1"] };

const GMAIL_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

// Edge-compatible base64url encoding (no Buffer)
function base64UrlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function makeBase64Email(to, subject, body, from) {
  const mimeBody = base64UrlEncode(body);
  const encodedSubject = base64UrlEncode(subject);
  const raw = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: =?utf-8?B?${encodedSubject}?=`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    mimeBody,
  ].join("\r\n");
  return base64UrlEncode(raw);
}

export default async function handler(req) {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  const authHeader = req.headers.get("Authorization") || "";
  let accessToken = authHeader.replace(/^Bearer\s+/i, "");

  if (!accessToken) {
    return new Response(JSON.stringify({ error: "missing access token" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  let to = "", subject = "", body = "", refreshToken = "", from = "";
  try {
    const parsed = await req.json();
    to = parsed.to || "";
    subject = parsed.subject || "Message from Qbit";
    body = parsed.body || "";
    refreshToken = parsed.refresh_token || "";
    from = parsed.from || "";
  } catch {
    return new Response(JSON.stringify({ error: "invalid json" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!to) {
    return new Response(JSON.stringify({ error: "missing recipient (to)" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const rawEmail = makeBase64Email(to, subject, body, from);

  try {
    let res = await fetch(GMAIL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ raw: rawEmail }),
    });

    // Token refresh on 401
    if (res.status === 401 && refreshToken) {
      const clientId = process.env.GOOGLE_CLIENT_ID;
      const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
      if (clientId && clientSecret) {
        const refreshRes = await fetch(TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            refresh_token: refreshToken,
            grant_type: "refresh_token",
          }),
        });
        if (refreshRes.ok) {
          const newTokens = await refreshRes.json();
          accessToken = newTokens.access_token;
          res = await fetch(GMAIL_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${accessToken}`,
            },
            body: JSON.stringify({ raw: rawEmail }),
          });
        }
      }
    }

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      return new Response(JSON.stringify({ error: `gmail ${res.status}`, detail: errBody.slice(0, 500) }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }

    const data = await res.json();
    return new Response(
      JSON.stringify({ success: true, messageId: data.id, threadId: data.threadId }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}