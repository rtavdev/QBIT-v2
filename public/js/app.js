/* Qbit — JARVIS-style hands-free client controller
 * Capabilities:
 *  - Continuous Web Speech recognition + local wake-word ("hey qbit")
 *  - Conversational mode: stays awake for follow-ups after replying
 *  - Conversation memory sent to /api/chat for contextual answers
 *  - Instant on-device skills: time, date, open sites, math, greetings, stop
 *  - Barge-in: starts listening / can be interrupted while speaking
 *  - JARVIS voice tuning + acknowledgement chimes
 *  - Clap detection: single clap = wake, double clap = open Gmail
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
  let conversational = false;
  let conversationTimer = null;
  let queryBuffer = "";
  let queryTimer = null;
  let postSpeechBuffer = "";        // command spoken while Qbit was speaking, to process after TTS ends
  let postSpeechProcessed = false;  // set true when onend handles buffered content; prevents .then() race
  let userEmail = "";               // cached from userinfo for sending emails
  let privacyMode = "medium";       // "low" | "medium" | "high" | "kill"
  let clapDetector = null;

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

  // ───────────────────────── clap detection ─────────────────────────
  // Uses the Web Audio API to detect sharp transient sounds (claps) from
  // the microphone. A "clap" is a sudden loud peak that decays quickly.
  //
  // Single clap → wake Qbit       (if idle)
  // Double clap → open Gmail      (always)

  let clapStream = null;
  let clapAudioCtx = null;
  let clapAnalyser = null;
  let lastClapTime = 0;
  const CLAP_COOLDOWN_MS = 800;       // ignore claps within this window
  const DOUBLE_CLAP_WINDOW_MS = 700;  // max gap between two claps to count as double

  const initClapDetection = (stream) => {
    try {
      clapStream = stream;
      clapAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const source = clapAudioCtx.createMediaStreamSource(stream);

      // Low-pass filter to focus on the clap frequency range (hand claps are ~1-4 kHz)
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
      let clapLock = false;           // prevent retriggering mid-clap
      let lockTimer = null;

      const detect = () => {
        if (!clapAnalyser) return;
        clapAnalyser.getByteFrequencyData(dataArray);

        // Average volume across frequencies
        let sum = 0;
        for (let i = 0; i < bufferLength; i++) sum += dataArray[i];
        const avg = sum / bufferLength;

        // A clap = sudden volume spike ≥ threshold above the quiet floor
        const noiseFloor = Math.max(prevAvg, 15);
        const spike = avg - noiseFloor;

        if (spike > 40 && !clapLock && avg > 50) {
          // Clap detected! Lock to prevent double-triggering the same clap
          clapLock = true;
          clearTimeout(lockTimer);
          lockTimer = setTimeout(() => { clapLock = false; }, 200);

          const now = Date.now();
          const gap = now - lastClapTime;

          if (gap > CLAP_COOLDOWN_MS && gap < DOUBLE_CLAP_WINDOW_MS) {
            // Double clap!
            lastClapTime = 0;
            onDoubleClap();
          } else if (gap >= DOUBLE_CLAP_WINDOW_MS) {
            // First clap — wait briefly to see if a second follows
            lastClapTime = now;
            setTimeout(() => {
              // If no second clap arrived within the window, treat as single clap
              if (lastClapTime === now) {
                lastClapTime = 0;
                onSingleClap();
              }
            }, DOUBLE_CLAP_WINDOW_MS + 50);
          }
        }

        prevAvg = avg * 0.7 + (prevAvg || avg) * 0.3; // smooth the floor
        requestAnimationFrame(detect);
      };

      detect();
    } catch (e) {
      console.warn("[qbit] clap detection unavailable", e);
    }
  };

  const onSingleClap = () => {
    if (appState === "processing" || appState === "speaking") return;
    // Wake up if idle
    if (!conversational || appState === "idle") {
      setState("listening", "clap detected");
      enterConversation();
      const ack = pick(["Yes?", "I heard that.", "Clap received. Go ahead."]);
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
      if (conversational) {
        setState("listening", "anything else?");
      } else {
        setState("idle", 'say "hey qbit" to wake me');
      }
    }, POST_RESPONSE_COOLDOWN + 600);
  };

  // ───────────────────────── speech synthesis ─────────────────────────
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
      u.pitch = 0.9;
      u.volume = 1.0;
      const v = pickVoice();
      if (v) u.voice = v;
      setState("speaking", "speaking...");
      u.onend = () => {
        // Process any command the user spoke while Qbit was talking
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
  // privacyMode controls what Qbit can access:
  //   "kill"   → everything blocked (only time/date/greetings work)
  //   "high"   → no email, docs, sheets; calendar + weather OK
  //   "medium" → no docs, sheets; email + calendar + weather OK (default)
  //   "low"    → no restrictions (full workspace)
  //
  // Voice commands to change:
  //   "kill switch on" / "privacy kill" / "lock down" → sets kill mode
  //   "privacy low" / "privacy medium" / "privacy high" → sets that level
  //   "kill switch off" / "disable kill switch" → resets to low

  const isRestricted = (resource) => {
    if (privacyMode === "kill") return true;
    if (privacyMode === "high" && (resource === "email" || resource === "docs" || resource === "sheets")) return true;
    if (privacyMode === "medium" && (resource === "docs" || resource === "sheets")) return true;
    return false;
  };

  const handlePrivacyCommand = (m) => {
    if (/\b(kill switch|privacy kill|lock down|lockdown|maximum privacy)\b/.test(m)) {
      privacyMode = "kill";
      postSpeechBuffer = ""; // clear any buffered commands
      return "Privacy killswitch activated. I will not process any personal data until you disable it.";
    }
    if (/\b(kill switch off|disable kill switch|unlock|remove restrictions)\b/.test(m)) {
      privacyMode = "low";
      return "Privacy restrictions lifted. Full access restored.";
    }
    if (/\bprivacy (high|maximum)\b/.test(m)) {
      privacyMode = "high";
      return "Privacy set to high. Email, docs, and sheets are blocked. Calendar and weather still work.";
    }
    if (/\bprivacy medium\b/.test(m)) {
      privacyMode = "medium";
      return "Privacy set to medium. Docs and sheets are blocked. Email and calendar still work.";
    }
    if (/\bprivacy low|disable restrictions\b/.test(m)) {
      privacyMode = "low";
      return "Privacy set to low. All features are available.";
    }
    return null;
  };

  const guardSkill = (fn, resource) => async (q) => {
    if (isRestricted(resource)) return null; // silently skip
    return fn(q);
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
    if (/\b(what.?s? the day|what day is)\b/.test(m)) {
      const d = new Date().toLocaleDateString([], { weekday: "long" });
      return `It's ${d}.`;
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

    // mail-specific — "open mail", "check email", "open gmail"
    if (/\b(?:open|check|read)\s*(?:my\s*)?(?:mail|email|gmail|inbox)\b/.test(m)) {
      window.open("https://mail.google.com", "_blank", "noopener");
      return "Opening Gmail.";
    }

    // simple arithmetic
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

    // privacy killswitch command (always works - highest priority)
    const privacyResult = handlePrivacyCommand(m);
    if (privacyResult) return privacyResult;

    // check if kill mode is active — only allow time/date/greetings
    if (privacyMode === "kill") {
      // Only respond to time/date/greetings in kill mode
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

    // greetings
    if (/\b(hello|hey|hi)\b/.test(m) && m.length < 16) return "Hello. How can I help?";
    if (/\b(who are you|what are you|your name)\b/.test(m)) {
      return "I'm Qbit, your hands-free assistant. Think of me as your JARVIS.";
    }
    if (/\b(thank you|thanks|cheers)\b/.test(m) && m.length < 20) return "Always a pleasure.";

    // who am i / what's my email
    if (/\b(who am i|what.?s my email|my email address|my email)\b/.test(m)) {
      const token = getGoogleToken();
      if (!token || !token.access_token) return "I need you to connect your Google account first.";
      // Handled by workspaceSkill instead (async)
      return null;
    }

    return null;
  };

  // ───────────────────────── Google Calendar ─────────────────────────
  // Handles: "remind me to X at Y", "schedule a meeting", "add to calendar"
  // Token is stored in localStorage after OAuth via /api/auth

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
      } else {
        d.setHours(9, 0, 0, 0);
      }
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
      } else { d.setHours(9, 0, 0, 0); }
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
      } else { d.setHours(9, 0, 0, 0); }
      return d;
    }

    const atMatch = s.match(/^at\s+(.+)/);
    if (atMatch) {
      const t = parseClockTime(atMatch[1]);
      const d = new Date(now);
      if (t.hours < d.getHours() || (t.hours === d.getHours() && t.minutes <= d.getMinutes())) {
        d.setDate(d.getDate() + 1);
      }
      d.setHours(t.hours, t.minutes, 0, 0);
      return d;
    }

    const t = parseClockTime(s);
    if (t) {
      const d = new Date(now);
      if (t.hours < d.getHours() || (t.hours === d.getHours() && t.minutes <= d.getMinutes())) {
        d.setDate(d.getDate() + 1);
      }
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
    // Patterns: "send email to [name/email] about [subject] (saying) [body]"
    //           "email [name] [subject] [body]"
    //           "send an email to [name] that [body]"
    const emailMatch = m.match(/^(?:send\s+(?:an?\s+)?email|email)\s+(?:to\s+)?(.+?)(?:\s+about\s+(.+?)(?:\s+(?:saying|that|body)\s+(.+))?)?$/);
    if (!emailMatch) return null;

    let recipient = emailMatch[1].trim();
    let subject = emailMatch[2]?.trim() || "Message from Qbit";
    let body = emailMatch[3]?.trim() || "";

    // If no explicit body, the rest of the query after "about" might contain it
    if (!body && subject && subject.length > 40) {
      body = subject;
      subject = "Message from Qbit";
    }

    const token = getTokenWithRefresh();
    if (!token) {
      window.open("/api/auth", "_blank", "noopener");
      return "I need you to connect your Google account first. I've opened a tab for you.";
    }

    // Resolve name to email if needed (try common patterns)
    let to = recipient;
    if (!recipient.includes("@")) {
      to = `${recipient.replace(/\s+/g, ".").toLowerCase()}@gmail.com`;
    }

    // Get sender email if not cached
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
    // Patterns: "read doc [id]" or "read my document about [name]"
    // For MVP, accept a direct document ID or URL
    const docMatch = m.match(/^(?:read|open|show)\s+(?:(?:my\s+)?(?:doc|document|google doc)\s+)?(?:(?:with id|id\s*:?\s*|https?:\/\/docs\.google\.com\/document\/d\/)?([a-zA-Z0-9_-]{20,}))\s*.*$/);
    if (!docMatch) return null;

    let docId = docMatch[1];
    // Extract from URL if it's a full URL
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
    // Patterns: "read sheet [id]" or "read my spreadsheet about [name]"
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

    // who am i / my email
    if (/\b(who am i|what.?s my email|my email address)\b/.test(m)) {
      const info = await getUserInfo();
      if (info) return `You are ${info.name || "the Google account user"}. Your email is ${info.email}.`;
      window.open("/api/auth", "_blank", "noopener");
      return "I need you to connect your Google account first. I've opened a tab for you.";
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
      return "I need you to connect Google Calendar first. I've opened a new tab for you to sign in.";
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

    // try instant on-device skills first (local, then calendar, then LLM)
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
    // Ensure recognition is alive in case it dropped while Qbit was speaking
    armQueryTimer();
  };

  const wakeUp = (leftover) => {
    enterConversation();
    if (!leftover || leftover.length < 2) {
      const ack = pick(ACK_PHRASES);
      botText.textContent = ack;
      speak(ack).then(() => {
        setState("listening", "ask me anything...");
        // Only start clean capture if postSpeechBuffer wasn't already handled by speak()'s onend
        if (!postSpeechProcessed) {
          beginQueryCapture("");
        }
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
      // Always reconnect — if recognition drops while Qbit is speaking,
      // the mic goes dead and all subsequent commands are lost.
      setTimeout(startRecognition, 150);
    };

    recognition.onresult = (event) => {
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

      // Show interim text on screen so user sees what's being heard, but
      // ONLY process finalised text for wake-word / query capture. This
      // prevents the assistant from acting on half-formed, unstable input.
      if (interimTrimmed && awaitingQuery) {
        userText.textContent = interimTrimmed;
      }

      // barge-in: interrupt speaking if the user clearly says stop (on final results only)
      if (appState === "speaking" && finalTrimmed && containsAny(finalTrimmed, STOP_PHRASES)) {
        stopSpeaking();
        setState("listening", "go ahead...");
        if (conversational) beginQueryCapture("");
        return;
      }

      // Process only finalised text for actions
      if (finalTrimmed) {
        if (awaitingQuery) {
          const cleaned = stripWake(finalTrimmed);
          queryBuffer = cleaned || finalTrimmed;
          userText.textContent = queryBuffer;
          armQueryTimer();
          return;
        }

        // not capturing → wake on wake-word, or accept directly if conversational
        const wake = containsAny(finalTrimmed, WAKE_PHRASES);
        if (wake) {
          wakeUp(stripWake(finalTrimmed));
        } else if (conversational) {
          // If Qbit is currently speaking, buffer the command for processing after TTS finishes
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
    try {
      // Request mic — the stream is used by clap detection (Web Audio API).
      // Speech recognition (SpeechRecognition) accesses the mic on its own internally.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      initClapDetection(stream);
    } catch (e) {
      setState("error", "microphone permission denied");
      micStatus.textContent = "microphone: denied";
      return;
    }
    enableBtn.hidden = true;
    initRecognition();
    if (recognition) {
      startRecognition();
      const hello = "Qbit online. Say hey Qbit, clap once to wake me, or clap twice for Gmail.";
      botText.textContent = hello;
      await speak(hello);
      setState("idle", 'say "hey qbit" or clap to wake me');
    }
  };

  // ───────────────────────── visual privacy indicator ─────────────────────────
  const updatePrivacyIndicator = () => {
    const indicator = document.querySelector('[data-testid="privacy-indicator"]');
    if (!indicator) return;
    const labels = { kill: "🔴 KILL", high: "🟡 HIGH", medium: "🟢 MEDIUM", low: "⚪ LOW" };
    indicator.textContent = `PRIVACY: ${labels[privacyMode] || "MEDIUM"}`;
  };

  // Center privacy display in the footer
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

  // Update indicator whenever privacy changes (wrap original)
  const _handlePrivacyCommand = handlePrivacyCommand;
  const handlePrivacyCommand = (m) => {
    const result = _handlePrivacyCommand(m);
    if (result) setTimeout(updatePrivacyIndicator, 10);
    return result;
  };

  if ("speechSynthesis" in window) {
    window.speechSynthesis.onvoiceschanged = () => { pickVoice(); };
    pickVoice();
  }
  addPrivacyIndicator();

  // ───────────────────────── OAuth message listener ─────────────────────────
  // Listens for token data posted from the OAuth popup (/api/auth-callback)
  window.addEventListener("message", (event) => {
    if (event.data?.type === "google-oauth-tokens") {
      try {
        const tokenData = event.data.data;
        const parsed = typeof tokenData === "string" ? JSON.parse(tokenData) : tokenData;
        localStorage.setItem("qbit_google_token", JSON.stringify(parsed));
        // Fetch user email immediately after auth
        getUserInfo();
        botText.textContent = "Google account connected. You can now use calendar, email, docs, and sheets.";
      } catch (e) {
        console.warn("[qbit] failed to save oauth token", e);
      }
    }
  });

  enableBtn.addEventListener("click", requestMicAndStart);

  // Keyboard helpers
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