# vocab-pwa

`vocab-pwa` is a multi-deck vocabulary review PWA. It uses FSRS scheduling, Firebase as the backend platform, and an LLM provider to generate bilingual vocabulary content.

## Features

- Multiple vocabulary decks, called sections in the API.
- Add a word with LLM-generated parts of speech, Traditional Chinese definitions, English definitions, and bilingual example sentences.
- Review flow similar to Anki: front side shows the English word, back side shows definitions and examples.
- Four FSRS ratings: `Again`, `Hard`, `Good`, `Easy`.
- Paginated card loading to avoid fetching an entire deck at once.
- Delete decks and delete individual cards.
- PWA build with offline app shell and IndexedDB cache/queue scaffolding.
- Switchable LLM providers: OpenRouter, Groq, and Gemini.

## Stack

- React + TypeScript + Vite
- Firebase Hosting
- Firebase Functions v2 HTTP API
- Cloud Firestore
- Firebase Emulator Suite for local development
- `ts-fsrs` for spaced repetition scheduling
- Zod validation for API and LLM output contracts

## Project Structure

```txt
apps/web/          React PWA frontend
functions/         Firebase Functions API
packages/shared/   Shared TypeScript types and schemas
firebase.json      Firebase hosting/functions/firestore config
firestore.rules    Firestore client access rules
firestore.indexes.json
```

## Environment Variables

The root `.env.example` documents the variables used by the project:

```env
LLM_PROVIDER=openrouter
LLM_MODEL=meta-llama/llama-4-maverick:free
LLM_API_KEY=
LLM_DEBUG_LOGS=false
ALLOWED_ORIGINS=http://localhost:5173
VITE_API_BASE_URL=http://127.0.0.1:5001/YOUR_PROJECT_ID/us-central1/api/api
```

For local development, create:

```txt
apps/web/.env.local
functions/.env.local
functions/.secret.local
```

Example `apps/web/.env.local`:

```env
VITE_API_BASE_URL=http://127.0.0.1:5001/YOUR_PROJECT_ID/us-central1/api/api
```

Example `functions/.env.local`:

```env
LLM_PROVIDER=groq
LLM_MODEL=llama-3.3-70b-versatile
LLM_DEBUG_LOGS=false
ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
```

Example `functions/.secret.local`:

```env
LLM_API_KEY=<your-provider-api-key>
```

Do not commit `.env.local` or `.secret.local` files.

## Local Development

Install dependencies:

```sh
npm install
```

Start the Firebase emulators:

```sh
npm run dev:functions
```

Start the frontend in another terminal:

```sh
npm run dev:web
```

Open:

```txt
http://127.0.0.1:5173/
```

The Firebase Emulator UI is usually available at:

```txt
http://127.0.0.1:4000/
```

The local API URL shape is:

```txt
http://127.0.0.1:5001/YOUR_PROJECT_ID/us-central1/api/api
```

The repeated `/api/api` is expected:

- first `api`: Firebase function name
- second `/api`: Express route prefix

## Firebase Setup

Install and log in to Firebase CLI:

```sh
npm install -g firebase-tools
firebase login
```

Create or select a Firebase project:

```sh
firebase use --add
```

Enable Cloud Firestore in Firebase Console. Use production mode. This project does not let the browser access Firestore directly; all database writes go through Firebase Functions.

Firebase emulators require Java 21 or newer. On macOS with Homebrew:

```sh
brew install openjdk@21
```

If your global Java is older, run emulators with:

```sh
JAVA_HOME=/opt/homebrew/opt/openjdk@21 npm run dev:functions
```

## Firestore Model

Collections:

- `sections`: decks
- `cards`: vocabulary cards
- `reviewLogs`: review history
- `settings`: reserved for app-level settings

The browser is blocked from direct Firestore access by `firestore.rules`:

```js
allow read, write: if false;
```

Firebase Functions uses the Admin SDK and is not blocked by these rules.

## API Overview

- `GET /api/dashboard`
- `GET /api/sections`
- `POST /api/sections`
- `DELETE /api/sections/:sectionId`
- `POST /api/generate-word`
- `POST /api/cards`
- `GET /api/cards?sectionId=<id>&dueBefore=<iso>&limit=<n>&cursor=<cursor>`
- `DELETE /api/cards/:cardId?sectionId=<id>`
- `POST /api/reviews`

Review ratings mirror `ts-fsrs` numeric values:

```ts
export enum ReviewRating {
  Again = 1,
  Hard = 2,
  Good = 3,
  Easy = 4,
}
```

## LLM Providers

Set `LLM_PROVIDER` to one of:

- `openrouter`
- `groq`
- `gemini`

For Groq, `llama-3.3-70b-versatile` uses JSON Object Mode. `meta-llama/llama-4-scout-17b-16e-instruct` uses JSON Schema mode with `strict: false`.

All LLM output is validated by the backend before it is returned to the frontend. Invalid output is retried once and then returned as a `422`.

## Debug Logging

`LLM_DEBUG_LOGS=true` prints raw LLM responses in the Functions log:

```env
LLM_DEBUG_LOGS=true
```

This does not print the API key, but it may print user-entered words and generated content. Keep it `false` in production unless you are actively debugging.

## Emulator vs Production

Firestore emulator data is local test data. It does not appear in Firebase Console and does not sync to production Firestore.

During local development:

```txt
Browser -> Vite dev server -> Functions emulator -> Firestore emulator
```

The LLM provider still uses the real external API unless you switch back to the frontend mock mode.

Production flow:

```txt
Browser -> Firebase Hosting -> /api/** rewrite -> Firebase Functions -> Cloud Firestore / LLM provider
```

## Deploy

Set the production LLM secret:

```sh
firebase functions:secrets:set LLM_API_KEY
```

Build and deploy:

```sh
npm run build
firebase deploy --only firestore,functions,hosting
```

Cloud Functions usually requires the Firebase Blaze plan. Firestore has free quotas, but production usage should still be monitored with budget alerts.

## Scripts

```sh
npm run dev:web        # Vite frontend
npm run dev:functions  # Firebase emulators
npm run build          # Build all workspaces
npm run test           # Run tests
npm run deploy         # firebase deploy
```

## Security Notes

- Never commit `.env.local`, `.secret.local`, Firebase debug logs, or service account files.
- The frontend should not contain LLM API keys.
- Firestore is intentionally accessed through Functions, not directly from the browser.
- Keep `LLM_DEBUG_LOGS=false` in production.
