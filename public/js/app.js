/* Qbit — Hands-free AI assistant client controller
 * Capabilities:
 *  - Continuous Web Speech recognition + local wake-word ("hey qbit")
 *  - Conversational mode: stays awake for follow-ups after replying
 *  - Conversation memory sent to /api/chat for contextual answers
 *  - Instant on-device skills: time, date, open sites, math, greetings, stop
 *  - Barge-in: starts listening / can be interrupted while speaking
 *  - Natural voice tuning + acknowledgement chimes
 *  - Clap detection: single clap = wake, double clap = open Gmail
 * No frameworks. No build step. Pure ES module-friendly script.
 * Mobile-optimized: uses device language for better recognition.
 */

(() => {
  "use strict";

  // ───────────────────────── config ─────────────────────────
  const WAKE_PHRASES = [
    "hey qbit", "hey q bit", "hey q-bit", "hey cubit", "hey kewbit",
    "hey qubit", "hi qbit", "ok qbit", "okay qbit", "qbit", "cubit", "qubit",
  ];
  const SLEEP_PHRASES = [
    "go to sleep", "stand down", "shut down", "shutdown", "that's all", "thats all", "thank you that's all",
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
  const textInput  = document.querySelector('[data-testid="text-input"]');
  const sendBtn    = document.querySelector('[data-testid="send-btn"]');

  // ───────────────────────── state ─────────────────────────
  let appState = "idle";
  let recognition = null;
  let recognitionRunning = false;
  let awaitingQuery = false;
  let conversational = false;
  let conversationTimer = null;
  let queryBuffer = "";
  let queryTimer = null;
  let postSpeechBuffer = "";
  let postSpeechProcessed = false;
  let userEmail = "";
  let privacyMode = "medium";
  let clapDetector = null;

  const history = [];
  const HISTORY_MAX = 16;
  const pushHistory = (role, text) => {
    history.push({ role, text });
    while (history.length > HISTORY_MAX) history.shift();
  };

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

  // ───────────────────────── clap detection ─────────────────────────
  let clapStream = null;
  let clapAudioCtx = null;
  let clapAnalyser = null;
  let lastClapTime = 0;
  const CLAP_COOLDOWN_MS = 800;
  const DOUBLE_CLAP_WINDOW_MS = 700;

  const initClapDetection = (stream) => {
    try {
      clapStream = stream;
      clapAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const source = clapAudioCtx.createMediaStreamSource(stream);
      const filter = clapAudioCtx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 4000;
      clapAnalyser = clapAudioCtx.createAnalyser();
      clapAnalyser.fftSize = 256;
      clapAnalyser.smoothingTimeConstant = 0.3;
      source.connect(filter);
      filter.connect(clapAnalyser);
      const bufferLength = clapAnalyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);
      let prevAvg = 0;
      let clapLock = false;
      let lockTimer = null;
      const detect = () => {
        if (!clapAnalyser) return;
        clapAnalyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < bufferLength; i++) sum += dataArray[i];
        const avg = sum / bufferLength;
        const noiseFloor = Math.max(prevAvg, 15);
        const spike = avg - noiseFloor;
        if (spike > 40 && !clapLock && avg > 50) {
          clapLock = true;
          clearTimeout(lockTimer);
          lockTimer = setTimeout(() => { clapLock = false; }, 200);
          const now = Date.now();
          const gap = now - lastClapTime;
          if (gap > CLAP_COOLDOWN_MS && gap < DOUBLE_CLAP_WINDOW_MS) {
            lastClapTime = 0;
            onDoubleClap();
          } else if (gap >= DOUBLE_CLAP_WINDOW_MS) {
            lastClapTime = now;
            setTimeout(() => {
              if (lastClapTime === now) {
                lastClapTime = 0;
                onSingleClap();
              }
            }, DOUBLE_CLAP_WINDOW_MS + 50);
          }
        }
        prevAvg = avg * 0.7 + (prevAvg || avg) * 0.3;
        requestAnimationFrame(detect);
      };
      detect();
    } catch (e) {
      console.warn("[qbit] clap detection unavailable", e);
    }
  };

  const onSingleClap = () => {
    if (appState === "processing" || appState === "speaking") return;
    if (!conversational || appState === "idle") {
      setState("listening", "clap detected");
      enterConversation();
      const ack = pick(["Yes?", "I heard that.", "Go ahead."]);
      botText.textContent = ack;
      speak(ack).then(() => {
        setState("listening", "ask me anything...");
        beginQueryCapture("");
      });
    }
  };

  const onDoubleClap = () => {
    setState("processing", "opening mail...");
    const msg = "Opening Gmail.";
    botText.textContent = msg;
    speak(msg);
    window.open("https://mail.google.com", "_blank", "noopener");
    setTimeout(() => {
      if (conversational) setState("listening", "anything else?");
      else setState("idle", 'say "hey qbit" to wake me');
    }, POST_RESPONSE_COOLDOWN + 600);
  };

  // ───────────────────────── speech synthesis ─────────────────────────
  const pickVoice = () => {
    const voices = window.speechSynthesis.getVoices();
    const deviceLang = (navigator.language || "en-US").toLowerCase();
    return (
      voices.find((v) => v.lang.toLowerCase() === deviceLang) ||
      voices.find((v) => v.lang.toLowerCase().startsWith(deviceLang.split("-")[0])) ||
      voices.find((v) => /en-(US|GB|IN)/i.test(v.lang)) ||
      voices.find((v) => /^en/i.test(v.lang)) ||
      voices[0]
    );
  };

  const speak = (text) => new Promise((resolve) => {
    if (!("speechSynthesis" in window) || !text) return resolve();
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 0.9;
      u.pitch = 1.0;
      u.volume = 1.0;
      const v = pickVoice();
      if (v) u.voice = v;
      setState("speaking", "speaking...");
      u.onend = () => {
        const buffered = postSpeechBuffer;
        postSpeechBuffer = "";
        if (buffered && conversational) {
          postSpeechProcessed = true;
          beginQueryCapture(buffered);
        }
        resolve();
      };
      u.onerror = () => {
        const buffered = postSpeechBuffer;
        postSpeechBuffer = "";
        if (buffered && conversational) {
          postSpeechProcessed = true;
          beginQueryCapture(buffered);
        }
        resolve();
      };
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
  const KNOWN_SITES = {
    youtube: "https://youtube.com", google: "https://google.com",
    gmail: "https://mail.google.com", maps: "https://maps.google.com",
    github: "https://github.com", twitter: "https://twitter.com",
    "x": "https://x.com", reddit: "https://reddit.com",
    wikipedia: "https://wikipedia.org", spotify: "https://open.spotify.com",
    netflix: "https://netflix.com", chatgpt: "https://chat.openai.com",
  };

  // ───────────────────────── privacy killswitch ─────────────────────────
  const isRestricted = (resource) => {
    if (privacyMode === "kill") return true;
    if (privacyMode === "high" && (resource === "email" || resource === "docs" || resource === "sheets")) return true;
    if (privacyMode === "medium" && (resource === "docs" || resource === "sheets")) return true;
    return false;
  };

  const handlePrivacyCommand = (m) => {
    let result = null;
    if (/\b(kill switch|privacy kill|lock down|lockdown|maximum privacy)\b/.test(m)) {
      privacyMode = "kill";
      postSpeechBuffer = "";
      result = "Privacy killswitch activated. I will not process any personal data until you disable it.";
    } else if (/\b(kill switch off|disable kill switch|unlock|remove restrictions)\b/.test(m)) {
      privacyMode = "low";
      result = "Privacy restrictions lifted. Full access restored.";
    } else if (/\bprivacy (high|maximum)\b/.test(m)) {
      privacyMode = "high";
      result = "Privacy set to high. Email, docs, and sheets are blocked. Calendar and weather still work.";
    } else if (/\bprivacy medium\b/.test(m)) {
      privacyMode = "medium";
      result = "Privacy set to medium. Docs and sheets are blocked. Email and calendar still work.";
    } else if (/\bprivacy low|disable restrictions\b/.test(m)) {
      privacyMode = "low";
      result = "Privacy set to low. All features are available.";
    }
    if (result) setTimeout(updatePrivacyIndicator, 10);
    return result;
  };

  const guardSkill = (fn, resource) => async (q) => {
    if (isRestricted(resource)) return null;
    return fn(q);
  };

  const localSkill = (q) => {
    const m = normalize(q);
    if (!m) return null;

    if (/\b(what.?s? the time|what time is it|current time|the time)\b/.test(m)) {
      const t = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      return `It's ${t}.`;
    }
    if (/\b(what.?s? the date|what.?s? today|today.?s date|what day is it)\b/.test(m)) {
      const d = new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: "numeric" });
      return `Today is ${d}.`;
    }
    if (/\b(what.?s? the day|what day is)\b/.test(m)) {
      const d = new Date().toLocaleDateString([], { weekday: "long" });
      return `It's ${d}.`;
    }

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

    if (/\b(?:open|check|read)\s*(?:my\s*)?(?:mail|email|gmail|inbox)\b/.test(m)) {
      window.open("https://mail.google.com", "_blank", "noopener");
      return "Opening Gmail.";
    }

    const mathMatch = m.match(/\b(?:what.?s|what is|calculate|compute)?\s*([0-9.\s]+(?:plus|minus|times|multiplied by|divided by|x|\+|\-|\*|\/)[0-9.\s]+)/);
    if (mathMatch) {
      const expr = mathMatch[1]
        .replace(/plus/g, "+").replace(/minus/g, "-")
        .replace(/multiplied by|times|x/g, "*").replace(/divided by/g, "/");
      if (/^[\d\s+\-*/.]+$/.test(expr)) {
        try {
          const val = Function(`"use strict";return (${expr})`)();
          if (Number.isFinite(val)) return `That's ${Math.round(val * 1e6) / 1e6}.`;
        } catch {}
      }
    }

    const privacyResult = handlePrivacyCommand(m);
    if (privacyResult) return privacyResult;

    if (privacyMode === "kill") {
      if (/\b(what.?s? the time|what time is it|current time|the time)\b/.test(m)) {
        const t = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
        return `It's ${t}.`;
      }
      if (/\b(what.?s? the date|what.?s? today|today.?s date|what day is it)\b/.test(m)) {
        const d = new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: "numeric" });
        return `Today is ${d}.`;
      }
      if (/\b(hello|hey|hi)\b/.test(m) && m.length < 16) return `Killswitch active. I can't process requests right now.`;
      return `Privacy killswitch is active. Nothing is being logged or processed. Say "disable kill switch" to restore full access.`;
    }

    if (/\b(hello|hey|hi)\b/.test(m) && m.length < 16) return "Hello. How can I help?";
    if (/\b(who are you|what are you|your name)\b/.test(m)) {
      return "I'm Qbit, your hands-free assistant.";
    }
    if (/\b(thank you|thanks|cheers)\b/.test(m) && m.length < 20) return "Always a pleasure.";

    if (/\b(who am i|what.?s my email|my email address|my email)\b/.test(m)) {
      const token = getGoogleToken();
      if (!token || !token.access_token) return "I need you to connect your Google account first.";
      return null;
    }

    return null;
  };

  // ───────────────────────── Google Calendar ─────────────────────────
  const getGoogleToken = () => {
    try {
      const raw = localStorage.getItem("qbit_google_token");
      if (!raw) return null;
      return JSON.parse(raw);
    } catch { return null; }
  };

  const parseClockTime = (str) => {
    if (!str) return null;
    const s = str.trim().toLowerCase();
    const hour12 = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
    if (hour12) {
      let h = parseInt(hour12[1]);
      const m = hour12[2] ? parseInt(hour12[2]) : 0;
      const mer = hour12[3];
      if (mer === "pm" && h !== 12) h += 12;
      if (mer === "am" && h === 12) h = 0;
      return { hours: h, minutes: m };
    }
    const hour24 = s.match(/^(\d{1,2}):(\d{2})$/);
    if (hour24) return { hours: parseInt(hour24[1]), minutes: parseInt(hour24[2]) };
    if (s === "noon") return { hours: 12, minutes: 0 };
    if (s === "midnight") return { hours: 0, minutes: 0 };
    return null;
  };

  const parseTime = (timeStr) => {
    const now = new Date();
    const s = timeStr.toLowerCase().trim();
    const inMatch = s.match(/^in\s+(\d+)\s*(minute|minutes|hour|hours|min|mins|hr|hrs)\s*$/);
    if (inMatch) {
      const n = parseInt(inMatch[1]);
      const unit = inMatch[2];
      if (unit.startsWith("min")) now.setMinutes(now.getMinutes() + n);
      else now.setHours(now.getHours() + n);
      return now;
    }
    const tomorrowMatch = s.match(/^tomorrow(?:\s+at\s+|\s+)?(.+)?$/);
    if (tomorrowMatch) {
      const d = new Date(now);
      d.setDate(d.getDate() + 1);
      if (tomorrowMatch[1]) {
        const t = parseClockTime(tomorrowMatch[1]);
        d.setHours(t.hours, t.minutes, 0, 0);
      } else d.setHours(9, 0, 0, 0);
      return d;
    }
    const nextDayMatch = s.match(/^next\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+at\s+|\s+)?(.+)?$/);
    if (nextDayMatch) {
      const days = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
      const targetDay = days.indexOf(nextDayMatch[1]);
      const d = new Date(now);
      let diff = targetDay - d.getDay();
      if (diff <= 0) diff += 7;
      d.setDate(d.getDate() + diff);
      if (nextDayMatch[2]) {
        const t = parseClockTime(nextDayMatch[2]);
        d.setHours(t.hours, t.minutes, 0, 0);
      } else d.setHours(9, 0, 0, 0);
      return d;
    }
    const dayMatch = s.match(/^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+at\s+|\s+)?(.+)?$/);
    if (dayMatch) {
      const days = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
      const targetDay = days.indexOf(dayMatch[1]);
      const d = new Date(now);
      let diff = targetDay - d.getDay();
      if (diff <= 0) diff += 7;
      d.setDate(d.getDate() + diff);
      if (dayMatch[2]) {
        const t = parseClockTime(dayMatch[2]);
        d.setHours(t.hours, t.minutes, 0, 0);
      } else d.setHours(9, 0, 0, 0);
      return d;
    }
    const atMatch = s.match(/^at\s+(.+)/);
    if (atMatch) {
      const t = parseClockTime(atMatch[1]);
      const d = new Date(now);
      if (t.hours < d.getHours() || (t.hours === d.getHours() && t.minutes <= d.getMinutes())) d.setDate(d.getDate() + 1);
      d.setHours(t.hours, t.minutes, 0, 0);
      return d;
    }
    const t = parseClockTime(s);
    if (t) {
      const d = new Date(now);
      if (t.hours < d.getHours() || (t.hours === d.getHours() && t.minutes <= d.getMinutes())) d.setDate(d.getDate() + 1);
      d.setHours(t.hours, t.minutes, 0, 0);
      return d;
    }
    now.setHours(now.getHours() + 1);
    return now;
  };

  const parseEventFromQuery = (query) => {
    const m = query.toLowerCase().trim();
    let summary = "";
    let dateTime = null;
    const remindMatch = m.match(/remind\s+(?:me|us)\s+to\s+(.+?)(?:\s+(?:at|for|by)\s+(.+))?$/);
    if (remindMatch) {
      summary = remindMatch[1].charAt(0).toUpperCase() + remindMatch[1].slice(1);
      dateTime = parseTime(remindMatch[2] || "in 1 hour");
      return { summary, dateTime };
    }
    const scheduleMatch = m.match(/schedule\s+(?:a\s+|an\s+)?(.+?)(?:\s+(?:for|on|at)\s+(.+))?$/);
    if (scheduleMatch) {
      summary = scheduleMatch[1].charAt(0).toUpperCase() + scheduleMatch[1].slice(1);
      dateTime = parseTime(scheduleMatch[2] || "tomorrow at 9am");
      return { summary, dateTime };
    }
    const addMatch = m.match(/add\s+(.+?)(?:\s+to\s+(?:my\s+)?calendar)?(?:\s+(?:for|on|at)\s+(.+))?$/);
    if (addMatch) {
      summary = addMatch[1].charAt(0).toUpperCase() + addMatch[1].slice(1);
      dateTime = parseTime(addMatch[2] || "tomorrow at 9am");
      return { summary, dateTime };
    }
    return null;
  };

  const getTokenWithRefresh = () => {
    const token = getGoogleToken();
    if (!token || !token.access_token) return null;
    return token;
  };

  const fetchWithAuth = async (url, body) => {
    const token = getTokenWithRefresh();
    if (!token) return { error: "not_authenticated" };
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token.access_token}`,
      },
      body: JSON.stringify({ ...body, refresh_token: token.refresh_token || "" }),
    });
    if (res.status === 401) return { error: "token_expired" };
    return res.json();
  };

  // ───────────────────────── Google Workspace skills ─────────────────────────
  const getUserInfo = async () => {
    const token = getTokenWithRefresh();
    if (!token) return null;
    try {
      const res = await fetch("/api/userinfo", {
        headers: { Authorization: `Bearer ${token.access_token}` },
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (data.success) {
        userEmail = data.email;
        return data;
      }
    } catch {}
    return null;
  };

  const sendEmailSkill = async (q) => {
    const m = q.toLowerCase().trim();
    const emailMatch = m.match(/^(?:send\s+(?:an?\s+)?email|email)\s+(?:to\s+)?(.+?)(?:\s+about\s+(.+?)(?:\s+(?:saying|that|body)\s+(.+))?)?$/);
    if (!emailMatch) return null;
    let recipient = emailMatch[1].trim();
    let subject = emailMatch[2]?.trim() || "Message from Qbit";
    let body = emailMatch[3]?.trim() || "";
    if (!body && subject && subject.length > 40) {
      body = subject;
      subject = "Message from Qbit";
    }
    const token = getTokenWithRefresh();
    if (!token) {
      window.open("/api/auth", "_blank", "noopener");
      return "I need you to connect your Google account first.";
    }
    let to = recipient;
    if (!recipient.includes("@")) {
      to = `${recipient.replace(/\s+/g, ".").toLowerCase()}@gmail.com`;
    }
    if (!userEmail) {
      const info = await getUserInfo();
      if (!info || !info.email) return "I couldn't find your email address. Please re-authenticate.";
      userEmail = info.email;
    }
    try {
      const result = await fetchWithAuth("/api/gmail", { to, subject, body, from: userEmail });
      if (result.error === "not_authenticated") {
        window.open("/api/auth", "_blank", "noopener");
        return "I need you to connect your Google account first.";
      }
      if (result.success) return `Email sent to ${to} with subject "${subject}".`;
      return `I couldn't send the email. ${result.error || "Unknown error"}`;
    } catch (err) {
      return "I had trouble sending the email. Please try again.";
    }
  };

  const readDocSkill = async (q) => {
    const m = q.toLowerCase().trim();
    const docMatch = m.match(/^(?:read|open|show)\s+(?:(?:my\s+)?(?:doc|document|google doc)\s+)?(?:(?:with id|id\s*:?\s*|https?:\/\/docs\.google\.com\/document\/d\/)?([a-zA-Z0-9_-]{20,}))\s*.*$/);
    if (!docMatch) return null;
    let docId = docMatch[1];
    if (docId.includes("/")) {
      const parts = docId.split("/");
      for (const p of parts) {
        if (p.length === 44 && /^[a-zA-Z0-9_-]+$/.test(p)) { docId = p; break; }
      }
    }
    const token = getTokenWithRefresh();
    if (!token) {
      window.open("/api/auth", "_blank", "noopener");
      return "I need you to connect your Google account first.";
    }
    try {
      const result = await fetchWithAuth("/api/docs", { documentId: docId });
      if (result.error === "not_authenticated") {
        window.open("/api/auth", "_blank", "noopener");
        return "Your Google access expired. I've opened a tab to re-authenticate.";
      }
      if (result.success) {
        const preview = result.content.slice(0, 1000);
        const wordCount = result.content.split(/\s+/).length;
        return `Document "${result.title}" — ${wordCount} words, ${result.charCount} characters. Here's the start: ${preview}`;
      }
      return `I couldn't read that document. ${result.error || "Unknown error"}`;
    } catch (err) {
      return "I had trouble accessing Google Docs. Please try again.";
    }
  };

  const readSheetSkill = async (q) => {
    const m = q.toLowerCase().trim();
    const sheetMatch = m.match(/^(?:read|open|show)\s+(?:(?:my\s+)?(?:sheet|spreadsheet|google sheets?|excel)\s+)?(?:(?:with id|id\s*:?\s*|https?:\/\/docs\.google\.com\/spreadsheets\/d\/)?([a-zA-Z0-9_-]{20,}))\s*.*$/);
    if (!sheetMatch) return null;
    let sheetId = sheetMatch[1];
    if (sheetId.includes("/")) {
      const parts = sheetId.split("/");
      for (const p of parts) {
        if (p.length === 44 && /^[a-zA-Z0-9_-]+$/.test(p)) { sheetId = p; break; }
      }
    }
    const token = getTokenWithRefresh();
    if (!token) {
      window.open("/api/auth", "_blank", "noopener");
      return "I need you to connect your Google account first.";
    }
    try {
      const result = await fetchWithAuth("/api/sheets", { spreadsheetId: sheetId });
      if (result.error === "not_authenticated") {
        window.open("/api/auth", "_blank", "noopener");
        return "Your Google access expired. I've opened a tab to re-authenticate.";
      }
      if (result.success) {
        const sheetNames = result.sheets.map((s) => s.title).join(", ");
        const preview = result.data ? result.data.slice(0, 500) : "No data found.";
        return `Spreadsheet "${result.title}" has sheets: ${sheetNames}. ${result.rowCount} rows fetched. Here's the data: ${preview}`;
      }
      return `I couldn't read that spreadsheet. ${result.error || "Unknown error"}`;
    } catch (err) {
      return "I had trouble accessing Google Sheets. Please try again.";
    }
  };

  const workspaceSkill = async (q) => {
    const m = q.toLowerCase().trim();
    if (!m) return null;
    if (/\b(who am i|what.?s my email|my email address)\b/.test(m)) {
      const info = await getUserInfo();
      if (info) return `You are ${info.name || "the Google account user"}. Your email is ${info.email}.`;
      window.open("/api/auth", "_blank", "noopener");
      return "I need you to connect your Google account first.";
    }
    return null;
  };

  const calendarSkill = async (q) => {
    const m = q.toLowerCase().trim();
    const isCalendarIntent = /^(remind\s+(?:me|us)|schedule|add\s+.+\s+to\s+(?:my\s+)?calendar|create\s+(?:a\s+)?(?:calendar\s+)?event)/.test(m);
    if (!isCalendarIntent) return null;
    const token = getGoogleToken();
    if (!token || !token.access_token) {
      window.open("/api/auth", "_blank", "noopener");
      return "I need you to connect Google Calendar first.";
    }
    const event = parseEventFromQuery(q);
    if (!event || !event.summary) {
      return "I heard you want to create an event, but I couldn't figure out the details. Try something like: remind me to buy milk at 5pm.";
    }
    const startISO = event.dateTime.toISOString();
    const endISO = new Date(event.dateTime.getTime() + 30 * 60 * 1000).toISOString();
    try {
      const res = await fetch("/api/calendar", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token.access_token}`,
        },
        body: JSON.stringify({
          summary: event.summary,
          description: `Created by Qbit voice assistant.\nOriginal request: "${q}"`,
          start: startISO,
          end: endISO,
          refresh_token: token.refresh_token || "",
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        if (res.status === 401 || err.error?.includes("401")) {
          window.open("/api/auth", "_blank", "noopener");
          return "Your Google access expired. I've opened a tab to re-authenticate.";
        }
        return `I couldn't create the event. ${err.error || "Google Calendar error"}`;
      }
      const data = await res.json();
      if (data.success) {
        return `Done. I've added "${event.summary}" to your calendar for ${event.dateTime.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`;
      }
      return "I couldn't create the calendar event. Please try again.";
    } catch (err) {
      console.error("[qbit] calendar error", err);
      return "I had trouble reaching Google Calendar. Please try again.";
    }
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
    let reply = localSkill(q);
    if (reply == null) reply = await workspaceSkill(q);
    if (reply == null) reply = await guardSkill(sendEmailSkill, "email")(q);
    if (reply == null) reply = await guardSkill(readDocSkill, "docs")(q);
    if (reply == null) reply = await guardSkill(readSheetSkill, "sheets")(q);
    if (reply == null) reply = await calendarSkill(q);
    if (reply == null) reply = await askQbit(q);
    botText.textContent = reply;
    pushHistory("assistant", reply);
    await speak(reply);
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
      speak(ack).then(() => {
        setState("listening", "ask me anything...");
        if (!postSpeechProcessed) beginQueryCapture("");
        postSpeechProcessed = false;
      });
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
    const deviceLang = navigator.language || "en-US";
    r.lang = deviceLang;
    r.maxAlternatives = 1;
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
      console.log("[qbit] recognition started");
    };
    recognition.onerror = (e) => {
      console.warn("[qbit] recognition error", e.error);
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        setState("error", "microphone permission denied");
        micStatus.textContent = "microphone: denied";
        enableBtn.hidden = false;
      } else if (e.error === "no-speech") {
        console.log("[qbit] no speech detected");
      } else if (e.error === "audio-capture") {
        setState("error", "no microphone found");
        micStatus.textContent = "microphone: not found";
        enableBtn.hidden = false;
      }
    };
    recognition.onend = () => {
      recognitionRunning = false;
      micStatus.textContent = "microphone: reconnecting...";
      console.log("[qbit] recognition ended, reconnecting...");
      setTimeout(startRecognition, 150);
    };
    recognition.onresult = (event) => {
      console.log("[qbit] recognition result:", event.results.length, "results");
      let interim = "", finalChunk = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        const txt = res[0].transcript;
        if (res.isFinal) finalChunk += txt + " ";
        else interim += txt + " ";
      }
      const finalTrimmed = finalChunk.trim();
      const interimTrimmed = interim.trim();
      if (!finalTrimmed && !interimTrimmed) return;
      if (interimTrimmed && awaitingQuery) {
        userText.textContent = interimTrimmed;
      }
      if (appState === "speaking" && finalTrimmed && containsAny(finalTrimmed, STOP_PHRASES)) {
        stopSpeaking();
        setState("listening", "go ahead...");
        if (conversational) beginQueryCapture("");
        return;
      }
      if (finalTrimmed) {
        console.log("[qbit] final transcript:", finalTrimmed);
        if (awaitingQuery) {
          const cleaned = stripWake(finalTrimmed);
          queryBuffer = cleaned || finalTrimmed;
          userText.textContent = queryBuffer;
          armQueryTimer();
          return;
        }
        const wake = containsAny(finalTrimmed, WAKE_PHRASES);
        if (wake) {
          console.log("[qbit] wake word detected!");
          wakeUp(stripWake(finalTrimmed));
        } else if (conversational) {
          if (appState === "speaking") {
            postSpeechBuffer = finalTrimmed;
            userText.textContent = finalTrimmed;
          } else {
            beginQueryCapture(finalTrimmed);
          }
        }
      }
    };
  };

  // ───────────────────────── boot ─────────────────────────
  const requestMicAndStart = async () => {
    console.log("[qbit] requesting microphone access...");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        }
      });
      console.log("[qbit] microphone access granted");
      initClapDetection(stream);
    } catch (e) {
      console.error("[qbit] microphone error:", e);
      setState("error", "microphone permission denied");
      micStatus.textContent = "microphone: denied";
      return;
    }
    enableBtn.hidden = true;
    initRecognition();
    if (recognition) {
      console.log("[qbit] starting recognition...");
      startRecognition();
      await new Promise(resolve => setTimeout(resolve, 300));
      if (!recognitionRunning) {
        console.warn("[qbit] recognition didn't start, retrying...");
        startRecognition();
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      const hello = "Qbit online. Say hey Qbit, clap once to wake me, or clap twice for Gmail.";
      botText.textContent = hello;
      await speak(hello);
      console.log("[qbit] greeting complete, recognition should be active");
      setState("idle", 'say "hey qbit" or clap to wake me');
    } else {
      console.error("[qbit] recognition not available");
      setState("error", "speech recognition not supported");
      enableBtn.hidden = false;
    }
  };

  // ───────────────────────── visual privacy indicator ─────────────────────────
  const updatePrivacyIndicator = () => {
    const indicator = document.querySelector('[data-testid="privacy-indicator"]');
    if (!indicator) return;
    const labels = { kill: "🔴 KILL", high: "🟡 HIGH", medium: "🟢 MEDIUM", low: "⚪ LOW" };
    indicator.textContent = `PRIVACY: ${labels[privacyMode] || "MEDIUM"}`;
  };

  const addPrivacyIndicator = () => {
    const footer = document.querySelector(".footer");
    if (!footer) return;
    const sep = document.querySelector(".sep");
    const span = document.createElement("span");
    span.dataset.testid = "privacy-indicator";
    span.style.marginLeft = "8px";
    span.style.color = "#7c8aa8";
    span.style.fontSize = "10px";
    span.style.letterSpacing = "1px";
    if (sep) {
      const newSep = sep.cloneNode();
      newSep.textContent = " / ";
      sep.after(newSep);
      newSep.after(span);
    } else {
      footer.appendChild(span);
    }
    updatePrivacyIndicator();
  };

  if ("speechSynthesis" in window) {
    window.speechSynthesis.onvoiceschanged = () => { pickVoice(); };
    pickVoice();
  }
  addPrivacyIndicator();

  window.addEventListener("message", (event) => {
    if (event.data?.type === "google-oauth-tokens") {
      try {
        const tokenData = event.data.data;
        const parsed = typeof tokenData === "string" ? JSON.parse(tokenData) : tokenData;
        localStorage.setItem("qbit_google_token", JSON.stringify(parsed));
        getUserInfo();
        botText.textContent = "Google account connected. You can now use calendar, email, docs, and sheets.";
      } catch (e) {
        console.warn("[qbit] failed to save oauth token", e);
      }
    }
  });

  // ───────────────────────── text input handling ─────────────────────────
  const sendTextMessage = () => {
    const text = textInput.value.trim();
    if (!text) return;
    textInput.value = "";
    userText.textContent = text;
    pushHistory("user", text);
    finalizeQueryFromText(text);
  };

  const finalizeQueryFromText = async (q) => {
    clearTimeout(queryTimer);
    awaitingQuery = false;
    userText.textContent = q;
    pushHistory("user", q);
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
    let reply = localSkill(q);
    if (reply == null) reply = await workspaceSkill(q);
    if (reply == null) reply = await guardSkill(sendEmailSkill, "email")(q);
    if (reply == null) reply = await guardSkill(readDocSkill, "docs")(q);
    if (reply == null) reply = await guardSkill(readSheetSkill, "sheets")(q);
    if (reply == null) reply = await calendarSkill(q);
    if (reply == null) reply = await askQbit(q);
    botText.textContent = reply;
    pushHistory("assistant", reply);
    await speak(reply);
    enterConversation();
    setTimeout(() => {
      if (conversational) { setState("listening", "anything else?"); }
      else setState("idle", 'say "hey qbit" to wake me');
    }, POST_RESPONSE_COOLDOWN);
  };

  if (sendBtn) sendBtn.addEventListener("click", sendTextMessage);
  if (textInput) {
    textInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        sendTextMessage();
      }
    });
  }

  enableBtn.addEventListener("click", requestMicAndStart);

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