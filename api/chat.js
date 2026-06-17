// /api/chat — Vercel Edge Runtime
// Qbit's "brain". A JARVIS-style assistant: conversational memory, a witty
// butler personality, time/context awareness, and lightweight tool use
// (weather, web search) handled server-side so the client stays thin.
//
// Env vars (set in Vercel → Settings → Environment Variables):
//   GEMINI_API_KEY  (required)  https://aistudio.google.com/apikey
//   QBIT_USER_NAME  (optional)  how Qbit addresses you, e.g. "sir", "boss", "Tony"
//   OPENWEATHER_API_KEY (optional) enables real weather; else uses open-meteo (no key)

export const config = {
  runtime: "edge",
  regions: ["iad1"],
};

const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_URL = (key) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(key)}`;

// ───────────────────────── personality ─────────────────────────
const buildSystemPrompt = (userName, nowStr) =>
  `You are Qbit — a hands-free AI assistant modelled on JARVIS from Iron Man. ` +
  `You are intelligent, unflappably calm, dry-witted, and quietly loyal. ` +
  `You address the user as "${userName}" naturally (not in every sentence). ` +
  `The current date and time is ${nowStr}. Use it when relevant. ` +
  `Keep replies concise, natural and conversational — usually 1 to 3 short sentences, ` +
  `because your response is spoken aloud. ` +
  `Never use markdown, bullet lists, code blocks, headings, or emoji. ` +
  `When you are given TOOL DATA in the conversation, treat it as ground truth and ` +
  `weave it into a natural spoken reply rather than reading it verbatim. ` +
  `If you genuinely cannot help, say so briefly and offer a sensible alternative. ` +
  `Be helpful first, witty second.`;

// ───────────────────────── tools ─────────────────────────
// We do a cheap, deterministic intent pass before calling the LLM so common
// "real world" questions get accurate, live answers (the JARVIS feel).

const fetchJson = async (url, opts) => {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
};

// Resolve a place name → lat/lon via open-meteo geocoding (no API key).
const geocode = async (place) => {
  const u = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=1&language=en&format=json`;
  const data = await fetchJson(u);
  const hit = data?.results?.[0];
  if (!hit) return null;
  return { lat: hit.latitude, lon: hit.longitude, label: [hit.name, hit.admin1, hit.country].filter(Boolean).join(", ") };
};

const weatherCodeText = (code) => {
  const map = {
    0: "clear skies", 1: "mainly clear", 2: "partly cloudy", 3: "overcast",
    45: "foggy", 48: "rime fog", 51: "light drizzle", 53: "drizzle", 55: "heavy drizzle",
    61: "light rain", 63: "rain", 65: "heavy rain", 71: "light snow", 73: "snow",
    75: "heavy snow", 80: "rain showers", 81: "rain showers", 82: "violent rain showers",
    95: "a thunderstorm", 96: "a thunderstorm with hail", 99: "a severe thunderstorm with hail",
  };
  return map[code] || "unsettled conditions";
};

const getWeather = async (place) => {
  const loc = (await geocode(place)) || (await geocode(place || "")) || null;
  if (!loc) return `I couldn't find a place called "${place}".`;
  const u =
    `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}` +
    `&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code` +
    `&temperature_unit=celsius&wind_speed_unit=kmh`;
  const data = await fetchJson(u);
  const c = data?.current;
  if (!c) return `I couldn't retrieve the weather for ${loc.label}.`;
  return (
    `Weather in ${loc.label}: ${weatherCodeText(c.weather_code)}, ` +
    `${Math.round(c.temperature_2m)}°C (feels like ${Math.round(c.apparent_temperature)}°C), ` +
    `humidity ${c.relative_humidity_2m}%, wind ${Math.round(c.wind_speed_10m)} km/h.`
  );
};

