// /api/auth — Initiate Google OAuth for Calendar access
// Vercel Edge Runtime
// Redirects the user to Google's consent screen.

export const config = { runtime: "edge", regions: ["iad1"] };

export default async function handler(req) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return new Response("GOOGLE_CLIENT_ID not configured", { status: 500 });
  }

  const host = req.headers.get("host") || "localhost:3000";
  const protocol = host.includes("localhost") ? "http" : "https";
  const redirectUri = `${protocol}://${host}/api/auth-callback`;

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/calendar.events",
    access_type: "offline",
    prompt: "consent",
    state: "/",
  });

  return Response.redirect(
    `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
    302
  );
}