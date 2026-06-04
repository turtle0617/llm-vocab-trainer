import type {
  CreateCardRequest,
  CreateReviewRequest,
  CreateSectionRequest,
  CreateSpeechRequest,
  DashboardResponse,
  GenerateWordRequest,
  GeneratedWord,
  PaginatedCardsResponse,
  AppSettings,
  DeleteSectionResponse,
  SectionSummary,
  SyncResponse
} from "@vocab/shared";
import { desiredRetentionByIntensity, ReviewRating, type UpdateSettingsRequest } from "@vocab/shared";
import { getAppCheckToken, getIdToken, markRequiresLogin } from "./auth";

const FORCE_MOCK_API =
  import.meta.env.DEV && import.meta.env.MODE !== "test" && import.meta.env.VITE_FORCE_MOCK_API === "true";
const API_BASE_URL = import.meta.env.DEV && !FORCE_MOCK_API ? import.meta.env.VITE_API_BASE_URL : undefined;
const USE_MOCK_API = import.meta.env.DEV && (FORCE_MOCK_API || !API_BASE_URL);
const TRANSIENT_RETRY_DELAYS_MS = [1000, 2000, 4000] as const;
type ApiRequestOptions = { signal?: AbortSignal };
type AuthAdapter = {
  getIdToken: typeof getIdToken;
  getAppCheckToken: typeof getAppCheckToken;
  markRequiresLogin: typeof markRequiresLogin;
  useMockApi: boolean;
};

export class ApiAuthError extends Error {
  readonly kind = "auth";
}

class ApiFetch {
  constructor(
    private readonly baseUrl: string,
    private readonly auth: AuthAdapter
  ) {}

  async json<T>(path: string, init?: RequestInit, options?: ApiRequestOptions): Promise<T> {
    const response = await this.send(path, init, options);
    const contentType = response.headers.get("content-type") ?? "";
    const isJson = contentType.includes("application/json");

    if (!isJson) {
      const text = await response.text();
      if (text.trim().startsWith("<!doctype") || text.trim().startsWith("<html")) {
        throw new Error(
          "API returned HTML instead of JSON. Start Firebase emulators, set VITE_API_BASE_URL, or use the built-in dev mock API."
        );
      }
      throw new Error("API returned a non-JSON response.");
    }

    return response.json() as Promise<T>;
  }

  async blob(path: string, init?: RequestInit, options?: ApiRequestOptions): Promise<Blob> {
    const response = await this.send(path, init, options);
    const contentType = response.headers.get("content-type") ?? "";
    const isJson = contentType.includes("application/json");

    if (isJson) {
      const error = await response.json().catch(() => null);
      throw new Error(error?.message ?? "API returned JSON instead of audio.");
    }

    return response.blob();
  }

  private async send(
    path: string,
    init?: RequestInit,
    options?: ApiRequestOptions,
    retryAttempt = 0,
    tokenOverride?: string
  ): Promise<Response> {
    let response: Response;
    try {
      const token = this.auth.useMockApi ? null : (tokenOverride ?? await this.auth.getIdToken());
      const appCheckToken = this.auth.useMockApi ? null : await this.auth.getAppCheckToken();
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: options?.signal,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(appCheckToken ? { "X-Firebase-AppCheck": appCheckToken } : {}),
          ...(init?.headers ?? {})
        }
      });
    } catch (error) {
      if (shouldRetryRequest(error, options, retryAttempt)) {
        const delay = TRANSIENT_RETRY_DELAYS_MS[retryAttempt];
        if (delay === undefined) throw error;
        await sleep(delay);
        return this.send(path, init, options, retryAttempt + 1, tokenOverride);
      }
      throw error;
    }

    if (response.ok) return response;
    const retryDelay = TRANSIENT_RETRY_DELAYS_MS[retryAttempt];
    if (isTransientStatus(response.status) && retryDelay !== undefined) {
      await sleep(retryDelay);
      return this.send(path, init, options, retryAttempt + 1, tokenOverride);
    }

    const error = await parseApiError(response);
    if (response.status === 401 && !tokenOverride && !this.auth.useMockApi) {
      try {
        const refreshedToken = await this.auth.getIdToken({ forceRefresh: true });
        if (refreshedToken) return this.send(path, init, options, TRANSIENT_RETRY_DELAYS_MS.length, refreshedToken);
      } catch {
        // Fall through to the auth error path below.
      }
      this.auth.markRequiresLogin();
      throw new ApiAuthError(error?.message ?? "Your session expired. Please sign in again.");
    }
    if (response.status === 401) {
      this.auth.markRequiresLogin();
      throw new ApiAuthError(error?.message ?? "Your session expired. Please sign in again.");
    }
    if (response.status === 403) throw new Error(error?.message ?? "This account does not have permission.");
    throw new Error(error?.message ?? "Request failed");
  }
}

