let currentChannel = 1;
let messages = [];
let user = null;
let isSpeaking = false;
let currentAudio = null;

async function init() {
  const res = await fetch('/api/auth/me');
  const data = await res.json();

  if (data.authenticated) {
    user = data.user;
    document.getElementById('loginScreen').classList.add('hidden');
    document.getElementById('mainApp').classList.remove('hidden');
    document.getElementById('userInfo').innerHTML = '<strong>' + user.name + '</strong>' + user.email;
  } else {
    document.getElementById('loginScreen').classList.remove('hidden');
    document.getElementById('mainApp').classList.add('hidden');
  }
}

function setChannel(n) {
  currentChannel = n;
  document.getElementById('ch1Btn').classList.toggle('active', n === 1);
  document.getElementById('ch2Btn').classList.toggle('active', n === 2);

  var tools = ['tGmail','tCal','tDrive','tDocs','tWeather'];
  tools.forEach(function(id) {
    var el = document.getElementById(id);
    el.classList.toggle('active', n === 2);
    el.classList.toggle('locked', n === 1);
  });

  var label = n === 1 ? 'Channel 1 \u00B7 Consultation' : 'Channel 2 \u00B7 Execution';
  document.getElementById('channelLabel').textContent = label;
  document.getElementById('inputHint').textContent = n === 1
    ? 'Channel 1 \u00B7 No personal data access'
    : 'Channel 2 \u00B7 Google Workspace connected';

  appendMessage('qbit', n === 1
    ? 'Switched to consultation mode. No personal data access active.'
    : 'Execution mode active. Gmail, Calendar, Drive, Docs/Sheets, and Weather are live.');
}

function handleKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
  var ta = document.getElementById('inputBox');
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
}

function formatTime(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function appendMessage(role, text) {
  var container = document.getElementById('messages');
  var div = document.createElement('div');
  div.className = 'msg ' + role;
  var avatarText = role === 'qbit' ? 'Q' : (user?.name?.charAt(0) || 'U');
  div.innerHTML = '<div class="msg-avatar">' + avatarText + '</div><div class="msg-body"><div class="msg-text">' + escapeHtml(text) + '</div><div class="msg-time">' + formatTime(new Date()) + '</div></div>';
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  return div;
}

function appendTyping() {
  var container = document.getElementById('messages');
  var div = document.createElement('div');
  div.className = 'msg qbit typing-indicator';
  div.id = 'typing';
  div.innerHTML = '<div class="msg-avatar">Q</div><div class="msg-body"><div class="msg-text"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div></div>';
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function removeTyping() {
  var t = document.getElementById('typing');
  if (t) t.remove();
}

function escapeHtml(str) {
  var amp = '\x26' + 'amp;';
  var lt = '\x26' + 'lt;';
  var gt = '\x26' + 'gt;';
  return str
    .replace(/\x26/g, amp)
    .replace(/</g, lt)
    .replace(/>/g, gt)
    .replace(/\n/g, '\x3cbr\x3e');
}

/**
 * Speak Qbit's reply using Google Cloud TTS.
 * Plays MP3 audio via native Audio element.
 * Manages "Speaking" visual state via CSS class on the last Qbit message.
 */
function speakText(text, msgDiv) {
  // Stop any current playback
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }

  // Clean text for TTS - remove HTML tags, limit length
  var cleanText = text
    .replace(/<br>/g, '. ')
    .replace(/<[^>]+>/g, '')
    .trim();

  if (!cleanText) return;

  // Mark speaking state on the message
  isSpeaking = true;
  if (msgDiv) {
    msgDiv.classList.add('speaking');
  }

  fetch('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: cleanText })
  })
  .then(function(res) {
    if (!res.ok) {
      throw new Error('TTS request failed');
    }
    return res.blob();
  })
  .then(function(blob) {
    var url = URL.createObjectURL(blob);
    var audio = new Audio(url);
    currentAudio = audio;

    audio.onended = function() {
      isSpeaking = false;
      currentAudio = null;
      URL.revokeObjectURL(url);
      if (msgDiv) {
        msgDiv.classList.remove('speaking');
      }
    };

    audio.onerror = function() {
      isSpeaking = false;
      currentAudio = null;
      URL.revokeObjectURL(url);
      if (msgDiv) {
        msgDiv.classList.remove('speaking');
      }
    };

    audio.play().catch(function(err) {
      console.warn('Audio playback blocked:', err);
      isSpeaking = false;
      currentAudio = null;
      if (msgDiv) {
        msgDiv.classList.remove('speaking');
      }
    });
  })
  .catch(function(err) {
    console.warn('TTS unavailable:', err);
    isSpeaking = false;
    if (msgDiv) {
      msgDiv.classList.remove('speaking');
    }
  });
}

async function sendMessage() {
  var input = document.getElementById('inputBox');
  var text = input.value.trim();
  if (!text) return;

  input.value = '';
  input.style.height = 'auto';

  var btn = document.getElementById('sendBtn');
  btn.disabled = true;

  appendMessage('user', text);
  messages.push({ role: 'user', content: text });

  appendTyping();

  try {
    var res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: messages, channel: currentChannel })
    });

    var data = await res.json();
    removeTyping();

    var reply = data.reply || data.error || 'No response.';
    var msgDiv = appendMessage('qbit', reply);
    messages.push({ role: 'assistant', content: reply });

    // Auto-speak Qbit's reply
    speakText(reply, msgDiv);

    if (messages.length > 40) messages = messages.slice(-40);
  } catch (err) {
    removeTyping();
    appendMessage('qbit', 'Connection error. Check your network or API configuration.');
  }

  btn.disabled = false;
  input.focus();
}

init();