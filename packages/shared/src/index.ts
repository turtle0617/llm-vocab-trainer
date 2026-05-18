import { z } from "zod";

export enum ReviewRating {
  Again = 1,
  Hard = 2,
  Good = 3,
  Easy = 4
}

export const reviewRatingSchema = z.nativeEnum(ReviewRating);

export const reviewIntensitySchema = z.enum(["relaxed", "standard", "solid", "exam"]);

export const desiredRetentionByIntensity = {
  relaxed: 0.85,
  standard: 0.9,
  solid: 0.93,
  exam: 0.95
} as const satisfies Record<ReviewIntensity, number>;

export type ReviewIntensity = z.infer<typeof reviewIntensitySchema>;

export const partOfSpeechSchema = z.enum([
  "noun",
  "verb",
  "adjective",
  "adverb",
  "preposition",
  "conjunction",
  "interjection",
  "phrase",
  "other"
]);

export type PartOfSpeech = z.infer<typeof partOfSpeechSchema>;

export const generatedExampleSchema = z
  .object({
    en: z.string().min(1).max(240),
    zh: z.string().min(1).max(240)
  })
  .strict();

export const generatedEntrySchema = z
  .object({
    partOfSpeech: partOfSpeechSchema,
    zhDefinition: z.string().min(1).max(500),
    enDefinition: z.string().min(1).max(500),
    examples: z.array(generatedExampleSchema).min(1).max(3)
  })
  .strict();

export const generatedWordSchema = z
  .object({
    word: z.string().min(1).max(80),
    normalizedWord: z.string().min(1).max(80),
    entries: z.array(generatedEntrySchema).min(1).max(6)
  })
  .strict();

export type GeneratedWord = z.infer<typeof generatedWordSchema>;

export const speechVoiceSchema = z.enum(["autumn", "diana", "hannah", "austin", "daniel", "troy"]);

export type SpeechVoice = z.infer<typeof speechVoiceSchema>;

export const createSpeechRequestSchema = z
  .object({
    text: z.string().trim().min(1).max(200),
    voice: speechVoiceSchema.default("hannah")
  })
  .strict();

export type CreateSpeechRequest = z.infer<typeof createSpeechRequestSchema>;

export type WordContent = GeneratedWord;

export interface SectionSummary {
  id: string;
  name: string;
  description?: string;
  totalCards: number;
  dueToday: number;
  reviewedToday: number;
  lastReviewedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface VocabCard {
  id: string;
  sectionId: string;
  word: string;
  normalizedWord: string;
  content: WordContent;
  due: string;
  state: string;
  createdAt: string;
  updatedAt: string;
  suspendedAt?: string;
}

export interface DashboardResponse {
  totals: {
    dueToday: number;
    reviewedToday: number;
    streakDays: number;
    totalCards: number;
  };
  reviewTrend: Array<{ date: string; count: number }>;
  sections: SectionSummary[];
}

export interface SyncResponse {
  serverSyncedAt: string;
  dashboard?: DashboardResponse;
  settings?: AppSettings;
}

export interface PaginatedCardsResponse {
  items: VocabCard[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface CreateSectionRequest {
  name: string;
  description?: string;
}

export interface GenerateWordRequest {
  word: string;
  sectionId: string;
  locale: "zh-TW";
}

export interface CreateCardRequest {
  sectionId: string;
  content: WordContent;
}

export interface CreateReviewRequest {
  clientReviewId: string;
  cardId: string;
  sectionId: string;
  rating: ReviewRating;
  reviewedAt: string;
}

export interface DeleteSectionResponse {
  id: string;
  archivedAt: string;
  archivedCards: number;
}

export interface AppSettings {
  reviewIntensity: ReviewIntensity;
  desiredRetention: number;
  updatedAt: string;
}

export interface UpdateSettingsRequest {
  reviewIntensity: ReviewIntensity;
}

export function assertValidReviewRating(value: unknown): ReviewRating {
  return reviewRatingSchema.parse(value);
}

export function normalizeWordInput(input: string): string {
  return input.trim().replace(/\s+/g, " ");
}
