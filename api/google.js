// /api/google — Vercel Edge Runtime
// Example Google API proxy route demonstrating Cache-Control to prevent
// unnecessary serverless invocations.
//   s-maxage=60          → CDN caches the response for 60s
//   stale-while-revalidate=30 → CDN can serve stale for +30s while revalidating
//
// Add similar headers to every Google-backed route you add (search, calendar, etc.)

export const config = {
  runtime: "edge",
  regions: ["iad1"],
};

const CACHE_HEADERS = {
  "Cache-Control": "public, s-maxage=60, stale-while-revalidate=30",
  "Content-Type": "application/json",
};

export default async function handler(req) {
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") || "").trim();

  if (!q) {
    return new Response(JSON.stringify({ error: "missing q param" }), {
      status: 400,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  // Stub response — replace the body of this try block with a real Google API call
  // (Custom Search, Calendar, Gmail, etc.) using process.env.GOOGLE_API_KEY.
  try {
    const payload = {
      query: q,
      results: [
        { title: "Qbit example result", snippet: "Replace this stub with a real Google API call." },
      ],
      cachedAt: new Date().toISOString(),
    };
    return new Response(JSON.stringify(payload), { status: 200, headers: CACHE_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err?.message || err) }), {
      status: 502,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }
}
