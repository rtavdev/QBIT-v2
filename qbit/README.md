# Qbit — Setup Guide

## 1. Environment Variables

Create these in Vercel Dashboard → Project → Settings → Environment Variables:

```
GEMINI_API_KEY=your_gemini_api_key_here
GOOGLE_CLIENT_ID=your_google_oauth_client_id
GOOGLE_CLIENT_SECRET=your_google_oauth_client_secret
GOOGLE_REDIRECT_URI=https://your-vercel-domain.vercel.app/api/auth/callback
```

---

## 2. Get Gemini API Key (Free)

1. Go to https://aistudio.google.com/app/apikey
2. Click **Create API Key**
3. Copy and paste into `GEMINI_API_KEY`

---

## 3. Set Up Google OAuth

1. Go to https://console.cloud.google.com/
2. Create a new project (or use existing)
3. Go to **APIs & Services → OAuth consent screen**
   - User type: External
   - Fill in app name: `Qbit`
   - Add your email as test user
4. Go to **APIs & Services → Credentials**
   - Click **Create Credentials → OAuth 2.0 Client ID**
   - Application type: **Web application**
   - Authorized redirect URIs: `https://your-vercel-domain.vercel.app/api/auth/callback`
   - Also add `http://localhost:3000/api/auth/callback` for local dev
5. Copy **Client ID** and **Client Secret**

---

## 4. Google Cloud Text-to-Speech Setup (Optional — Voice Responses)

Qbit can speak responses aloud using Google Cloud Text-to-Speech with the premium `en-US-Neural2-J` voice.

1. Go to https://console.cloud.google.com/apis/credentials
2. Click **Create Credentials → Service Account**
3. Name it `qbit-tts`, click **Create and Continue**
4. Grant role: **Text-to-Speech Admin**
5. Click **Done**, then click on the new service account
6. Go to **Keys → Add Key → Create New Key**
7. Choose **JSON**, download the key file
8. **Minify the entire JSON into one line** (use https://jsonminifier.com or similar)
9. Set the environment variable in Vercel:
   ```
   GOOGLE_APPLICATION_CREDENTIALS_JSON=<paste minified JSON here>
   ```
10. Enable the Cloud Text-to-Speech API:
    - Go to https://console.cloud.google.com/apis/library/texttospeech.googleapis.com
    - Click **Enable**

> **Free Tier:** Google Cloud TTS offers 1 million free characters per month. The endpoint is serverless and only runs when called — no background costs.

---

## 5. Enable Google APIs

In Google Cloud Console → APIs & Services → Enable APIs:

- Gmail API
- Google Calendar API
- Google Drive API
- Google Docs API
- Google Sheets API
- Google People API (for user info)

---

## 6. Deploy to Vercel

```bash
npm install -g vercel
vercel login
vercel --prod
```

Or connect your GitHub repo in the Vercel dashboard for auto-deploy.

---

## 7. Local Development

```bash
npm install
vercel dev
```

Then open http://localhost:3000

---

## Project Structure

```
qbit/
├── api/
│   ├── _session.js         # Shared session utility
│   ├── chat.js             # Gemini brain + tool orchestration
│   ├── auth/
│   │   ├── login.js        # OAuth initiation
│   │   ├── callback.js     # OAuth token exchange
│   │   ├── logout.js       # Session clear
│   │   └── me.js           # Current user info
│   └── google/
│       ├── gmail.js        # Gmail read
│       ├── calendar.js     # Calendar read/create
│       ├── drive.js        # Drive search
│       └── docs.js         # Docs/Sheets reader
├── public/
│   ├── index.html
│   ├── css/style.css
│   └── js/app.js
├── package.json
├── vercel.json
└── README.md
```
