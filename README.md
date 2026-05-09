# vocab-pwa

A multi-section vocabulary review PWA using Firebase Hosting, Firebase Functions, Cloud Firestore, `ts-fsrs`, and switchable LLM providers.

## Stack

- React + TypeScript + Vite PWA
- Firebase Functions v2 HTTP API
- Cloud Firestore
- `ts-fsrs` for spaced repetition
- OpenRouter/Groq/Gemini LLM provider adapters

## Local Setup

1. Install dependencies:

   ```sh
   npm install
   ```

2. Copy `.env.example` to `.env.local` for the web app and configure Firebase/LLM environment variables for functions.

3. Start the frontend:

   ```sh
   npm run dev:web
   ```

4. Start Firebase emulators or deploy functions before using the API-backed flows.

## Review Rating

The API mirrors `ts-fsrs` ratings numerically:

- `Again = 1`
- `Hard = 2`
- `Good = 3`
- `Easy = 4`

API clients must send only these numeric values to `/api/reviews`.
