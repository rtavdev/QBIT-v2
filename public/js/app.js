/* Qbit — JARVIS-style hands-free client controller
 * Capabilities:
 *  - Continuous Web Speech recognition + local wake-word ("hey qbit")
 *  - Conversational mode: stays awake for follow-ups after replying
 *  - Conversation memory sent to /api/chat for contextual answers
 *  - Instant on-device skills: time, date, open sites, math, greetings, stop
 *  - Barge-in: starts listening / can be interrupted while speaking
 *  - JARVIS voice tuning + acknowledgement chimes
 * No frameworks. No build step. Pure ES module-friendly script.
 */

(() => {
  "use strict";

  // ───────────────────────── config ─────────────────────────
  const WAKE_PHRASES = [
    "hey qbit", "hey q bit", "hey q-bit", "hey cubit", "hey kewbit",
    "hey qubit", "hi qbit", "ok qbit", "okay qbit", "qbit", "cubit", "qubit",
  ];
  const SLEEP_PHRASES = [
    "go to sleep", "stand down", "that's all", "thats all", "thank you that's all",
    "goodbye", "good bye", "stop listening", "dismiss",
  ];
  const STOP_PHRASES = ["stop", "quiet", "shut up", "enough", "cancel", "be quiet"];

  const QUERY_TIMEOUT_MS = 5000;        // silence ends a query window
  const FOLLOWUP_WINDOW_MS = 12000;     // stay conversational this long after a reply
  const POST_RESPONSE_COOLDOWN = 350;   // ms before resuming listen after TTS

  const ACK_PHRASES = ["Yes?", "Listening.", "Go ahead.", "At your service.", "Mm-hm?"];

  // ───────────────────────── dom refs ─────────────────────────
  const body       = document.body;
  const stateLabel = document.querySelector('[data-testid="state-label"]');
  const stateHint  = document.querySelector('[data-testid="state-hint"]');
  const micStatus  = document.querySelector('[data-testid="mic-status"]');
  const userText   = document.querySelector('[data-testid="user-text"]');
  const botText    = document.querySelector('[data-testid="bot-text"]');
  const enableBtn  = document.querySelector('[data-testid="enable-btn"]');

  // ───────────────────────── state ─────────────────────────
  /** @type {"idle"|"listening"|"processing"|"speaking"|"error"} */
  let appState = "idle";
  let recognition = null;
  let recognitionRunning = false;
  let awaitingQuery = false;
  let conversational = false;            // true while in an active conversation
  let conversationTimer = null;
  let queryBuffer = "";
  let queryTimer = null;

  /** rolling memory: [{role:"user"|"assistant", text}] */
  const history = [];
  const HISTORY_MAX = 16;
  const pushHistory = (role, text) => {
    history.push({ role, text });
    while (history.length > HISTORY_MAX) history.shift();
  };

  // ───────────────────────── helpers ─────────────────────────
  const setState = (s, hint) => {
    appState = s;
    body.dataset.state = s;
    stateLabel.textContent = s.toUpperCase();
    if (hint !== undefined) stateHint.textContent = hint;
  };

  const normalize = (s) =>
    s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

  const containsAny = (transcript, phrases) => {
    const n = normalize(transcript);
    return phrases.find((p) => n.includes(p)) || null;
  };

  const stripWake = (transcript) => {
    let n = normalize(transcript);
    for (const phrase of WAKE_PHRASES) {
      const idx = n.indexOf(phrase);
      if (idx !== -1) { n = n.slice(idx + phrase.length).trim(); break; }
    }
    return n;
  };

  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  // ───────────────────────── speech synthesis ─────────────────────────
  let voicesReady = false;
  const pickVoice = () => {
    const voices = window.speechSynthesis.getVoices();
    return (
      voices.find((v) => /en-GB/i.test(v.lang) && /Daniel|Google UK English Male|Arthur/i.test(v.name)) ||
      voices.find((v) => /Google (US|UK) English/i.test(v.name)) ||
      voices.find((v) => /en-(US|GB)/i.test(v.lang) && /Male|Daniel|Microsoft|Google/i.test(v.name)) ||
      voices.find((v) => /^en/i.test(v.lang)) ||
      voices[0]
    );
  };

  const speak = (text) => new Promise((resolve) => {
    if (!("speechSynthesis" in window) || !text) return resolve();
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.0;
      u.pitch = 0.9;     // slightly lower = calmer, butler-like
      u.volume = 1.0;
      const v = pickVoice();
      if (v) u.voice = v;
      setState("speaking", "speaking...");
      u.onend = () => resolve();
      u.onerror = () => resolve();
      window.speechSynthesis.speak(u);
    } catch (e) {
      console.error("[qbit] tts error", e);
      resolve();
    }
  });

  const stopSpeaking = () => {
    try { window.speechSynthesis.cancel(); } catch {}
  };

  // ───────────────────────── on-device skills ─────────────────────────
  // Return a string reply if handled locally, else null → goes to the LLM.
  const KNOWN_SITES = {
    youtube: "https://youtube.com", google: "https://google.com",
    gmail: "https://mail.google.com", maps: "https://maps.google.com",
    github: "https://github.com", twitter: "https://twitter.com",
    "x": "https://x.com", reddit: "https://reddit.com",
    wikipedia: "https://wikipedia.org", spotify: "https://open.spotify.com",
    netflix: "https://netflix.com", chatgpt: "https://chat.openai.com",
  };

  const localSkill = (q) => {
    const m = normalize(q);

    if (!m) return null;

    // time / date
    if (/\b(what.?s? the time|what time is it|current time|the time)\b/.test(m)) {
      const t = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      return `It's ${t}.`;
    }
    if (/\b(what.?s? the date|what.?s? today|today.?s date|what day is it)\b/.test(m)) {
      const d = new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: "numeric" });
      return `Today is ${d}.`;
    }

    // open a website
    const openMatch = m.match(/\b(?:open|launch|go to|pull up|bring up)\s+([a-z0-9.\s]+)/);
    if (openMatch) {
      const target = openMatch[1].trim().replace(/\s+/g, "");
      const key = Object.keys(KNOWN_SITES).find((k) => target.includes(k));
      if (key) {
        window.open(KNOWN_SITES[key], "_blank", "noopener");
        return `Opening ${key}.`;
      }
      if (/\.[a-z]{2,}$/.test(target)) {
        window.open(`https://${target}`, "_blank", "noopener");
        return `Opening ${target}.`;
      }
    }

    // simple arithmetic: "what is 12 times 8", "calculate 45 / 9"
    const mathMatch = m.match(/\b(?:what.?s|what is|calculate|compute)?\s*([0-9.\s]+(?:plus|minus|times|multiplied by|divided by|x|\+|\-|\*|\/)[0-9.\s]+)/);
    if (mathMatch) {
      const expr = mathMatch[1]
        .replace(/plus/g, "+").replace(/minus/g, "-")
        .replace(/multiplied by|times|x/g, "*").replace(/divided by/g, "/");
      if (/^[\d\s+\-*/.]+$/.test(expr)) {
        try {
          // eslint-disable-next-line no-new-func
          const val = Function(`"use strict";return (${expr})`)();
          if (Number.isFinite(val)) return `That's ${Math.round(val * 1e6) / 1e6}.`;
        } catch {}
      }
    }

    // greetings / identity
    if (/\b(hello|hey|hi)\b/.test(m) && m.length < 16) return "Hello. How can I help?";
    if (/\b(who are you|what are you|your name)\b/.test(m)) {
      return "I'm Qbit, your hands-free assistant. Think of me as your JARVIS.";
    }
    if (/\b(thank you|thanks|cheers)\b/.test(m) && m.length < 20) return "Always a pleasure.";

    return null;
  };

  // ───────────────────────── api ─────────────────────────
  const askQbit = async (message) => {
    setState("processing", "thinking...");
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, history: history.slice(-12) }),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`api ${res.status}: ${errText || res.statusText}`);
      }
      const data = await res.json();
      return data.reply || "I didn't catch a response.";
    } catch (err) {
      console.error("[qbit] chat error", err);
      return "I'm having trouble reaching my brain at the moment. Do try me again shortly.";
    }
  };

  // ───────────────────────── conversation lifecycle ─────────────────────────
  const enterConversation = () => {
    conversational = true;
    clearTimeout(conversationTimer);
    conversationTimer = setTimeout(() => {
      conversational = false;
      setState("idle", 'say "hey qbit" to wake me');
    }, FOLLOWUP_WINDOW_MS);
  };

  const finalizeQuery = async () => {
    clearTimeout(queryTimer);
    awaitingQuery = false;
    const q = queryBuffer.trim();
    queryBuffer = "";
    if (!q) {
      setState(conversational ? "listening" : "idle",
        conversational ? "still here..." : 'say "hey qbit" to wake me');
      if (conversational) beginQueryCapture("");
      return;
    }

    userText.textContent = q;
    pushHistory("user", q);

    // sleep command?
    if (containsAny(q, SLEEP_PHRASES)) {
      conversational = false;
      clearTimeout(conversationTimer);
      const bye = pick(["Standing down.", "Very good. I'll be here.", "Going quiet."]);
      botText.textContent = bye;
      pushHistory("assistant", bye);
      await speak(bye);
      setTimeout(() => setState("idle", 'say "hey qbit" to wake me'), POST_RESPONSE_COOLDOWN);
      return;
    }

    // try an instant on-device skill first
    let reply = localSkill(q);
    if (reply == null) reply = await askQbit(q);

    botText.textContent = reply;
    pushHistory("assistant", reply);
    await speak(reply);

    // stay conversational for natural follow-ups
    enterConversation();
    setTimeout(() => {
      if (conversational) { setState("listening", "anything else?"); beginQueryCapture(""); }
      else setState("idle", 'say "hey qbit" to wake me');
    }, POST_RESPONSE_COOLDOWN);
  };

  const armQueryTimer = () => {
    clearTimeout(queryTimer);
    queryTimer = setTimeout(finalizeQuery, QUERY_TIMEOUT_MS);
  };

  const beginQueryCapture = (leftover) => {
    awaitingQuery = true;
    queryBuffer = "";
    setState("listening", "ask me anything...");
    userText.textContent = "—";
    if (leftover && leftover.length > 1) {
      queryBuffer = leftover;
      userText.textContent = leftover;
    }
    armQueryTimer();
  };

  const wakeUp = (leftover) => {
    enterConversation();
    if (!leftover || leftover.length < 2) {
      const ack = pick(ACK_PHRASES);
      botText.textContent = ack;
      speak(ack).then(() => { setState("listening", "ask me anything..."); beginQueryCapture(""); });
    } else {
      beginQueryCapture(leftover);
    }
  };

  // ───────────────────────── recognition wiring ─────────────────────────
  const buildRecognition = () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return null;
    const r = new SR();
    r.continuous = true;
    r.interimResults = true;
    r.lang = navigator.language?.startsWith("en") ? navigator.language : "en-US";
    return r;
  };

  const startRecognition = () => {
    if (!recognition || recognitionRunning) return;
    try { recognition.start(); }
    catch (e) { console.warn("[qbit] recognition.start()", e?.message); }
  };

  const initRecognition = () => {
    recognition = buildRecognition();
    if (!recognition) {
      setState("error", "this browser has no Web Speech API. try Chrome.");
      micStatus.textContent = "microphone: unsupported";
      enableBtn.hidden = true;
      return;
    }

    recognition.onstart = () => {
      recognitionRunning = true;
      micStatus.textContent = "microphone: on";
    };

    recognition.onerror = (e) => {
      console.warn("[qbit] recognition error", e.error);
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        setState("error", "microphone permission denied");
        micStatus.textContent = "microphone: denied";
        enableBtn.hidden = false;
      }
    };

    recognition.onend = () => {
      recognitionRunning = false;
      micStatus.textContent = "microphone: reconnecting...";
      if (appState !== "speaking") setTimeout(startRecognition, 250);
    };

    recognition.onresult = (event) => {
      let interim = "", finalChunk = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        const txt = res[0].transcript;
        if (res.isFinal) finalChunk += txt + " ";
        else interim += txt + " ";
      }
      const combined = (finalChunk + interim).trim();
      if (!combined) return;

      // barge-in: interrupt speaking if the user clearly says stop
      if (appState === "speaking" && containsAny(combined, STOP_PHRASES)) {
        stopSpeaking();
        setState("listening", "go ahead...");
        if (conversational) beginQueryCapture("");
        return;
      }

      if (awaitingQuery) {
        const cleaned = stripWake(combined);
        queryBuffer = cleaned || combined;
        userText.textContent = queryBuffer;
        if (finalChunk) armQueryTimer();
        return;
      }

      // not capturing → wake on wake-word, or accept directly if conversational
      const wake = containsAny(combined, WAKE_PHRASES);
      if (wake) {
        wakeUp(stripWake(combined));
      } else if (conversational && appState !== "speaking") {
        beginQueryCapture(combined);
      }
    };
  };

  // ───────────────────────── boot ─────────────────────────
  const requestMicAndStart = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
    } catch (e) {
      setState("error", "microphone permission denied");
      micStatus.textContent = "microphone: denied";
      return;
    }
    enableBtn.hidden = true;
    initRecognition();
    if (recognition) {
      startRecognition();
      const hello = "Qbit online. Say hey Qbit, or just start talking.";
      botText.textContent = hello;
      await speak(hello);
      setState("idle", 'say "hey qbit" to wake me');
    }
  };

  if ("speechSynthesis" in window) {
    window.speechSynthesis.onvoiceschanged = () => { voicesReady = true; pickVoice(); };
    pickVoice(); // warm voice list
  }

  enableBtn.addEventListener("click", requestMicAndStart);

  // Keyboard helpers: Space = push to talk; Esc = stop speaking
  document.addEventListener("keydown", (e) => {
    if (e.code === "Space" && !awaitingQuery && appState !== "processing") {
      e.preventDefault();
      enterConversation();
      beginQueryCapture("");
    }
    if (e.code === "Escape") {
      stopSpeaking();
      conversational = false;
      clearTimeout(conversationTimer);
      setState("idle", 'say "hey qbit" to wake me');
    }
  });

  setState("idle", 'tap "enable hands-free" to grant mic access');
})();
