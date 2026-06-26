// /api/calendar — Create Google Calendar events
// Vercel Edge Runtime
// Accepts a POST with { summary, description, start, end } and a valid
// Google OAuth access token in the Authorization header.

export const config = { runtime: "edge", regions: ["iad1"] };

const CALENDAR_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export default async function handler(req) {
  // CORS preflight
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

  let summary = "";
  let description = "";
  let startTime = "";
  let endTime = "";
  try {
    const body = await req.json();
    summary = body.summary || "Qbit reminder";
    description = body.description || "Created by Qbit";
    startTime = body.start;
    endTime = body.end;
  } catch {
    return new Response(JSON.stringify({ error: "invalid json" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!startTime) {
    const now = new Date();
    now.setHours(now.getHours() + 1);
    startTime = now.toISOString();
    const end = new Date(now.getTime() + 30 * 60 * 1000);
    endTime = end.toISOString();
  }
  if (!endTime) {
    const end = new Date(new Date(startTime).getTime() + 30 * 60 * 1000);
    endTime = end.toISOString();
  }

  const eventPayload = {
    summary,
    description,
    start: { dateTime: startTime, timeZone: "Asia/Kolkata" },
    end: { dateTime: endTime, timeZone: "Asia/Kolkata" },
  };

  try {
    let res = await fetch(CALENDAR_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(eventPayload),
    });

    // If 401, try refreshing the token
    if (res.status === 401) {
      const body = await req.json().catch(() => ({}));
      const refreshToken = body.refresh_token;
      if (refreshToken) {
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
            res = await fetch(CALENDAR_URL, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${accessToken}`,
              },
              body: JSON.stringify(eventPayload),
            });
          }
        }
      }
    }

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      return new Response(JSON.stringify({ error: `google ${res.status}`, detail: errBody.slice(0, 500) }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }

    const event = await res.json();
    return new Response(
      JSON.stringify({ success: true, eventId: event.id, htmlLink: event.htmlLink }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}