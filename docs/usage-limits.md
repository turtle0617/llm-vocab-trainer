# Firebase and LLM Usage Limits

Last checked: 2026-05-17.

This project uses Firebase Hosting, Firebase Functions, Cloud Firestore, Firebase Authentication, and an external LLM provider. Firebase prices and free quotas can change, so treat the numbers below as an operating guide and verify them before a production launch.

Official references:

- [Firebase pricing](https://firebase.google.com/pricing)
- [Firebase Hosting usage, quotas, and pricing](https://firebase.google.com/docs/hosting/usage-quotas-pricing)
- [Cloud Firestore billing](https://firebase.google.com/docs/firestore/pricing)
- [Avoid surprise bills](https://firebase.google.com/docs/projects/billing/avoid-surprise-bills)
- [Google Cloud budgets and alerts](https://cloud.google.com/billing/docs/how-to/budgets)

## Architecture Cost Map

```txt
Browser
  -> Firebase Hosting
  -> /api/** Hosting rewrite
  -> Firebase Functions HTTP API
  -> Cloud Firestore
  -> Firebase Authentication
  -> External LLM / TTS provider
```

| Layer | Project feature | Billing driver | Notes |
| --- | --- | --- | --- |
| Firebase Hosting | Serves the React/Vite PWA from `apps/web/dist` | Stored hosting files and data transfer | Spark can host the frontend. Blaze is needed only after no-cost Hosting quota is exceeded. |
| Firebase Functions | Express API in `functions/src/index.ts` | Requests, compute time, memory, outbound networking, build/deployment support services | Production Functions deployment requires Blaze. Small apps often stay inside no-cost usage, but Blaze must still be enabled. |
| Cloud Firestore | `sections`, `cards`, `reviewLogs`, `settings` | Document reads, writes, deletes, storage, network | Firestore has daily free quotas. This app accesses Firestore through Functions, not directly from the browser. |
| Firebase Auth | Email/password login and ID token verification | Authentication usage | Email/password for small usage is usually not the cost driver. Phone/SMS auth is different and can cost more. |
| LLM provider | `/api/generate-word` | Provider token pricing | This is outside Firebase billing. It can become the main cost if public users can generate freely. |
| TTS provider | `/api/speech` | Provider audio/TTS pricing | This is outside Firebase billing. The current implementation uses Groq for speech. |

## Current Firebase Free Quotas to Watch

| Service | No-cost quota to watch | Practical meaning for this app |
| --- | --- | --- |
| Hosting storage | 10 GB | Usually safe for this static PWA unless many old releases or large assets are retained. |
| Hosting data transfer | 10 GB/month | If one full page load is about 1 MB, this is roughly 10,000 full uncached loads/month. Browser/CDN caching usually reduces repeat load cost. |
| Firestore storage | 1 GiB | Usually safe for personal vocabulary data. Review logs can grow over time. |
| Firestore reads | 50,000/day | Dashboard refreshes and card loading are the main sources. |
| Firestore writes | 20,000/day | Review submissions and card creation are the main sources. |
| Firestore deletes | 20,000/day | This app mostly soft-deletes by writing `archivedAt`, so writes matter more than deletes. |
| Cloud Functions requests | 2M/month | About 66,000 API calls/day before request-count billing. Firestore writes or LLM calls will usually matter first. |

Firestore free quotas reset daily around midnight Pacific time. Firestore aggregation queries such as `count()` still bill reads for index entries, with a minimum read charge.

## Approximate Usage Math

These are estimates from the current implementation, not guaranteed billing counts.

### Opening the app

The frontend commonly calls:

- `GET /api/dashboard`
- `GET /api/settings`
- Section/card loading calls depending on the current view

`/api/dashboard` can be read-heavy because it:

- reads active sections;
- runs count queries per section;
- reads recent `reviewLogs` for the 7-day trend.

If a user has many sections or many recent reviews, dashboard refreshes can become a noticeable Firestore read source.

### Reviewing one card

`POST /api/reviews` roughly does:

```txt
Reads:
  duplicate review lookup
  card document
  section document

Writes:
  update card schedule
  create reviewLogs document
  update section counters
```

Rule-of-thumb estimate:

```txt
1 review ~= 3 Firestore reads + 3 Firestore writes + 1 Function request
```

With the Firestore no-cost write quota:

```txt
20,000 writes/day / 3 writes per review ~= 6,600 reviews/day
```

For normal personal use, such as 100 to 500 reviews/day, this is far below the no-cost write quota.

### Creating one vocabulary card

Creating a card is usually a two-step flow:

```txt
POST /api/generate-word
POST /api/cards
```

`generate-word` calls the external LLM provider. It does not create Firestore documents by itself.

`create-card` roughly does:

```txt
Reads:
  section document

Writes:
  create card document
  update section counters
```

Rule-of-thumb estimate:

```txt
1 new card ~= 1 Firestore read + 2 Firestore writes + 2 Function requests + 1 LLM request
```

With the Firestore no-cost write quota:

```txt
20,000 writes/day / 2 writes per card ~= 10,000 cards/day
```

In practice, the LLM provider cost is likely to matter before Firestore cost if card generation is public or unthrottled.

### Playing speech audio

`POST /api/speech` roughly does:

```txt
1 Function request + 1 external TTS provider request
```

It does not normally read or write Firestore. The main cost risk is the external TTS provider.

## Traffic Scenarios

| Scenario | Estimated Firebase risk | Main cost risk |
| --- | --- | --- |
| Personal use: 100 to 500 reviews/day, 10 to 100 generated cards/day | Usually low | LLM/TTS if used heavily |
| Small beta: 10 users * 200 reviews/day | About 2,000 reviews/day, roughly 6,000 Firestore writes/day | Still usually inside Firestore no-cost writes |
| Larger beta: 50 users * 200 reviews/day | About 10,000 reviews/day, roughly 30,000 Firestore writes/day | Firestore writes can exceed the 20,000/day no-cost quota |
| Public app with unlimited generation | Firebase may still be okay at first | LLM/TTS can become the main bill quickly |

## Budget Alert Setup

Budget alerts do not cap usage or stop charges. They only notify you so you can react.

Recommended setup for this project:

1. Open [Google Cloud Budgets](https://console.cloud.google.com/billing/budgets).
2. Select the billing account attached to the Firebase project.
3. Create a new budget.
4. Scope it to the project, for example `YOUR_PROJECT_ID`.
5. Include all services at first, so unexpected services are still covered by alerts.
6. Start with a low monthly amount, such as `$5`.
7. Add alert thresholds at `50% actual`, `80% actual`, `100% actual`, and `100% forecasted`.
8. Confirm the alert recipients include the project owner or billing admin.

Recommended follow-up controls:

- Set per-user daily limits for `/api/generate-word`.
- Set per-user daily limits for `/api/speech`.
- Keep `LLM_DEBUG_LOGS=false` in production.
- Watch the Firebase Console usage dashboard after the first deploy.
- Rotate any API key that was pasted into logs, chat, or committed files.

## Deployment Plan Impact

Spark plan:

```txt
Can deploy Firebase Hosting for the frontend.
Cannot deploy production Firebase Functions for this backend.
```

Blaze plan:

```txt
Required for production Firebase Functions.
Many Firebase services still include no-cost usage quotas.
Usage above no-cost quotas is billed pay-as-you-go.
```

If avoiding Blaze is mandatory, the backend must move away from Firebase Functions to another backend platform, while Firebase Hosting can still serve the frontend.
