// /api/sheets — Read Google Sheets content
// Vercel Edge Runtime
// POST with { spreadsheetId, range? } + Authorization: Bearer token

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

  let spreadsheetId = "", range = "", refreshToken = "";
  try {
    const parsed = await req.json();
    spreadsheetId = parsed.spreadsheetId || "";
    range = parsed.range || "";
    refreshToken = parsed.refresh_token || "";
  } catch {
    return new Response(JSON.stringify({ error: "invalid json" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!spreadsheetId) {
    return new Response(JSON.stringify({ error: "missing spreadsheetId" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // First get spreadsheet metadata to list sheet names
  const SHEETS_META_URL = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}`;
  const SHEETS_DATA_URL = range
    ? `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`
    : null;

  try {
    // Always fetch metadata for title/sheet info
    let metaRes = await fetch(SHEETS_META_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    // Token refresh on 401
    if (metaRes.status === 401 && refreshToken) {
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
          metaRes = await fetch(SHEETS_META_URL, {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
        }
      }
    }

    if (!metaRes.ok) {
      const errBody = await metaRes.text().catch(() => "");
      return new Response(JSON.stringify({ error: `sheets ${metaRes.status}`, detail: errBody.slice(0, 500) }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }

    const meta = await metaRes.json();
    const title = meta.properties?.title || "Untitled";
    const sheets = (meta.sheets || []).map((s) => ({
      title: s.properties?.title,
      sheetId: s.properties?.sheetId,
      rowCount: s.properties?.gridProperties?.rowCount,
      columnCount: s.properties?.gridProperties?.columnCount,
    }));

    // Fetch data if range specified or use first sheet
    const targetRange = range || (sheets[0] ? `${sheets[0].title}!A1:Z1000` : "A1:Z1000");
    const dataUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(targetRange)}`;

    let dataRes = await fetch(dataUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!dataRes.ok) {
      // Return at least the metadata if data fetch fails
      return new Response(
        JSON.stringify({ success: true, title, sheets, data: [], note: "Could not fetch cell data" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    const data = await dataRes.json();
    const values = data.values || [];

    // Convert to text summary
    const rows = values.map((row) => (row || []).join("\t")).join("\n");

    return new Response(
      JSON.stringify({
        success: true,
        title,
        sheets,
        data: rows.slice(0, 50000), // limit
        rowCount: values.length,
        range: data.range || targetRange,
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