function shouldRetryRequest(error: unknown, options: ApiRequestOptions | undefined, attempt: number) {
  if (options?.signal?.aborted) return false;
  if (attempt >= TRANSIENT_RETRY_DELAYS_MS.length) return false;
  return error instanceof TypeError || error instanceof DOMException;
}

function isTransientStatus(status: number) {
  return status === 408 || status === 429 || status >= 500;
}

function sleep(ms: number) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

async function parseApiError(response: Response) {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return null;
  return response.json().catch(() => ({ message: response.statusText })) as Promise<{ message?: string }>;
}

const apiFetch = new ApiFetch(API_BASE_URL ?? "/api", {
  getAppCheckToken,
  getIdToken,
  markRequiresLogin,
  useMockApi: USE_MOCK_API
});

const liveApi = {
  dashboard: () => apiFetch.json<DashboardResponse>("/dashboard"),
  sync: (params: { since: string }) => {
    const query = new URLSearchParams({ since: params.since });
    return apiFetch.json<SyncResponse>(`/sync?${query.toString()}`);
  },
  settings: () => apiFetch.json<AppSettings>("/settings"),
  updateSettings: (body: UpdateSettingsRequest) =>
    apiFetch.json<AppSettings>("/settings", { method: "PUT", body: JSON.stringify(body) }),
  sections: () => apiFetch.json<SectionSummary[]>("/sections"),
  createSection: (body: CreateSectionRequest) =>
    apiFetch.json<SectionSummary>("/sections", { method: "POST", body: JSON.stringify(body) }),
  deleteSection: (sectionId: string) =>
    apiFetch.json<DeleteSectionResponse>(`/sections/${sectionId}`, { method: "DELETE" }),
  generateWord: (body: GenerateWordRequest, options?: ApiRequestOptions) =>
    apiFetch.json<GeneratedWord>("/generate-word", { method: "POST", body: JSON.stringify(body) }, options),
  createCard: (body: CreateCardRequest) =>
    apiFetch.json<{ id: string }>("/cards", { method: "POST", body: JSON.stringify(body) }),
  deleteCard: (sectionId: string, cardId: string) =>
    apiFetch.json<{ id: string }>(`/cards/${cardId}?sectionId=${encodeURIComponent(sectionId)}`, { method: "DELETE" }),
  cards: (params: {
    sectionId: string;
    dueBefore?: string;
    limit?: number;
    cursor?: string | null;
  }) => {
    const query = new URLSearchParams();
    query.set("sectionId", params.sectionId);
    if (params.dueBefore) query.set("dueBefore", params.dueBefore);
    if (params.limit) query.set("limit", String(params.limit));
    if (params.cursor) query.set("cursor", params.cursor);
    return apiFetch.json<PaginatedCardsResponse>(`/cards?${query.toString()}`);
  },
  review: (body: CreateReviewRequest) =>
    apiFetch.json<{ nextDue: string }>("/reviews", { method: "POST", body: JSON.stringify(body) }),
  speech: (body: CreateSpeechRequest, options?: ApiRequestOptions) =>
    apiFetch.blob("/speech", { method: "POST", body: JSON.stringify(body) }, options)
};

export const api = USE_MOCK_API ? createMockApi() : liveApi;

