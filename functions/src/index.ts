import cors from "cors";
import express from "express";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { onRequest } from "firebase-functions/v2/https";
import { z } from "zod";
import {
  ReviewRating,
  generatedWordSchema,
  normalizeWordInput,
  reviewRatingSchema,
  type CreateCardRequest,
  type CreateReviewRequest,
  type CreateSectionRequest,
  type GenerateWordRequest
} from "@vocab/shared";
import { createInitialFsrsState, scheduleReview } from "./srs.js";
import {
  createCard,
  createSection,
  deleteCard,
  deleteSection,
  getCardsPage,
  getDashboard,
  getSectionSummaries,
  writeReview
} from "./repositories.js";
import { generateWordWithProvider } from "./llm/providers.js";

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

app.get("/api/dashboard", async (_req, res, next) => {
  try {
    res.json(await getDashboard(db));
  } catch (error) {
    next(error);
  }
});

app.get("/api/sections", async (_req, res, next) => {
  try {
    res.json(await getSectionSummaries(db));
  } catch (error) {
    next(error);
  }
});

app.post("/api/sections", async (req, res, next) => {
  try {
    const body = z
      .object({
        name: z.string().trim().min(1).max(80),
        description: z.string().trim().max(240).optional()
      })
      .strict()
      .parse(req.body) satisfies CreateSectionRequest;
    res.status(201).json(await createSection(db, body));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/sections/:sectionId", async (req, res, next) => {
  try {
    const params = z.object({ sectionId: z.string().trim().min(1) }).parse(req.params);
    res.json(await deleteSection(db, params.sectionId));
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

app.post("/api/cards", async (req, res, next) => {
  try {
    const body = z
      .object({
        sectionId: z.string().trim().min(1),
        content: generatedWordSchema
      })
      .strict()
      .parse(req.body) satisfies CreateCardRequest;

    const fsrs = createInitialFsrsState();
    res.status(201).json(await createCard(db, body, fsrs));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/cards/:cardId", async (req, res, next) => {
  try {
    const params = z.object({ cardId: z.string().trim().min(1) }).parse(req.params);
    const query = z.object({ sectionId: z.string().trim().min(1) }).parse(req.query);
    res.json(await deleteCard(db, { cardId: params.cardId, sectionId: query.sectionId }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/cards", async (req, res, next) => {
  try {
    const query = z
      .object({
        sectionId: z.string().trim().min(1),
        dueBefore: z.string().datetime().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(20),
        cursor: z.string().optional()
      })
      .strict()
      .parse(req.query);

    res.json(await getCardsPage(db, query));
  } catch (error) {
    next(error);
  }
});

app.post("/api/reviews", async (req, res, next) => {
  try {
    const body = z
      .object({
        cardId: z.string().trim().min(1),
        sectionId: z.string().trim().min(1),
        rating: reviewRatingSchema,
        reviewedAt: z.string().datetime()
      })
      .strict()
      .parse(req.body) satisfies CreateReviewRequest;

    const result = await db.runTransaction(async (transaction) => {
      const cardRef = db.collection("cards").doc(body.cardId);
      const snapshot = await transaction.get(cardRef);
      if (!snapshot.exists) throw new HttpError(404, "Card was not found.");

      const card = snapshot.data()!;
      if (card.sectionId !== body.sectionId) throw new HttpError(400, "Card does not belong to section.");
      if (!isReviewRating(body.rating)) throw new HttpError(400, "Invalid review rating.");

      const scheduled = scheduleReview(card.fsrs, body.rating, new Date(body.reviewedAt));
      transaction.update(cardRef, {
        fsrs: scheduled.fsrs,
        due: scheduled.due,
        state: scheduled.state,
        updatedAt: new Date().toISOString()
      });
      await writeReview(db, transaction, body, scheduled);
      return scheduled;
    });

    res.json({ nextDue: result.due });
  } catch (error) {
    next(error);
  }
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
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
  console.error(error);
  res.status(500).json({ message: "Internal server error." });
});

export const api = onRequest(
  {
    region: "us-central1",
    secrets: ["LLM_API_KEY"]
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