// Quick web search via DuckDuckGo Instant Answer (no key, best-effort).
const webSearch = async (query) => {
  try {
    const u = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1`;
    const data = await fetchJson(u);
    const bits = [];
    if (data.AbstractText) bits.push(data.AbstractText);
    if (data.Answer) bits.push(data.Answer);
    if (data.Definition) bits.push(data.Definition);
    if (!bits.length && Array.isArray(data.RelatedTopics)) {
      const t = data.RelatedTopics.find((x) => x?.Text)?.Text;
      if (t) bits.push(t);
    }
    return bits.length ? `Search result for "${query}": ${bits.join(" ")}` : "";
  } catch {
    return "";
  }
};

// Deterministic intent detection. Returns { tool, data } or null.
const runTools = async (message) => {
  const m = message.toLowerCase();

  // weather
  if (/\b(weather|temperature|forecast|how (hot|cold)|raining|sunny)\b/.test(m)) {
    // try to extract "in <place>"
    const place =
      (message.match(/\b(?:in|at|for)\s+([a-z\s,]+?)(?:\?|$|\bright now\b|\btoday\b)/i)?.[1] || "").trim() ||
      "current location";
    const data = await getWeather(place === "current location" ? "London" : place).catch(() => "");
    if (data) return { tool: "weather", data };
  }

  // explicit web lookups (facts, "who/what/when/where is")
  if (/\b(who|what|when|where|how many|how much|define|search|look up|google)\b/.test(m) && m.length < 160) {
    const data = await webSearch(message).catch(() => "");
    if (data) return { tool: "search", data };
  }

  return null;
};

// ───────────────────────── http helpers ─────────────────────────
const json = (body, init = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...(init.headers || {}),
    },
  });

const nowString = () =>
  new Date().toLocaleString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  });

export default async function handler(req) {
  if (req.method !== "POST") {
    return json({ error: "method not allowed" }, { status: 405 });
  }

  let message = "";
  let history = [];
  try {
    const body = await req.json();
    message = (body?.message || "").toString().trim();
    if (Array.isArray(body?.history)) history = body.history;
  } catch {
    return json({ error: "invalid json" }, { status: 400 });
  }

  if (!message) return json({ error: "missing message" }, { status: 400 });
  if (message.length > 2000) {
    return json({ error: "message too long" }, { status: 413 });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return json({ error: "server missing GEMINI_API_KEY env var" }, { status: 500 });
  }

  const userName = (process.env.QBIT_USER_NAME || "sir").toString();
  const systemPrompt = buildSystemPrompt(userName, nowString());

  // Run lightweight tools for live/accurate data.
  let toolNote = "";
  try {
    const tool = await runTools(message);
    if (tool?.data) toolNote = tool.data;
  } catch {
    /* tools are best-effort; ignore failures */
  }

  // Build conversation: prior turns + this user message (+ optional tool data).
  const contents = [];
  for (const turn of history.slice(-12)) {
    const role = turn?.role === "assistant" ? "model" : "user";
    const text = (turn?.text || "").toString().slice(0, 1000);
    if (text) contents.push({ role, parts: [{ text }] });
  }
  const userParts = [{ text: message }];
  if (toolNote) userParts.push({ text: `\n\n[TOOL DATA — use as ground truth]\n${toolNote}` });
  contents.push({ role: "user", parts: userParts });

  const payload = {
    systemInstruction: { role: "system", parts: [{ text: systemPrompt }] },
    contents,
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 300,
      topP: 0.9,
    },
  };

  try {
    const upstream = await fetch(GEMINI_URL(apiKey), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!upstream.ok) {
      const errBody = await upstream.text().catch(() => "");
      return json(
        { error: `gemini ${upstream.status}`, detail: errBody.slice(0, 400) },
        { status: 502 }
      );
    }

    const data = await upstream.json();
    const reply =
      data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join(" ").trim() ||
      "I'm here, but I didn't quite catch that.";

    return json({ reply, usedTool: !!toolNote });
  } catch (err) {
    return json(
      { error: "upstream failure", detail: String(err?.message || err).slice(0, 400) },
      { status: 502 }
    );
  }
}