function createMockApi(): typeof liveApi {
  const storageKey = "vocab-pwa-dev-mock-v2";

  type MockState = {
    settings: AppSettings;
    sections: SectionSummary[];
    cards: Array<{
      id: string;
      sectionId: string;
      word: string;
      normalizedWord: string;
      content: GeneratedWord;
      due: string;
      state: string;
      createdAt: string;
      updatedAt: string;
      suspendedAt?: string;
    }>;
    reviews: CreateReviewRequest[];
  };

  function load(): MockState {
    const raw = localStorage.getItem(storageKey);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<MockState>;
      return {
        settings: parsed.settings ?? {
          reviewIntensity: "standard",
          desiredRetention: desiredRetentionByIntensity.standard,
          updatedAt: new Date().toISOString()
        },
        sections: parsed.sections ?? [],
        cards: parsed.cards ?? [],
        reviews: parsed.reviews ?? []
      };
    }
    const state = createInitialMockState();
    save(state);
    return state;
  }

  function save(state: MockState) {
    localStorage.setItem(storageKey, JSON.stringify(hydrate(state)));
  }

  function hydrate(state: MockState): MockState {
    const today = new Date().toISOString().slice(0, 10);
    return {
      ...state,
      sections: state.sections.map((section) => {
        const cards = state.cards.filter((card) => card.sectionId === section.id);
        return {
          ...section,
          totalCards: cards.length,
          dueToday: cards.filter((card) => card.due <= new Date().toISOString()).length,
          reviewedToday: state.reviews.filter(
            (review) => review.sectionId === section.id && review.reviewedAt.startsWith(today)
          ).length,
          lastReviewedAt: state.reviews
            .filter((review) => review.sectionId === section.id)
            .map((review) => review.reviewedAt)
            .sort()
            .at(-1)
        };
      })
    };
  }

  function createInitialMockState(): MockState {
    const now = new Date();
    const isoNow = now.toISOString();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const sections: SectionSummary[] = [
      {
        id: "toefl-core",
        name: "TOEFL Core",
        totalCards: 0,
        dueToday: 0,
        reviewedToday: 0,
        createdAt: isoNow,
        updatedAt: isoNow
      },
      {
        id: "business-english",
        name: "Business English",
        totalCards: 0,
        dueToday: 0,
        reviewedToday: 0,
        createdAt: isoNow,
        updatedAt: isoNow
      },
      {
        id: "daily-news",
        name: "Daily News",
        totalCards: 0,
        dueToday: 0,
        reviewedToday: 0,
        createdAt: isoNow,
        updatedAt: isoNow
      }
    ];
    const cards = [
      {
        id: "resilient-card",
        sectionId: "toefl-core",
        word: "resilient",
        normalizedWord: "resilient",
        content: demoWord(
          "resilient",
          "adjective",
          "able to recover quickly from difficulties or adapt to adversity",
          "able to recover quickly from difficulties; tough",
          [
            ["She showed great resilience in the face of unexpected challenges.", "She recovered quickly under pressure."],
            ["The resilient economy continued to grow amid uncertainty.", "The economy kept growing despite uncertainty."]
          ]
        ),
        due: isoNow,
        state: "review",
        createdAt: isoNow,
        updatedAt: isoNow
      },
      {
        id: "nuanced-card",
        sectionId: "toefl-core",
        word: "nuanced",
        normalizedWord: "nuanced",
        content: demoWord(
          "nuanced",
          "adjective",
          "showing careful attention to subtle differences",
          "showing subtle differences in meaning or expression",
          [["A nuanced answer is better than a simple yes or no.", "The answer shows more than one layer of meaning."]]
        ),
        due: tomorrow.toISOString(),
        state: "review",
        createdAt: isoNow,
        updatedAt: isoNow
      },
      {
        id: "candid-card",
        sectionId: "business-english",
        word: "candid",
        normalizedWord: "candid",
        content: demoWord(
          "candid",
          "adjective",
          "honest and direct, especially when the truth is difficult",
          "truthful and straightforward",
          [["The manager gave candid feedback after the presentation.", "The feedback was direct and useful."]]
        ),
        due: isoNow,
        state: "new",
        createdAt: isoNow,
        updatedAt: isoNow
      }
    ];
    const reviews: CreateReviewRequest[] = [
      {
        clientReviewId: "demo-review-1",
        cardId: "nuanced-card",
        sectionId: "toefl-core",
        rating: ReviewRating.Good,
        reviewedAt: yesterday.toISOString()
      }
    ];
    return {
      settings: {
        reviewIntensity: "standard",
        desiredRetention: desiredRetentionByIntensity.standard,
        updatedAt: isoNow
      },
      sections,
      cards,
      reviews
    };
  }

  function demoWord(
    word: string,
    partOfSpeech: GeneratedWord["entries"][number]["partOfSpeech"],
    zhDefinition: string,
    enDefinition: string,
    examples: Array<[string, string]>
  ): GeneratedWord {
    return {
      word,
      normalizedWord: word.toLowerCase(),
      entries: [
        {
          partOfSpeech,
          zhDefinition,
          enDefinition,
          examples: examples.map(([en, zh]) => ({ en, zh }))
        }
      ]
    };
  }

  return {
    async dashboard() {
      return createDashboard(hydrate(load()));
    },
    async sync(params) {
      const state = hydrate(load());
      const dashboard = createDashboard(state);
      return {
        serverSyncedAt: new Date().toISOString(),
        ...(state.sections.some((section) => section.updatedAt > params.since) ||
        state.cards.some((card) => card.updatedAt > params.since) ||
        state.reviews.some((review) => review.reviewedAt > params.since)
          ? { dashboard }
          : {}),
        ...(state.settings.updatedAt > params.since ? { settings: state.settings } : {})
      };
    },
    async settings() {
      return load().settings;
    },
    async updateSettings(body) {
      const state = load();
      state.settings = {
        reviewIntensity: body.reviewIntensity,
        desiredRetention: desiredRetentionByIntensity[body.reviewIntensity],
        updatedAt: new Date().toISOString()
      };
      save(state);
      return state.settings;
    },
    async sections() {
      return hydrate(load()).sections;
    },
    async createSection(body) {
      const state = load();
      const now = new Date().toISOString();
      const section: SectionSummary = {
        id: crypto.randomUUID(),
        name: body.name,
        description: body.description,
        totalCards: 0,
        dueToday: 0,
        reviewedToday: 0,
        createdAt: now,
        updatedAt: now
      };
      state.sections.unshift(section);
      save(state);
      return section;
    },
    async deleteSection(sectionId) {
      const state = load();
      const archivedCards = state.cards.filter((card) => card.sectionId === sectionId).length;
      state.sections = state.sections.filter((section) => section.id !== sectionId);
      state.cards = state.cards.filter((card) => card.sectionId !== sectionId);
      state.reviews = state.reviews.filter((review) => review.sectionId !== sectionId);
      save(state);
      return { id: sectionId, archivedAt: new Date().toISOString(), archivedCards };
    },
    async generateWord(body) {
      const normalized = body.word.trim().toLowerCase();
      return {
        word: body.word.trim(),
        normalizedWord: normalized,
        entries: [
          {
            partOfSpeech: "noun",
            zhDefinition: `A common noun meaning of "${body.word.trim()}".`,
            enDefinition: `A common noun meaning of "${body.word.trim()}".`,
            examples: [
              {
                en: `I wrote "${body.word.trim()}" in my notebook.`,
                zh: `I saved "${body.word.trim()}" in my vocabulary notebook.`
              },
              {
                en: `This "${body.word.trim()}" appears often in daily English.`,
                zh: `This "${body.word.trim()}" appears often in everyday English.`
              },
              {
                en: `The teacher explained the "${body.word.trim()}" with a simple example.`,
                zh: `The teacher explained "${body.word.trim()}" with a simple example.`
              }
            ]
          },
          {
            partOfSpeech: "verb",
            zhDefinition: `A common verb meaning of "${body.word.trim()}".`,
            enDefinition: `A common verb meaning of "${body.word.trim()}".`,
            examples: [
              {
                en: `Please ${normalized} before the meeting.`,
                zh: `Please ${normalized} before the meeting.`
              },
              {
                en: `We need to ${normalized} this word again tomorrow.`,
                zh: `We need to ${normalized} this word again tomorrow.`
              },
              {
                en: `She tried to ${normalized} the idea in her own words.`,
                zh: `She tried to ${normalized} the idea in her own words.`
              }
            ]
          }
        ]
      } satisfies GeneratedWord;
    },
    async createCard(body) {
      const state = load();
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      state.cards.push({
        id,
        sectionId: body.sectionId,
        word: body.content.word,
        normalizedWord: body.content.normalizedWord,
        content: body.content,
        due: now,
        state: "new",
        createdAt: now,
        updatedAt: now
      });
      save(state);
      return { id };
    },
    async deleteCard(sectionId, cardId) {
      const state = load();
      state.cards = state.cards.filter((card) => !(card.id === cardId && card.sectionId === sectionId));
      save(state);
      return { id: cardId };
    },
    async cards(params) {
      const state = load();
      const offset = params.cursor ? Number(params.cursor) : 0;
      const limit = params.limit ?? 20;
      const filtered = state.cards
        .filter((card) => card.sectionId === params.sectionId)
        .filter((card) => !params.dueBefore || card.due <= params.dueBefore)
        .sort((a, b) => `${a.due}${a.createdAt}${a.id}`.localeCompare(`${b.due}${b.createdAt}${b.id}`));
      const items = filtered.slice(offset, offset + limit);
      const nextOffset = offset + items.length;
      return {
        items,
        nextCursor: nextOffset < filtered.length ? String(nextOffset) : null,
        hasMore: nextOffset < filtered.length
      };
    },
    async review(body) {
      const state = load();
      const existing = state.reviews.find((review) => review.clientReviewId === body.clientReviewId);
      if (existing) {
        const existingCard = state.cards.find((item) => item.id === body.cardId && item.sectionId === body.sectionId);
        return { nextDue: existingCard?.due ?? body.reviewedAt };
      }
      const card = state.cards.find((item) => item.id === body.cardId && item.sectionId === body.sectionId);
      if (!card) throw new Error("Card was not found.");
      const next = new Date(body.reviewedAt);
      const intervals = mockIntervalsByIntensity[state.settings.reviewIntensity];
      const days =
        body.rating === ReviewRating.Again
          ? intervals.again
          : body.rating === ReviewRating.Hard
            ? intervals.hard
            : body.rating === ReviewRating.Good
              ? intervals.good
              : intervals.easy;
      next.setDate(next.getDate() + days);
      card.due = next.toISOString();
      card.updatedAt = new Date().toISOString();
      card.state = "review";
      state.reviews.push(body);
      save(state);
      return { nextDue: card.due };
    },
    async speech() {
      throw new Error("Speech requires the Firebase emulator and VITE_API_BASE_URL.");
    }
  };

  function createDashboard(state: MockState): DashboardResponse {
    const today = new Date().toISOString().slice(0, 10);
    const reviewTrend = Array.from({ length: 7 }, (_, index) => {
        const date = new Date();
        date.setDate(date.getDate() - (6 - index));
        const key = date.toISOString().slice(0, 10);
        return {
          date: key,
          count: state.reviews.filter((review) => review.reviewedAt.startsWith(key)).length
        };
      });
      return {
        totals: {
          dueToday: state.sections.reduce((sum, section) => sum + section.dueToday, 0),
          reviewedToday: state.reviews.filter((review) => review.reviewedAt.startsWith(today)).length,
          streakDays: reviewTrend.filter((day) => day.count > 0).length,
          totalCards: state.cards.length
        },
        reviewTrend,
        sections: state.sections
      };
  }
}

const mockIntervalsByIntensity = {
  relaxed: { again: 0, hard: 2, good: 5, easy: 10 },
  standard: { again: 0, hard: 1, good: 3, easy: 7 },
  solid: { again: 0, hard: 1, good: 2, easy: 5 },
  exam: { again: 0, hard: 1, good: 1, easy: 4 }
} as const;
