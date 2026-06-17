let currentChannel = 1;
let messages = [];
let user = null;

async function init() {
  const res = await fetch('/api/auth/me');
  const data = await res.json();

  if (data.authenticated) {
    user = data.user;
    document.getElementById('loginScreen').classList.add('hidden');
    document.getElementById('mainApp').classList.remove('hidden');
    document.getElementById('userInfo').innerHTML = `<strong>${user.name}</strong>${user.email}`;
  } else {
    document.getElementById('loginScreen').classList.remove('hidden');
    document.getElementById('mainApp').classList.add('hidden');
  }
}

function setChannel(n) {
  currentChannel = n;
  document.getElementById('ch1Btn').classList.toggle('active', n === 1);
  document.getElementById('ch2Btn').classList.toggle('active', n === 2);

  const tools = ['tGmail','tCal','tDrive','tDocs','tWeather'];
  tools.forEach(id => {
    const el = document.getElementById(id);
    el.classList.toggle('active', n === 2);
    el.classList.toggle('locked', n === 1);
  });

  const label = n === 1 ? 'Channel 1 · Consultation' : 'Channel 2 · Execution';
  document.getElementById('channelLabel').textContent = label;
  document.getElementById('inputHint').textContent = n === 1
    ? 'Channel 1 · No personal data access'
    : 'Channel 2 · Google Workspace connected';

  appendMessage('qbit', n === 1
    ? 'Switched to consultation mode. No personal data access active.'
    : 'Execution mode active. Gmail, Calendar, Drive, Docs/Sheets, and Weather are live.');
}

function handleKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
  const ta = document.getElementById('inputBox');
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
}

function formatTime(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function appendMessage(role, text) {
  const container = document.getElementById('messages');
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  const avatarText = role === 'qbit' ? 'Q' : (user?.name?.charAt(0) || 'U');
  div.innerHTML = `
    <div class="msg-avatar">${avatarText}</div>
    <div class="msg-body">
      <div class="msg-text">${escapeHtml(text)}</div>
      <div class="msg-time">${formatTime(new Date())}</div>
    </div>`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  return div;
}

function appendTyping() {
  const container = document.getElementById('messages');
  const div = document.createElement('div');
  div.className = 'msg qbit typing-indicator';
  div.id = 'typing';
  div.innerHTML = `
    <div class="msg-avatar">Q</div>
    <div class="msg-body">
      <div class="msg-text">
        <span class="dot"></span><span class="dot"></span><span class="dot"></span>
      </div>
    </div>`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function removeTyping() {
  const t = document.getElementById('typing');
  if (t) t.remove();
}

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
}

async function sendMessage() {
  const input = document.getElementById('inputBox');
  const text = input.value.trim();
  if (!text) return;

  input.value = '';
  input.style.height = 'auto';

  const btn = document.getElementById('sendBtn');
  btn.disabled = true;

  appendMessage('user', text);
  messages.push({ role: 'user', content: text });

  appendTyping();

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, channel: currentChannel })
    });

    const data = await res.json();
    removeTyping();

    const reply = data.reply || data.error || 'No response.';
    appendMessage('qbit', reply);
    messages.push({ role: 'assistant', content: reply });

    if (messages.length > 40) messages = messages.slice(-40);
  } catch (err) {
    removeTyping();
    appendMessage('qbit', 'Connection error. Check your network or API configuration.');
  }

  btn.disabled = false;
  input.focus();
}

init();
