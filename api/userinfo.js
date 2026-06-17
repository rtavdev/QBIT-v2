// /api/userinfo — Get Google user profile info (email, name)
// Vercel Edge Runtime

export const config = { runtime: "edge", regions: ["iad1"] };

const TOKEN_URL = "https://oauth2.googleapis.com/token";

export default async function handler(req) {
  if (req.method !== "GET") {
    return new Response(JSON.stringify({ error: "method not allowed" }), { status: 405, headers: { "Content-Type": "application/json" } });
  }

  const authHeader = req.headers.get("Authorization") || "";
  let accessToken = authHeader.replace(/^Bearer\s+/i, "");

  if (!accessToken) {
    return new Response(JSON.stringify({ error: "missing access token" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }

  try {
    const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) {
      const err = await res.text().catch(() => "");
      return new Response(JSON.stringify({ error: `userinfo ${res.status}`, detail: err.slice(0, 500) }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }

    const data = await res.json();
    return new Response(
      JSON.stringify({ success: true, email: data.email, name: data.name, picture: data.picture }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}