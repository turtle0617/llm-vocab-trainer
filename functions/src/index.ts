import cors from "cors";
import express from "express";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { onRequest } from "firebase-functions/v2/https";
import { z } from "zod";
import {
  ReviewRating,
  createSpeechRequestSchema,
  generatedWordSchema,
  normalizeWordInput,
  reviewIntensitySchema,
  reviewRatingSchema,
  type CreateCardRequest,
  type CreateReviewRequest,
  type CreateSectionRequest,
  type CreateSpeechRequest,
  type GenerateWordRequest,
  type UpdateSettingsRequest
} from "@vocab/shared";
import { AuthError, authMiddleware, getAuthContext } from "./auth.js";
import { createInitialFsrsState, scheduleReview } from "./srs.js";
import {
  assertCardReviewable,
  createCard,
  createSection,
  deleteCard,
  deleteSection,
  getExistingReviewByClientId,
  getCardsPage,
  getDashboard,
  getSettings,
  RepositoryError,
  getSectionSummaries,
  updateSettings,
  writeReview
} from "./repositories.js";
import { generateWordWithProvider } from "./llm/providers.js";
import { generateSpeech, SpeechConfigError, SpeechProviderError } from "./speech.js";

initializeApp();

const db = getFirestore();
const app = express();
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(express.json({ limit: "256kb" }));
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("Origin is not allowed"));
    }
  })
);

app.use("/api", authMiddleware);

app.get("/api/dashboard", async (_req, res, next) => {
  try {
    const auth = getAuthContext(res);
    res.json(await getDashboard(db, auth.uid));
  } catch (error) {
    next(error);
  }
});

app.get("/api/sections", async (_req, res, next) => {
  try {
    const auth = getAuthContext(res);
    res.json(await getSectionSummaries(db, auth.uid));
  } catch (error) {
    next(error);
  }
});

app.get("/api/settings", async (_req, res, next) => {
  try {
    const auth = getAuthContext(res);
    res.json(await getSettings(db, auth.uid));
  } catch (error) {
    next(error);
  }
});

app.put("/api/settings", async (req, res, next) => {
  try {
    const auth = getAuthContext(res);
    const body = z
      .object({
        reviewIntensity: reviewIntensitySchema
      })
      .strict()
      .parse(req.body) satisfies UpdateSettingsRequest;

    res.json(await updateSettings(db, body.reviewIntensity, auth.uid));
  } catch (error) {
    next(error);
  }
});

