# Qbit v2 — JARVIS-Style Hands-Free AI Assistant

> *"At your service, sir."*

Qbit is a minimalist, futuristic, voice-first AI assistant designed for Vercel's free tier — reborn with a JARVIS-class brain. It understands context, remembers your conversation, and handles real-world queries on the fly.

---

## What Makes This JARVIS

| Feature | How Qbit does it |
|---|---|
| **Always-listening** | Continuous Web Speech recognition. Wake with "hey qbit". |
| **Conversation memory** | Rolling 16-turn history sent to Gemini. Ask follow-ups naturally. |
| **JARVIS personality** | Dry-wit, calm, loyal. Addresses you as "sir" (or custom name via `QBIT_USER_NAME`). |
| **Real-time weather** | Server-side geocoding + Open-Meteo (no API key needed). *"What's the weather in Tokyo?"* |
| **Web search** | DuckDuckGo instant answers (no key). *"Who was Ada Lovelace?"* |
| **Instant on-device skills** | Time, date, arithmetic, open sites (YouTube, GitHub, Gmail...), greetings — zero latency, no network call. |
| **Conversational mode** | Stays awake for ~12s after replying so you can ask follow-ups without re-waking. |
| **Clap detection** | Single clap = wake Qbit, double clap = open Gmail. Works via Web Audio API live audio analysis. |
| **Barge-in interruption** | Say "stop", "quiet", "enough" to interrupt Qbit mid-sentence. |
| **Sleep/dismiss** | *"That's all"*, *"stand down"*, *"go to sleep"* sends Qbit back to idle. |
| **Voice synthesis** | Browser-native TTS tuned slightly lower (calmer, butler-like). |
| **Pulsing orb UI** | CSS-only state animations: `idle` → `listening` → `processing` → `speaking` → `error`. |
| **Edge runtime** | All `/api/*` routes use Vercel Edge (`runtime: "edge"`, region: `iad1`). |
| **Zero framework cost** | Pure HTML/CSS/JS. No React, no build step, no heavy dependencies. |

---

## File Layout

```
/
├── api/
│   ├── chat.js        # Gemini chat + conversation memory + tools (weather, search)
│   └── google.js      # Google API stub w/ Cache-Control (extensible)
├── public/
│   ├── index.html
│   ├── style.css
│   └── js/app.js      # Client: wake-word, skills, memory, barge-in, voice
├── vercel.json
├── package.json
└── README.md
```

---

## Setup

1. **Push this repo to GitHub** and import into Vercel.
2. **In Vercel → Project → Settings → Environment Variables**, add:
   - `GEMINI_API_KEY` — get one free at https://aistudio.google.com/apikey
   - `QBIT_USER_NAME` — (optional) how Qbit addresses you, e.g. `sir`, `boss`, `Tony`
3. **Deploy.** Vercel will route `/api/*` to Edge functions in `iad1`.

### Optional: Weather tool
Weather uses [Open-Meteo](https://open-meteo.com/) — no API key required. It just works.

### Optional: Web search tool
Search uses [DuckDuckGo Instant Answer API](https://api.duckduckgo.com/) — no API key required. It just works.

---

## Local Dev

```bash
npm i -g vercel
vercel dev
```

Open `http://localhost:3000`, click **enable hands-free**, grant mic permission, and try:

> **"hey qbit, what's the weather in London?"**  
> **"hey qbit, who is the CEO of Tesla?"**  
> **"open youtube"**  
> **"what's 15 times 24?"**  
> **"stand down"**

---

## Voice & Gesture Commands Cheat Sheet

| Command | What happens |
|---|---|
| `hey qbit` | Wake the assistant |
| `what's the time?` | Instant local time (no network) |
| `what's the date?` | Instant local date |
| `open youtube` / `open github` | Opens the site in a new tab |
| `what's 24 times 7?` | Instant arithmetic |
| `what's the weather in Paris?` | Live weather via server tool |
| `who is Marie Curie?` | Web search via server tool |
| `thank you` | Quick courteous reply |
| `stop` / `quiet` / `enough` | Barge-in: interrupts speaking |
| `that's all` / `stand down` / `go to sleep` | Dismisses, returns to idle |
| *(just keep talking)* | Follow-ups work automatically for ~12s after a reply |
| 👏 Single clap | Wake Qbit (hands-free, no need to speak) |
| 👏👏 Double clap | Opens Gmail instantly |
| *(Space key)* | Push-to-talk keyboard fallback |
| *(Escape key)* | Stop speaking / dismiss |

---

## Browser Support

Wake-word detection requires the **Web Speech API**. Best on Chrome / Edge desktop & Android Chrome. Safari iOS has partial support — keyboard fallback (**Space** to ask, **Escape** to stop speaking) is provided.

---

## Cost Notes

- **Vercel**: single region (`iad1`), Edge runtime → minimal serverless invocations.
- **LLM**: Gemini 2.5 Flash has a generous free tier.
- **TTS**: browser-native, zero API cost.
- **Weather / Search**: free tier APIs, no keys required.
</｜｜DSML｜｜parameter>
<task_progress>
- [x] Explore the existing codebase
- [x] Understand current functionality
- [x] Upgrade backend: memory, JARVIS personality, time/context awareness
- [x] Add skills/intents (weather, search)
- [x] Add client-side instant skills (time, date, open sites, math)
- [x] Upgrade frontend: conversational loop, barge-in, follow-ups, voice
- [x] Update index.html branding + README + .env.example
- [ ] Verify results
</task_progress>
</write_to_file>
