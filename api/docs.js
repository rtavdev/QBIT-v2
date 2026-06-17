// /api/docs — Read Google Docs content
// Vercel Edge Runtime
// POST with { documentId } + Authorization: Bearer token

export const config = { runtime: "edge", regions: ["iad1"] };

const TOKEN_URL = "https://oauth2.googleapis.com/token";

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

  let documentId = "", refreshToken = "";
  try {
    const parsed = await req.json();
    documentId = parsed.documentId || "";
    refreshToken = parsed.refresh_token || "";
  } catch {
    return new Response(JSON.stringify({ error: "invalid json" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!documentId) {
    return new Response(JSON.stringify({ error: "missing documentId" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const DOCS_URL = `https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}`;

  try {
    let res = await fetch(DOCS_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
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
          res = await fetch(DOCS_URL, {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
        }
      }
    }

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      return new Response(JSON.stringify({ error: `docs ${res.status}`, detail: errBody.slice(0, 500) }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }

    const data = await res.json();

    // Extract plain text from the document
    const content = data.body?.content || [];
    const paragraphs = [];
    for (const item of content) {
      const elements = item.paragraph?.elements || [];
      for (const el of elements) {
        const text = el.textRun?.content || "";
        if (text) paragraphs.push(text);
      }
    }
    const plainText = paragraphs.join("").trim();
    const title = data.title || "Untitled";

    return new Response(
      JSON.stringify({
        success: true,
        title,
        content: plainText.slice(0, 50000), // limit to 50k chars
        charCount: plainText.length,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}