app.post("/api/sections", async (req, res, next) => {
  try {
    const auth = getAuthContext(res);
    const body = z
      .object({
        name: z.string().trim().min(1).max(80),
        description: z.string().trim().max(240).optional()
      })
      .strict()
      .parse(req.body) satisfies CreateSectionRequest;
    res.status(201).json(await createSection(db, body, auth.uid));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/sections/:sectionId", async (req, res, next) => {
  try {
    const auth = getAuthContext(res);
    const params = z.object({ sectionId: z.string().trim().min(1) }).parse(req.params);
    res.json(await deleteSection(db, params.sectionId, auth.uid));
  } catch (error) {
    next(error);
  }
});

app.post("/api/generate-word", async (req, res, next) => {
  try {
    const body = z
      .object({
        word: z.string().trim().min(1).max(80),
        sectionId: z.string().trim().min(1),
        locale: z.literal("zh-TW")
      })
      .strict()
      .parse(req.body) satisfies GenerateWordRequest;

    const normalized = normalizeWordInput(body.word);
    if (!/^[A-Za-z][A-Za-z\s'-]{0,79}$/.test(normalized)) {
      res.status(400).json({ message: "Only English words or short phrases are supported." });
      return;
    }

    res.json(await generateWordWithProvider({ word: normalized, locale: body.locale }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/speech", async (req, res, next) => {
  try {
    const body = createSpeechRequestSchema.parse(req.body) satisfies CreateSpeechRequest;
    const audio = await generateSpeech(body);
    res
      .status(200)
      .set({
        "Cache-Control": "no-store",
        "Content-Length": String(audio.byteLength),
        "Content-Type": "audio/wav"
      })
      .send(Buffer.from(audio));
  } catch (error) {
    next(error);
  }
});

app.post("/api/cards", async (req, res, next) => {
  try {
    const auth = getAuthContext(res);
    const body = z
      .object({
        sectionId: z.string().trim().min(1),
        content: generatedWordSchema
      })
      .strict()
      .parse(req.body) satisfies CreateCardRequest;

    const fsrs = createInitialFsrsState();
    res.status(201).json(await createCard(db, body, fsrs, auth.uid));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/cards/:cardId", async (req, res, next) => {
  try {
    const auth = getAuthContext(res);
    const params = z.object({ cardId: z.string().trim().min(1) }).parse(req.params);
    const query = z.object({ sectionId: z.string().trim().min(1) }).parse(req.query);
    res.json(await deleteCard(db, { cardId: params.cardId, sectionId: query.sectionId, ownerUid: auth.uid }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/cards", async (req, res, next) => {
  try {
    const auth = getAuthContext(res);
    const query = z
      .object({
        sectionId: z.string().trim().min(1),
        dueBefore: z.string().datetime().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(20),
        cursor: z.string().optional()
      })
      .strict()
      .parse(req.query);

    res.json(await getCardsPage(db, query, auth.uid));
  } catch (error) {
    next(error);
  }
});

app.post("/api/reviews", async (req, res, next) => {
  try {
    const auth = getAuthContext(res);
    const body = z
      .object({
        clientReviewId: z.string().trim().min(1).max(120),
        cardId: z.string().trim().min(1),
        sectionId: z.string().trim().min(1),
        rating: reviewRatingSchema,
        reviewedAt: z.string().datetime()
      })
      .strict()
      .parse(req.body) satisfies CreateReviewRequest;

    const settings = await getSettings(db, auth.uid);
    const result = await db.runTransaction(async (transaction) => {
      const existing = await getExistingReviewByClientId(db, transaction, body.clientReviewId, auth.uid);
      if (existing) return { due: existing.nextDue };

      const card = await assertCardReviewable(db, transaction, body.cardId, body.sectionId, auth.uid);
      if (!isReviewRating(body.rating)) throw new HttpError(400, "Invalid review rating.");

      const scheduled = scheduleReview(card.data.fsrs, body.rating, new Date(body.reviewedAt), {
        desiredRetention: settings.desiredRetention
      });
      transaction.update(card.ref, {
        fsrs: scheduled.fsrs,
        due: scheduled.due,
        state: scheduled.state,
        updatedAt: new Date().toISOString()
      });
      await writeReview(db, transaction, body, scheduled, auth.uid);
      return scheduled;
    });

    res.json({ nextDue: result.due });
  } catch (error) {
    next(error);
  }
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof AuthError || error instanceof RepositoryError) {
    res.status(error.status).json({ message: error.message });
    return;
  }
  if (error instanceof HttpError) {
    res.status(error.status).json({ message: error.message });
    return;
  }
  if (error instanceof z.ZodError) {
    res.status(400).json({ message: "Invalid request.", issues: error.issues });
    return;
  }
  if (error instanceof Error && error.message.includes("LLM output did not match schema")) {
    res.status(422).json({ message: error.message });
    return;
  }
  if (error instanceof SpeechProviderError) {
    res.status(502).json({
      code: error.providerCode,
      message: error.message
    });
    return;
  }
  if (error instanceof SpeechConfigError) {
    res.status(500).json({ message: error.message });
    return;
  }
  console.error(error);
  res.status(500).json({ message: "Internal server error." });
});

export const api = onRequest(
  {
    region: "us-central1"
  },
  app
);

class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
  }
}

function isReviewRating(value: number): value is ReviewRating {
  return value === 1 || value === 2 || value === 3 || value === 4;
}
