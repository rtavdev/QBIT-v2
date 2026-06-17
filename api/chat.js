// /api/chat — Vercel Edge Runtime
// Qbit's "brain". A JARVIS-style assistant with automatic multi-API failover.
// Tries providers in order: Groq → Gemini → OpenAI.
// If one hits its rate limit (429) or errors out, it falls through to the next.
//
// Env vars (set in Vercel → Settings → Environment Variables):
//   GROQ_API_KEY       (recommended)  https://console.groq.com/keys
//   GEMINI_API_KEY      (optional)     https://aistudio.google.com/apikey
//   OPENAI_API_KEY      (optional)     https://platform.openai.com/api-keys
//   QBIT_USER_NAME      (optional)     how Qbit addresses you, e.g. "sir", "boss", "Tony"
//   OPENWEATHER_API_KEY (optional)     enables real weather; else uses open-meteo (no key)

export const config = {
  runtime: "edge",
  regions: ["iad1"],
};

// ───────────────────────── provider list ─────────────────────────
// Each provider has: name, buildPayload, callApi, extractReply
// The handler tries them in order until one succeeds.

const PROVIDERS = [];

// 1. Groq (free, recommended primary)
const groqKey = () => process.env.GROQ_API_KEY;
if (groqKey()) {
  PROVIDERS.push({
    name: "groq",
    buildPayload: (messages) => ({
      model: "llama-3.3-70b-versatile",
      messages,
      temperature: 0.7,
      max_tokens: 300,
      top_p: 0.9,
    }),
    callApi: async (payload) => {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${groqKey()}`,
        },
        body: JSON.stringify(payload),
      });
      return res;
    },
    extractReply: (data) => data?.choices?.[0]?.message?.content?.trim(),
  });
}

// 2. Gemini (free tier, optional fallback)
const geminiKey = () => process.env.GEMINI_API_KEY;
if (geminiKey()) {
  PROVIDERS.push({
    name: "gemini",
    buildPayload: (messages) => {
      // Gemini uses a different format: system instruction + contents array
      const systemMsg = messages.find((m) => m.role === "system");
      const rest = messages.filter((m) => m.role !== "system");
      const contents = rest.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));
      return {
        systemInstruction: systemMsg ? { role: "system", parts: [{ text: systemMsg.content }] } : undefined,
        contents,
        generationConfig: { temperature: 0.7, maxOutputTokens: 300, topP: 0.9 },
      };
    },
    callApi: async (payload) => {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(geminiKey())}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      return res;
    },
    extractReply: (data) =>
      data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join(" ").trim(),
  });
}

// 3. OpenAI (if user provides a key)
const openaiKey = () => process.env.OPENAI_API_KEY;
if (openaiKey()) {
  PROVIDERS.push({
    name: "openai",
    buildPayload: (messages) => ({
      model: "gpt-4o-mini",
      messages,
      temperature: 0.7,
      max_tokens: 300,
      top_p: 0.9,
    }),
    callApi: async (payload) => {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${openaiKey()}`,
        },
        body: JSON.stringify(payload),
      });
      return res;
    },
    extractReply: (data) => data?.choices?.[0]?.message?.content?.trim(),
  });
}

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
const fetchJson = async (url, opts) => {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
};

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

const runTools = async (message) => {
  const m = message.toLowerCase();
  if (/\b(weather|temperature|forecast|how (hot|cold)|raining|sunny)\b/.test(m)) {
    const place =
      (message.match(/\b(?:in|at|for)\s+([a-z\s,]+?)(?:\?|$|\bright now\b|\btoday\b)/i)?.[1] || "").trim() ||
      "current location";
    const data = await getWeather(place === "current location" ? "Navi Mumbai Vashi" : place).catch(() => "");
    if (data) return { tool: "weather", data };
  }
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

  if (PROVIDERS.length === 0) {
    return json({
      error: "no api keys configured",
      detail: "Set at least GROQ_API_KEY in Vercel env vars. Get a free key at https://console.groq.com/keys",
    }, { status: 500 });
  }

  const userName = (process.env.QBIT_USER_NAME || "sir").toString();
  const systemPrompt = buildSystemPrompt(userName, nowString());

  let toolNote = "";
  try {
    const tool = await runTools(message);
    if (tool?.data) toolNote = tool.data;
  } catch { /* best-effort */ }

  // Build conversation messages array (OpenAI/Groq format)
  const messages = [{ role: "system", content: systemPrompt }];
  for (const turn of history.slice(-12)) {
    const role = turn?.role === "assistant" ? "assistant" : "user";
    const text = (turn?.text || "").toString().slice(0, 1000);
    if (text) messages.push({ role, content: text });
  }
  let userContent = message;
  if (toolNote) userContent += `\n\n[TOOL DATA — use as ground truth]\n${toolNote}`;
  messages.push({ role: "user", content: userContent });

  // ───────────────────────── try providers in order ─────────────────────────
  const errors = [];

  for (const provider of PROVIDERS) {
    try {
      const payload = provider.buildPayload(messages);
      const res = await provider.callApi(payload);

      if (res.status === 429) {
        // Rate limited — skip to next provider
        errors.push(`${provider.name}: rate limited (429)`);
        continue;
      }

      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        errors.push(`${provider.name}: HTTP ${res.status} — ${errBody.slice(0, 200)}`);
        continue;
      }

      const data = await res.json();
      const reply = provider.extractReply(data);

      if (reply) {
        return json({ reply, usedTool: !!toolNote, provider: provider.name });
      }

      errors.push(`${provider.name}: empty response`);
    } catch (err) {
      errors.push(`${provider.name}: ${err?.message || "unknown error"}`);
    }
  }

  // All providers failed
  const detail = errors.length > 0
    ? errors.join(" | ")
    : "no providers configured — set GROQ_API_KEY in Vercel env vars";

  return json({ error: "all providers failed", detail }, { status: 502 });
}