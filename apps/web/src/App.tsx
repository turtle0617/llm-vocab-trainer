import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  BookOpen,
  CheckCircle2,
  ChevronRight,
  Layers,
  Library,
  LoaderCircle,
  LogOut,
  Plus,
  RotateCcw,
  Send,
  Settings,
  Volume2,
  Sparkles,
  Trash2,
  WifiOff
} from "lucide-react";
import type { DashboardResponse, GeneratedWord, SectionSummary, VocabCard } from "@vocab/shared";
import { ReviewRating } from "@vocab/shared";
import { api } from "./api";
import { createAppUpdateController, type AppUpdateController } from "./app-update";
import {
  getAuthStatus,
  getCurrentUserUid,
  isUsingMockAuth,
  signIn,
  signOut,
  subscribeAuthState,
  type AuthStatus
} from "./auth";
import { createBackgroundSyncScheduler, createForegroundTrigger, runExclusiveSync } from "./background-sync";
import { cacheCards, cacheSections, getCachedCards, getPendingReviewCount, queueReview, removeCachedCard } from "./offline";
import { syncPendingReviews } from "./sync";
import {
  cleanPodcastPaste,
  formatScheduledFeedback,
  getCardDueStatus,
  getCompactActionCopy,
  getDashboardAction,
  getDeckPrioritySections,
  getPrimarySection,
  getStatTone,
  getTrendScale,
  reviewIntensityPresets,
  type ReviewIntensityId
} from "./ui-logic";

type View = "dashboard" | "sections" | "add" | "review" | "settings";
type ToastState = { message: string; tone?: "success" | "warning" | "info" };
type EmptyAction = { label: string; onClick: () => void; variant?: "primary" | "secondary" | "review" | "add" };
type SpeechController = {
  playingText: string | null;
  speak: (text: string) => Promise<void>;
};
const PODCAST_PASTE_STORAGE_KEY = "vocab-pwa-from-podcast";

export function App() {
  const [authStatus, setAuthStatus] = useState<AuthStatus>("loading");
  const [authError, setAuthError] = useState("");
  const [bootstrapping, setBootstrapping] = useState(true);
  const [pendingReviewCount, setPendingReviewCount] = useState(0);
  const [view, setView] = useState<View>("dashboard");
  const [dashboard, setDashboard] = useState<DashboardResponse | null>(null);
  const [sections, setSections] = useState<SectionSummary[]>([]);
  const [selectedSectionId, setSelectedSectionId] = useState<string>("");
  const [syncVersion, setSyncVersion] = useState(0);
  const [error, setError] = useState<string>("");
  const [toast, setToast] = useState<ToastState | null>(null);
  const [appUpdateAvailable, setAppUpdateAvailable] = useState(shouldShowDevUpdateBanner);
  const [reviewIntensity, setReviewIntensity] = useState<ReviewIntensityId>("standard");
  const [settingsSaving, setSettingsSaving] = useState(false);
  const appUpdateControllerRef = useRef<AppUpdateController | null>(null);
  const syncInProgressRef = useRef(false);
  const syncLastCompletedAtRef = useRef(0);
  const foregroundSyncDebounceTimerRef = useRef<number | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const speech = useSpeechPlayer((message) => notify(message, "warning"));

  const selectedSection = useMemo(
    () => sections.find((section) => section.id === selectedSectionId) ?? getPrimarySection(sections),
    [sections, selectedSectionId]
  );

  function notify(message: string, tone: ToastState["tone"] = "success") {
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    setToast({ message, tone });
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, 3000);
  }

  function openAdd(sectionId?: string) {
    if (sectionId) setSelectedSectionId(sectionId);
    setView("add");
  }

  function openReview(sectionId?: string) {
    if (sectionId) setSelectedSectionId(sectionId);
    setView("review");
  }

  async function applyAppUpdate() {
    await appUpdateControllerRef.current?.applyUpdate();
  }

  async function loadDashboard() {
    setError("");
    try {
      const next = await api.dashboard();
      await applyDashboard(next);
    } catch (err) {
      setError(formatAppError(err));
    }
  }

  async function applyDashboard(next: DashboardResponse) {
    setDashboard(next);
    setSections(next.sections);
    if (!selectedSectionId && next.sections[0]) setSelectedSectionId(getPrimarySection(next.sections)?.id ?? "");
    await cacheSections(next.sections);
  }

  async function loadSettings() {
    try {
      const settings = await api.settings();
      setReviewIntensity(settings.reviewIntensity);
    } catch (err) {
      notify(formatAppError(err), "warning");
    }
  }

  async function updateReviewIntensity(nextIntensity: ReviewIntensityId) {
    setSettingsSaving(true);
    try {
      const settings = await api.updateSettings({ reviewIntensity: nextIntensity });
      setReviewIntensity(settings.reviewIntensity);
      notify(`Review intensity updated to ${Math.round(settings.desiredRetention * 100)}%`);
    } catch (err) {
      notify(formatAppError(err), "warning");
    } finally {
      setSettingsSaving(false);
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function refreshPendingCount() {
      setPendingReviewCount(await getPendingReviewCount(getCurrentUserUid()));
    }

    async function syncAuthenticatedApp(options: { showLoading: boolean; showToast: boolean; fullSync: boolean }) {
      await runExclusiveSync(syncInProgressRef, async () => {
        if (options.showLoading) setBootstrapping(true);
        if (options.showToast) notify("Syncing data...", "info");
        try {
          const syncResult = await syncPendingReviews();
          if (!cancelled && syncResult.status === "partial") {
            notify("Some offline reviews are still pending. They will sync after sign-in or reconnecting.", "warning");
          }
          if (!cancelled) {
            if (options.fullSync || syncLastCompletedAtRef.current === 0) {
              await loadDashboard();
              await loadSettings();
              syncLastCompletedAtRef.current = Date.now();
            } else {
              const delta = await api.sync({ since: new Date(syncLastCompletedAtRef.current).toISOString() });
              if (delta.dashboard) await applyDashboard(delta.dashboard);
              if (delta.settings) setReviewIntensity(delta.settings.reviewIntensity);
              syncLastCompletedAtRef.current = new Date(delta.serverSyncedAt).getTime();
            }
            await refreshPendingCount();
            if (syncResult.status === "complete") {
              setSyncVersion((value) => value + 1);
              if (options.showToast) notify("Sync complete");
            }
          }
        } finally {
          if (!cancelled && options.showLoading) setBootstrapping(false);
        }
      });
    }

    const unsubscribe = subscribeAuthState((nextStatus) => {
      if (cancelled) return;
      setAuthStatus(nextStatus);
      setAuthError("");
      void refreshPendingCount();
      if (nextStatus === "authenticated") {
        if (isUsingMockAuth()) {
          setBootstrapping(false);
          void loadDashboard();
          void loadSettings();
        } else {
          void syncAuthenticatedApp({ showLoading: true, showToast: false, fullSync: true });
        }
      } else {
        setBootstrapping(false);
      }
    });

    const backgroundSync = createBackgroundSyncScheduler({
      clearTimeout: (timerId) => window.clearTimeout(timerId),
      getAuthStatus,
      getLastCompletedAt: () => syncLastCompletedAtRef.current,
      getVisibilityState: () => document.visibilityState,
      now: Date.now,
      setTimeout: (callback, delay) => {
        foregroundSyncDebounceTimerRef.current = window.setTimeout(callback, delay);
        return foregroundSyncDebounceTimerRef.current;
      },
      sync: () => void syncAuthenticatedApp({ showLoading: false, showToast: true, fullSync: false })
    });

    const appUpdate = createAppUpdateController({
      onNeedRefresh: () => {
        if (!cancelled) setAppUpdateAvailable(true);
      }
    });
    appUpdateControllerRef.current = appUpdate;

    function checkForAppUpdate() {
      void appUpdate.checkForUpdate().catch(() => undefined);
    }

    const foregroundTrigger = createForegroundTrigger({
      addDocumentListener: document.addEventListener.bind(document),
      addWindowListener: window.addEventListener.bind(window),
      onForeground: () => {
        backgroundSync.schedule();
        checkForAppUpdate();
      },
      removeDocumentListener: document.removeEventListener.bind(document),
      removeWindowListener: window.removeEventListener.bind(window)
    });
    checkForAppUpdate();

    return () => {
      cancelled = true;
      unsubscribe();
      foregroundTrigger.dispose();
      appUpdateControllerRef.current = null;
      backgroundSync.dispose();
      foregroundSyncDebounceTimerRef.current = null;
      if (toastTimerRef.current) {
        window.clearTimeout(toastTimerRef.current);
        toastTimerRef.current = null;
      }
    };
  }, []);

  async function handleLogin(email: string, password: string) {
    setAuthError("");
    try {
      await signIn(email, password);
    } catch (err) {
      setAuthError(formatAppError(err));
    }
  }

  async function handleLogout() {
    await signOut();
    setDashboard(null);
    setSections([]);
    setSelectedSectionId("");
  }

  const appUpdateNotice = appUpdateAvailable ? <AppUpdateNotice onUpdate={() => void applyAppUpdate()} /> : null;

  if (authStatus === "loading" || bootstrapping) {
    return <LoadingState title="Loading account and syncing data" />;
  }

  if (authStatus === "anonymous" || authStatus === "requiresLogin") {
    return (
      <LoginView
        error={authError}
        pendingReviewCount={pendingReviewCount}
        requiresLogin={authStatus === "requiresLogin"}
        onLogin={handleLogin}
        appUpdateNotice={appUpdateNotice}
      />
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <Library size={28} />
          <span>vocab-pwa</span>
        </div>
        <nav className="nav">
          <button className={view === "dashboard" ? "active" : ""} onClick={() => setView("dashboard")}>
            <Layers size={18} /> Dashboard
          </button>
          <button className={view === "review" ? "active" : ""} onClick={() => openReview(selectedSection?.id)}>
            <RotateCcw size={18} /> Review
          </button>
          <button className={view === "add" ? "active" : ""} onClick={() => openAdd(selectedSection?.id)}>
            <Plus size={18} /> Add Word
          </button>
          <button className={view === "sections" ? "active" : ""} onClick={() => setView("sections")}>
            <BookOpen size={18} /> Decks
          </button>
          <button className={view === "settings" ? "active" : ""} onClick={() => setView("settings")}>
            <Settings size={18} /> Settings
          </button>
          <button onClick={handleLogout}>
            <LogOut size={18} /> Sign Out
          </button>
        </nav>
      </aside>

      <main className="main">
        {error && <Alert message={error} />}
        {toast && <Toast message={toast.message} tone={toast.tone} />}
        {appUpdateNotice}
        {view === "dashboard" && (
          <Dashboard
            dashboard={dashboard}
            onOpenSection={(id) => {
              setSelectedSectionId(id);
              setView("sections");
            }}
            onReview={openReview}
            onAdd={openAdd}
            onCreateSection={() => setView("sections")}
          />
        )}
        {view === "sections" && (
          <Sections
            sections={sections}
            selectedSectionId={selectedSection?.id ?? ""}
            onCreated={async (section) => {
              setSections((current) => [section, ...current]);
              setSelectedSectionId(section.id);
              notify(`Created "${section.name}"`);
              await loadDashboard();
            }}
            onSelect={setSelectedSectionId}
            onAdd={() => openAdd(selectedSection?.id)}
            onReview={() => openReview(selectedSection?.id)}
            onDeleted={async () => {
              await loadDashboard();
              setSelectedSectionId("");
            }}
            speech={speech}
          />
        )}
        {view === "add" && (
          <AddWord
            sections={sections}
            selectedSectionId={selectedSection?.id ?? ""}
            onSectionChange={setSelectedSectionId}
            onAdded={loadDashboard}
            onReview={openReview}
            onCreateSection={() => setView("sections")}
            speech={speech}
          />
        )}
        {view === "review" && (
          <Review
            section={selectedSection}
            onDone={loadDashboard}
            onAdd={() => openAdd(selectedSection?.id)}
            onDashboard={() => setView("dashboard")}
            notify={notify}
            syncVersion={syncVersion}
            speech={speech}
          />
        )}
        {view === "settings" && (
          <SettingsView intensity={reviewIntensity} saving={settingsSaving} onChange={updateReviewIntensity} />
        )}
      </main>
    </div>
  );
}

function useSpeechPlayer(onError: (message: string) => void): SpeechController {
  const [playingText, setPlayingText] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const requestIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  function stopCurrent() {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
      audioRef.current = null;
    }
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
    setPlayingText(null);
  }

  useEffect(() => {
    window.addEventListener("beforeunload", stopCurrent);
    return () => {
      window.removeEventListener("beforeunload", stopCurrent);
      stopCurrent();
    };
  }, []);

  async function speak(text: string) {
    const normalized = text.trim();
    if (!normalized || playingText === normalized) return;
    if (normalized.length > 200) {
      onError("Groq Orpheus supports up to 200 characters per request.");
      return;
    }

    let audio: HTMLAudioElement | null = null;
    let url: string | null = null;
    const requestId = requestIdRef.current + 1;
    const abortController = new AbortController();
    try {
      requestIdRef.current = requestId;
      stopCurrent();
      abortRef.current = abortController;
      setPlayingText(normalized);
      const blob = await api.speech({ text: normalized, voice: "hannah" }, { signal: abortController.signal });
      if (requestId !== requestIdRef.current) return;
      abortRef.current = null;
      url = URL.createObjectURL(blob);
      audio = new Audio(url);
      audioRef.current = audio;
      urlRef.current = url;
      audio.addEventListener("ended", () => {
        setPlayingText(null);
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = null;
        audioRef.current = null;
      });
      audio.addEventListener("error", () => {
        setPlayingText(null);
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = null;
        audioRef.current = null;
        onError("Speech playback failed. Please try again later.");
      });
      await audio.play();
    } catch (err) {
      if (abortRef.current === abortController) abortRef.current = null;
      if (url && urlRef.current === url) {
        URL.revokeObjectURL(url);
        urlRef.current = null;
      }
      if (audioRef.current === audio) audioRef.current = null;
      if (requestId !== requestIdRef.current) return;
      setPlayingText(null);
      if (isAbortError(err)) return;
      onError(formatAppError(err));
    }
  }

  return { playingText, speak };
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function AppUpdateNotice({ onUpdate }: { onUpdate: () => void }) {
  return (
    <InlineNotice
      tone="info"
      title="A new version is available"
      description="Update to reload the app and avoid using an older installed PWA shell."
      actions={[{ label: "Update now", onClick: onUpdate, variant: "primary" }]}
    />
  );
}

function readPodcastPastePreference() {
  try {
    return localStorage.getItem(PODCAST_PASTE_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

function shouldShowDevUpdateBanner() {
  return import.meta.env.DEV && new URLSearchParams(window.location.search).get("showUpdate") === "1";
}

function LoginView({
  error,
  pendingReviewCount,
  requiresLogin,
  onLogin,
  appUpdateNotice
}: {
  error: string;
  pendingReviewCount: number;
  requiresLogin: boolean;
  onLogin: (email: string, password: string) => Promise<void>;
  appUpdateNotice?: ReactNode;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!email.trim() || !password || submitting) return;
    setSubmitting(true);
    try {
      await onLogin(email.trim(), password);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="login-page">
      <form className="login-panel" onSubmit={submit}>
        <div className="brand login-brand">
          <Library size={28} />
          <span>vocab-pwa</span>
        </div>
        <div>
          <p className="eyebrow">AI vocabulary review</p>
          <h1>{requiresLogin ? "Sign in again" : "Sign in to vocab-pwa"}</h1>
          <p className="page-subtitle">
            {requiresLogin
              ? "Your session expired. Sign in again to continue syncing."
              : "Generate bilingual cards, review with FSRS scheduling, and keep progress synced offline-first."}
          </p>
        </div>
        {appUpdateNotice}
        {pendingReviewCount > 0 && (
          <InlineNotice
            tone="info"
            title={`${pendingReviewCount} offline reviews are waiting to sync`}
            description="After sign-in, offline reviews will sync before dashboard progress loads."
          />
        )}
        {error && <InlineNotice tone="error" title="Sign-in failed" description={error} />}
        <label htmlFor="login-email">Email</label>
        <input
          id="login-email"
          autoComplete="email"
          inputMode="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <label htmlFor="login-password">Password</label>
        <input
          id="login-password"
          autoComplete="current-password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <button className="primary-action" disabled={!email.trim() || !password || submitting}>
          {submitting ? <LoaderCircle className="spin" size={18} /> : null}
          Sign In
        </button>
      </form>
    </main>
  );
}

function Dashboard({
  dashboard,
  onOpenSection,
  onReview,
  onAdd,
  onCreateSection
}: {
  dashboard: DashboardResponse | null;
  onOpenSection: (id: string) => void;
  onReview: (id?: string) => void;
  onAdd: (id?: string) => void;
  onCreateSection: () => void;
}) {
  if (!dashboard) return <LoadingState title="Loading today's progress" />;

  const action = getDashboardAction(dashboard);
  const compactAction = getCompactActionCopy(dashboard);
  const primarySection = getPrimarySection(dashboard.sections);
  const prioritySections = getDeckPrioritySections(dashboard.sections);
  const trendScale = getTrendScale(dashboard.reviewTrend.map((day) => day.count));
  const primaryAction =
    action.kind === "review"
      ? () => onReview(primarySection?.id)
      : dashboard.sections.length > 0
        ? () => onAdd(primarySection?.id)
        : onCreateSection;

  return (
    <section className="page cockpit-page">
      <header className="page-header action-header cockpit-header">
        <div>
          <p className="eyebrow">AI-powered FSRS workspace</p>
          <h1>Dashboard</h1>
          <p className="page-subtitle">{action.description}</p>
        </div>
        <button
          className={
            action.kind === "done"
              ? "secondary-action"
              : action.kind === "review"
                ? "review-action"
                : "add-action"
          }
          onClick={primaryAction}
        >
          {action.kind === "review" ? <RotateCcw size={18} /> : <Sparkles size={18} />}
          {compactAction}
        </button>
      </header>

      <div className="cockpit-grid">
        <section className="panel stack cockpit-summary">
          <div>
            <p className="eyebrow">Due for review</p>
            <h2>Today</h2>
          </div>
          <div className="stats-grid">
            <Stat label="Due" value={dashboard.totals.dueToday} tone={getStatTone("dueToday")} />
            <Stat label="Reviewed" value={dashboard.totals.reviewedToday} tone={getStatTone("reviewedToday")} />
            <Stat label="Streak" value={dashboard.totals.streakDays} tone={getStatTone("streakDays")} />
            <Stat label="Words" value={dashboard.totals.totalCards} tone={getStatTone("totalCards")} />
          </div>
          <div className="trend compact-trend" aria-label="Review count for the last seven days">
            <div className="trend-axis" aria-hidden="true">
              <span>{trendScale.max}</span>
              <span>{trendScale.middle}</span>
              <span>0</span>
            </div>
            <div className="trend-bars">
              <div className="trend-grid" aria-hidden="true">
                <span />
                <span />
                <span />
              </div>
              {dashboard.reviewTrend.map((day) => (
                <div key={day.date} className="bar-wrap">
                  <div className="bar-slot">
                    <div
                      className={`bar ${day.count === 0 ? "empty-bar" : ""}`}
                      style={{ height: `${day.count === 0 ? 2 : Math.max(10, (day.count / trendScale.max) * 96)}px` }}
                      title={`${day.date.slice(5)}: ${day.count} cards`}
                    />
                  </div>
                  <span>{day.date.slice(5)}</span>
                </div>
              ))}
            </div>
            <span className="trend-unit">cards</span>
          </div>
        </section>

        <section className="panel stack cockpit-decks">
          <div className="detail-header">
            <div>
              <p className="eyebrow">Deck priority</p>
              <h2>Decks</h2>
            </div>
            <button className="secondary-action compact-button" onClick={onCreateSection}>
              <Plus size={16} />
              New Deck
            </button>
          </div>
          {prioritySections.length > 0 ? (
            <SectionList sections={prioritySections} onOpen={onOpenSection} onReview={onReview} onAdd={onAdd} compact />
          ) : (
            <EmptyState
              title="No decks yet"
              description="Create a deck first, then add words you want to remember long-term."
              primaryAction={{ label: "Create Deck", onClick: onCreateSection }}
            />
          )}
        </section>

        <section className="panel stack cockpit-actions">
          <div>
            <p className="eyebrow">Next action</p>
            <h2>{action.label}</h2>
            <p>{action.description}</p>
          </div>
          <button
            className={
              action.kind === "review"
                ? "review-action action-tile"
                : action.kind === "add"
                  ? "add-action action-tile"
                  : "secondary-action action-tile"
            }
            onClick={primaryAction}
          >
            {action.kind === "review" ? <RotateCcw size={20} /> : <Sparkles size={20} />}
            <span>{compactAction}</span>
          </button>
          <div className="quick-actions">
            <button className="secondary-action" onClick={() => onAdd(primarySection?.id)}>
              <Plus size={17} />
              Add Word
            </button>
            <button className={primarySection?.dueToday ? "review-action" : "secondary-action"} onClick={() => onReview(primarySection?.id)}>
              <RotateCcw size={17} />
              Review
            </button>
          </div>
          {primarySection && (
            <div className="focus-deck">
              <span>Focus deck</span>
              <strong>{primarySection.name}</strong>
              <small>
                {primarySection.dueToday} due · {primarySection.totalCards}{" "}
                {primarySection.totalCards === 1 ? "word" : "words"}
              </small>
            </div>
          )}
        </section>
      </div>
    </section>
  );
}

function Sections({
  sections,
  selectedSectionId,
  onCreated,
  onSelect,
  onAdd,
  onReview,
  onDeleted,
  speech
}: {
  sections: SectionSummary[];
  selectedSectionId: string;
  onCreated: (section: SectionSummary) => void;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onReview: () => void;
  onDeleted: () => void;
  speech: SpeechController;
}) {
  const [name, setName] = useState("");
  const [cards, setCards] = useState<VocabCard[]>([]);
  const [expandedCardId, setExpandedCardId] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [showCreate, setShowCreate] = useState(sections.length === 0);
  const selected = sections.find((section) => section.id === selectedSectionId);

  async function createSection() {
    if (!name.trim()) return;
    const section = await api.createSection({ name: name.trim() });
    setName("");
    setShowCreate(false);
    onCreated(section);
  }

  async function loadCards(reset = false) {
    if (!selectedSectionId) return;
    const page = await api.cards({
      sectionId: selectedSectionId,
      limit: 20,
      cursor: reset ? null : cursor
    });
    setCards((current) => (reset ? page.items : [...current, ...page.items]));
    setCursor(page.nextCursor);
    setHasMore(page.hasMore);
    await cacheCards(page.items);
  }

  async function deleteSelectedSection() {
    if (!selected) return;
    const ok = window.confirm(
      `This deck and its ${selected.totalCards} cards will be archived and removed from future reviews.`
    );
    if (!ok) return;
    await api.deleteSection(selected.id);
    setCards([]);
    await onDeleted();
  }

  async function deleteCard(card: VocabCard) {
    const ok = window.confirm(`Delete word "${card.word}" from this deck?`);
    if (!ok) return;
    await api.deleteCard(card.sectionId, card.id);
    setCards((current) => current.filter((item) => item.id !== card.id));
    setExpandedCardId((current) => (current === card.id ? null : current));
    await removeCachedCard(card.id);
    await onDeleted();
  }

  useEffect(() => {
    setCards([]);
    setExpandedCardId(null);
    setCursor(null);
    setHasMore(false);
    void loadCards(true);
  }, [selectedSectionId]);

  return (
    <section className="page">
      <header className="page-header action-header">
        <div>
          <p className="eyebrow">Deck library</p>
          <h1>Decks</h1>
          <p className="page-subtitle">Manage decks, inspect generated cards, and jump into review.</p>
        </div>
        <button className="secondary-action" onClick={() => setShowCreate((value) => !value)}>
          <Plus size={18} />
          New Deck
        </button>
      </header>
      <div className="split">
        <div className="panel section-side">
          {showCreate && (
            <div className="create-section">
              <label htmlFor="section-name">Deck name</label>
              <div className="inline-form">
                <input
                  id="section-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void createSection();
                  }}
                  placeholder="Business English"
                />
                <button disabled={!name.trim()} onClick={createSection}>
                  <Plus size={18} />
                </button>
              </div>
            </div>
          )}
          <div className="section-menu">
            {sections.map((section) => (
              <button
                key={section.id}
                className={section.id === selectedSectionId ? "active" : ""}
                onClick={() => onSelect(section.id)}
              >
                <span>{section.name}</span>
                <small>{section.dueToday > 0 ? `${section.dueToday} due` : "Done"}</small>
                <ChevronRight size={16} />
              </button>
            ))}
          </div>
        </div>
        <div className="panel large">
          {selected ? (
            <>
              <div className="detail-header">
                <div>
                  <h2>{selected.name}</h2>
                  <p>
                    {selected.totalCards} {selected.totalCards === 1 ? "word" : "words"} · {selected.dueToday} due today
                  </p>
                </div>
                <div className="actions section-actions">
                  <button className="add-action" onClick={onAdd}>
                    <Plus size={17} />
                    <span className="button-label">Add</span>
                  </button>
                  <button className={selected.dueToday > 0 ? "review-action" : "secondary-action"} onClick={onReview}>
                    <RotateCcw size={17} />
                    <span className="button-label">Review</span>
                  </button>
                  <button className="danger ghost" onClick={deleteSelectedSection}>
                    <Trash2 size={17} />
                    <span className="button-label">Delete Deck</span>
                  </button>
                </div>
              </div>
              {cards.length > 0 ? (
                <div className="cards-list">
                  {cards.map((card) => {
                    const isExpanded = expandedCardId === card.id;
                    return (
                      <article
                        key={card.id}
                        className={`word-row ${isExpanded ? "expanded" : ""}`}
                        role="button"
                        tabIndex={0}
                        aria-expanded={isExpanded}
                        aria-label={`${isExpanded ? "Collapse" : "Expand"} details for ${card.word}`}
                        onClick={() => setExpandedCardId((current) => (current === card.id ? null : card.id))}
                        onKeyDown={(event) => {
                          if (event.target !== event.currentTarget) return;
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            setExpandedCardId((current) => (current === card.id ? null : card.id));
                          }
                        }}
                      >
                        <div className="word-row-summary">
                          <div className="word-with-audio">
                            <strong>{card.word}</strong>
                            <SpeechButton text={card.word} speech={speech} label={`Play ${card.word}`} />
                          </div>
                          <span>{card.content.entries[0]?.zhDefinition}</span>
                          <time>{formatDueDate(card.due)}</time>
                          <span className={`status-pill ${getCardDueStatus(card).toLowerCase()}`}>
                            {getCardDueStatus(card)}
                          </span>
                          <button
                            className="icon-danger"
                            title={`Delete ${card.word}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              void deleteCard(card);
                            }}
                          >
                            <Trash2 size={17} />
                          </button>
                        </div>
                        {isExpanded && <WordDetails card={card} speech={speech} />}
                      </article>
                    );
                  })}
                </div>
              ) : (
                <EmptyState
                  title="This deck has no words yet"
                  description="After you add the first word, it will appear in today's review."
                  primaryAction={{ label: "Add Word", onClick: onAdd }}
                />
              )}
              {hasMore && <button className="load-more" onClick={() => loadCards(false)}>Load More</button>}
            </>
          ) : (
            <EmptyState
              title="Create a deck first"
              description="Decks keep words organized by topic, purpose, or difficulty."
              primaryAction={{ label: "New Deck", onClick: () => setShowCreate(true) }}
            />
          )}
        </div>
      </div>
    </section>
  );
}

function WordDetails({ card, speech }: { card: VocabCard; speech: SpeechController }) {
  return (
    <div className="word-details" onClick={(event) => event.stopPropagation()}>
      <dl className="word-meta">
        <div>
          <dt>Next review</dt>
          <dd>{formatDueDate(card.due)}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{getCardDueStatus(card)}</dd>
        </div>
      </dl>
      {card.content.entries.map((entry, index) => (
        <div key={`${entry.partOfSpeech}-${entry.zhDefinition}-${index}`} className="entry compact-entry">
          <span className="tag">{entry.partOfSpeech}</span>
          <p><strong>{entry.zhDefinition}</strong> · {entry.enDefinition}</p>
          {entry.examples.map((example) => (
            <blockquote key={example.en}>
              <span className="example-line">
                <span>{example.en}</span>
                <SpeechButton text={example.en} speech={speech} label="Play example" />
              </span>
              <small>{example.zh}</small>
            </blockquote>
          ))}
        </div>
      ))}
    </div>
  );
}

function AddWord({
  sections,
  selectedSectionId,
  onSectionChange,
  onAdded,
  onReview,
  onCreateSection,
  speech
}: {
  sections: SectionSummary[];
  selectedSectionId: string;
  onSectionChange: (id: string) => void;
  onAdded: () => void;
  onReview: (id?: string) => void;
  onCreateSection: () => void;
  speech: SpeechController;
}) {
  const [word, setWord] = useState("");
  const [fromPodcast, setFromPodcast] = useState(readPodcastPastePreference);
  const [generated, setGenerated] = useState<GeneratedWord | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const selectedSection = sections.find((section) => section.id === selectedSectionId);
  const canSubmit = Boolean(selectedSectionId && word.trim());

  function updateFromPodcast(enabled: boolean) {
    setFromPodcast(enabled);
    localStorage.setItem(PODCAST_PASTE_STORAGE_KEY, String(enabled));
    if (enabled) setWord((current) => cleanPodcastPaste(current));
  }

  async function generate() {
    if (!canSubmit || loading) return;
    setLoading(true);
    setError("");
    setSuccess("");
    try {
      setGenerated(await api.generateWord({ word: word.trim(), sectionId: selectedSectionId, locale: "zh-TW" }));
    } catch (err) {
      setGenerated(null);
      setError(formatAppError(err));
    } finally {
      setLoading(false);
    }
  }

  async function addCard() {
    if (!generated || !selectedSectionId) return;
    await api.createCard({ sectionId: selectedSectionId, content: generated });
    setSuccess(`Added to "${selectedSection?.name ?? "current deck"}"`);
    setWord("");
    setGenerated(null);
    await onAdded();
  }

  if (sections.length === 0) {
    return (
      <section className="page narrow">
        <EmptyState
          title="Create a deck first"
          description="You need a deck before adding generated word cards."
          primaryAction={{ label: "Create Deck", onClick: onCreateSection }}
        />
      </section>
    );
  }

  return (
    <section className="page add-word-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">AI generated</p>
          <h1>Add Word</h1>
          <p className="page-subtitle">Generate bilingual definitions and examples, then save the card into a deck.</p>
        </div>
      </header>
      {success && (
        <InlineNotice
          tone="success"
          title={success}
          actions={[
            { label: "Add another", onClick: () => setSuccess("") },
            { label: "Start review", onClick: () => onReview(selectedSectionId), variant: "review" }
          ]}
        />
      )}
      <div className="add-workbench">
        <div className="panel stack generator-panel">
          <div className="generator-topline">
            <label htmlFor="add-word-section">Deck</label>
            <label className="switch-row compact-switch">
              <span>Podcast paste cleanup</span>
              <input
                type="checkbox"
                role="switch"
                checked={fromPodcast}
                onChange={(event) => updateFromPodcast(event.target.checked)}
              />
            </label>
          </div>
          <select id="add-word-section" value={selectedSectionId} onChange={(event) => onSectionChange(event.target.value)}>
            <option value="">Choose a deck</option>
            {sections.map((section) => (
              <option key={section.id} value={section.id}>{section.name}</option>
            ))}
          </select>
          <div className="inline-form generator-form">
            <input
              value={word}
              onChange={(event) => setWord(event.target.value)}
              onPaste={(event) => {
                if (!fromPodcast) return;
                event.preventDefault();
                setWord(cleanPodcastPaste(event.clipboardData.getData("text")));
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !generated) void generate();
              }}
              placeholder="English word or phrase"
            />
            <button disabled={!canSubmit || loading} onClick={generate}>
              {loading ? <LoaderCircle className="spin" size={18} /> : <Sparkles size={18} />}
              {loading ? "Generating" : "Generate"}
            </button>
          </div>
          {error && (
            <InlineNotice
              tone="error"
              title="Generation failed"
              description={error}
              actions={[{ label: "Retry", onClick: generate, variant: "primary" }]}
            />
          )}
        </div>
        {generated ? (
          <GeneratedWordCard generated={generated} onAdd={addCard} speech={speech} />
        ) : (
          <div className="panel generated-placeholder">
            <Sparkles size={22} />
            <h2>AI card preview</h2>
            <p>Generated definitions and bilingual examples will appear here before you add them to the deck.</p>
          </div>
        )}
      </div>
    </section>
  );
}

function Review({
  section,
  onDone,
  onAdd,
  onDashboard,
  notify,
  syncVersion,
  speech
}: {
  section?: SectionSummary;
  onDone: () => void;
  onAdd: () => void;
  onDashboard: () => void;
  notify: (message: string, tone?: ToastState["tone"]) => void;
  syncVersion: number;
  speech: SpeechController;
}) {
  const [queue, setQueue] = useState<VocabCard[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [flipped, setFlipped] = useState(false);
  const [offline, setOffline] = useState(false);
  const [rating, setRating] = useState<ReviewRating | null>(null);
  const current = queue[0];

  async function load(reset = false) {
    if (!section) return;
    try {
      const page = await api.cards({
        sectionId: section.id,
        dueBefore: new Date().toISOString(),
        limit: 20,
        cursor: reset ? null : cursor
      });
      setOffline(false);
      setQueue((existing) => (reset ? page.items : [...existing, ...page.items]));
      setCursor(page.nextCursor);
      setHasMore(page.hasMore);
      await cacheCards(page.items);
    } catch {
      const cached = await getCachedCards(section.id);
      setOffline(true);
      setQueue(cached);
    }
  }

  async function rate(nextRating: ReviewRating) {
    if (!current || !section || rating) return;
    setRating(nextRating);
    const reviewedAt = new Date();
    const review = {
      clientReviewId: crypto.randomUUID(),
      cardId: current.id,
      sectionId: section.id,
      rating: nextRating,
      reviewedAt: reviewedAt.toISOString()
    };
    try {
      const result = await api.review(review);
      notify(formatScheduledFeedback(result.nextDue, reviewedAt));
    } catch {
      await queueReview(review, getCurrentUserUid());
      await removeCachedCard(current.id);
      notify("Saved offline. It will sync after sign-in or reconnecting.", "warning");
    }
    setQueue((existing) => existing.slice(1));
    setFlipped(false);
    setRating(null);
    if (queue.length < 6 && hasMore) void load(false);
    await onDone();
  }

  useEffect(() => {
    setQueue([]);
    setCursor(null);
    setHasMore(false);
    setFlipped(false);
    setOffline(false);
    void load(true);
  }, [section?.id, syncVersion]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const isTyping = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.tagName === "SELECT";
      if (isTyping || !current) return;

      if (event.code === "Space") {
        event.preventDefault();
        setFlipped(true);
      }

      if (!flipped) return;
      if (event.key === "1") void rate(ReviewRating.Again);
      if (event.key === "2") void rate(ReviewRating.Hard);
      if (event.key === "3") void rate(ReviewRating.Good);
      if (event.key === "4") void rate(ReviewRating.Easy);
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [current, flipped, rating]);

  if (!section) {
    return (
      <EmptyState
        title="Choose a deck first"
        description="Reviews load due cards from the currently selected deck."
        primaryAction={{ label: "Back to Dashboard", onClick: onDashboard }}
      />
    );
  }

  if (!current) {
    return (
      <section className="page review-page">
        <EmptyState
          title={`${section.name} is done for today`}
          description="There are no more due cards. Go back to the dashboard or add more learning material."
          primaryAction={{ label: "Back to Dashboard", onClick: onDashboard }}
          secondaryAction={{ label: "Add Word", onClick: onAdd }}
        />
      </section>
    );
  }

  return (
    <section className="page review-page">
      <header className="page-header action-header review-header">
        <div>
          <p className="eyebrow">Review · {section.name}</p>
          <h1>{queue.length} due</h1>
          <p className="page-subtitle">FSRS schedules the next review after you rate recall difficulty.</p>
        </div>
        {offline && <span className="offline-badge"><WifiOff size={16} /> Offline Mode</span>}
      </header>
      {!flipped ? (
        <div
          className="review-card review-front"
          role="button"
          tabIndex={0}
          onClick={() => setFlipped(true)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              setFlipped(true);
            }
          }}
        >
          <span className="review-card-label">Front side</span>
          <span className="review-word">{current.word}</span>
          <span className="review-hint">Click or press Space to reveal the answer</span>
        </div>
      ) : (
        <div className="review-card flipped">
          <span className="review-card-label">Back side</span>
          <ReviewAnswer card={current} speech={speech} />
        </div>
      )}
      {flipped && (
        <footer className="review-actions">
          {ratingButtons.map((button) => (
            <button
              key={button.rating}
              className={button.className}
              disabled={rating !== null}
              onClick={() => rate(button.rating)}
            >
              <strong>{button.label}</strong>
              <small>{button.hint}</small>
            </button>
          ))}
        </footer>
      )}
    </section>
  );
}

function SectionList({
  sections,
  onOpen,
  onReview,
  onAdd,
  compact = false
}: {
  sections: SectionSummary[];
  onOpen: (id: string) => void;
  onReview: (id?: string) => void;
  onAdd: (id?: string) => void;
  compact?: boolean;
}) {
  return (
    <div className={compact ? "deck-list" : "section-grid"}>
      {sections.map((section) => (
        <article key={section.id} className={compact ? "deck-row" : "section-card"}>
          <button className="section-open" onClick={() => onOpen(section.id)}>
            {compact && <span className="deck-icon"><BookOpen size={17} /></span>}
            <span className="deck-title">
              <h3>{section.name}</h3>
              {compact && <small>{section.totalCards} {section.totalCards === 1 ? "word" : "words"}</small>}
            </span>
            <ChevronRight size={18} />
          </button>
          <div className="section-metrics">
            <span>{section.totalCards} {section.totalCards === 1 ? "word" : "words"}</span>
            <span className={section.dueToday > 0 ? "metric-due" : ""}>{section.dueToday} due</span>
            <span>{section.reviewedToday} reviewed</span>
          </div>
          <div className={compact ? "deck-row-actions" : "actions"}>
            {section.dueToday > 0 ? (
              <button className="review-action" onClick={() => onReview(section.id)}><RotateCcw size={16} /> Review</button>
            ) : (
              <span className="done-pill"><CheckCircle2 size={15} /> Done</span>
            )}
            <button className="add-action" onClick={() => onAdd(section.id)}><Plus size={16} /> Add</button>
          </div>
        </article>
      ))}
    </div>
  );
}

function GeneratedWordCard({ generated, onAdd, speech }: { generated: GeneratedWord; onAdd: () => void; speech: SpeechController }) {
  return (
    <article className="generated-card">
      <div className="detail-header">
        <div>
          <p className="eyebrow">Generated card</p>
          <div className="heading-with-audio">
            <h2>{generated.word}</h2>
            <SpeechButton text={generated.word} speech={speech} label={`Play ${generated.word}`} />
          </div>
        </div>
        <button onClick={onAdd}><Send size={17} /> Add to Deck</button>
      </div>
      {generated.entries.map((entry) => (
        <div key={`${entry.partOfSpeech}-${entry.zhDefinition}`} className="entry">
          <span className="tag">{entry.partOfSpeech}</span>
          <div className="definition-block">
            <p><strong>{entry.zhDefinition}</strong></p>
            <p>{entry.enDefinition}</p>
          </div>
          <div className="example-grid">
            {entry.examples.map((example) => (
              <blockquote key={example.en}>
                <span className="example-line">
                  <span>{example.en}</span>
                  <SpeechButton text={example.en} speech={speech} label="Play example" />
                </span>
                <small>{example.zh}</small>
              </blockquote>
            ))}
          </div>
        </div>
      ))}
    </article>
  );
}

function ReviewAnswer({ card, speech }: { card: VocabCard; speech: SpeechController }) {
  return (
    <div className="answer">
      <div className="heading-with-audio">
        <h2>{card.word}</h2>
        <SpeechButton text={card.word} speech={speech} label={`Play ${card.word}`} />
      </div>
      {card.content.entries.map((entry, index) => (
        <ReviewEntry key={`${entry.partOfSpeech}-${entry.zhDefinition}`} entry={entry} isFirst={index === 0} speech={speech} />
      ))}
    </div>
  );
}

function ReviewEntry({ entry, isFirst, speech }: { entry: GeneratedWord["entries"][number]; isFirst: boolean; speech: SpeechController }) {
  return (
    <div className={`entry ${isFirst ? "compact-entry" : ""}`}>
      <span className="tag">{entry.partOfSpeech}</span>
      <p><strong>{entry.zhDefinition}</strong> · {entry.enDefinition}</p>
      {entry.examples.map((example) => (
        <blockquote key={example.en}>
          <span className="example-line">
            <span>{example.en}</span>
            <SpeechButton text={example.en} speech={speech} label="Play example" />
          </span>
          <small>{example.zh}</small>
        </blockquote>
      ))}
    </div>
  );
}

function SpeechButton({ text, speech, label }: { text: string; speech: SpeechController; label: string }) {
  const normalized = text.trim();
  const isPlaying = speech.playingText === normalized;
  return (
    <button
      className="speech-button"
      disabled={!normalized || isPlaying}
      title={label}
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        void speech.speak(normalized);
      }}
    >
      {isPlaying ? <LoaderCircle className="spin" size={16} /> : <Volume2 size={16} />}
    </button>
  );
}

function SettingsView({
  intensity,
  saving,
  onChange
}: {
  intensity: ReviewIntensityId;
  saving: boolean;
  onChange: (value: ReviewIntensityId) => void;
}) {
  const selected = reviewIntensityPresets.find((preset) => preset.id === intensity) ?? reviewIntensityPresets[1];

  return (
    <section className="page narrow">
      <header className="page-header">
        <div>
          <p className="eyebrow">Settings</p>
          <h1>Review Intensity</h1>
          <p className="page-subtitle">Adjust retention targets without exposing FSRS model parameters.</p>
        </div>
      </header>
      <div className="panel stack">
        <div className="preset-grid">
          {reviewIntensityPresets.map((preset) => (
            <button
              key={preset.id}
              className={`preset-option ${preset.id === selected.id ? "active" : ""}`}
              disabled={saving}
              onClick={() => onChange(preset.id)}
            >
              <strong>{preset.label}</strong>
              <span className={`retention-value retention-${preset.id}`}>{Math.round(preset.retention * 100)}%</span>
              <small>{preset.description}</small>
            </button>
          ))}
        </div>
        <InlineNotice
          tone="info"
          title={`Current setting: ${selected.label} ${Math.round(selected.retention * 100)}%`}
          description="Higher retention means stronger memory and more daily reviews. Lower retention reduces load but increases forgetting risk. This applies to future review scheduling and does not automatically reschedule existing cards."
        />
      </div>
    </section>
  );
}

function Stat({ label, value, tone = "info" }: { label: string; value: number; tone?: "danger" | "warning" | "success" | "info" }) {
  return (
    <div className={`stat ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function EmptyState({
  title,
  description,
  primaryAction,
  secondaryAction
}: {
  title: string;
  description?: string;
  primaryAction?: EmptyAction;
  secondaryAction?: EmptyAction;
}) {
  return (
    <div className="empty">
      <h2>{title}</h2>
      {description && <p>{description}</p>}
      {(primaryAction || secondaryAction) && (
        <div className="actions">
          {primaryAction && <button className={actionClassName(primaryAction.variant)} onClick={primaryAction.onClick}>{primaryAction.label}</button>}
          {secondaryAction && <button className="secondary-action" onClick={secondaryAction.onClick}>{secondaryAction.label}</button>}
        </div>
      )}
    </div>
  );
}

function LoadingState({ title }: { title: string }) {
  return (
    <div className="empty loading-state">
      <LoaderCircle className="spin" size={22} />
      <h2>{title}</h2>
    </div>
  );
}

function Alert({ message }: { message: string }) {
  return <div className="alert">{message}</div>;
}

function Toast({ message, tone = "success" }: ToastState) {
  return (
    <div className={`toast ${tone}`}>
      <span className={`toast-dot ${tone}`} />
      <span>{message}</span>
    </div>
  );
}

function InlineNotice({
  tone,
  title,
  description,
  actions = []
}: {
  tone: "success" | "error" | "info";
  title: string;
  description?: string;
  actions?: Array<EmptyAction>;
}) {
  return (
    <div className={`inline-notice ${tone}`}>
      <strong>{title}</strong>
      {description && <p>{description}</p>}
      {actions.length > 0 && (
        <div className="actions">
          {actions.map((action) => (
            <button
              key={action.label}
              className={actionClassName(action.variant)}
              onClick={action.onClick}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const ratingButtons = [
  { rating: ReviewRating.Again, label: "Again", hint: "Later today", className: "again" },
  { rating: ReviewRating.Hard, label: "Hard", hint: "Soon", className: "hard" },
  { rating: ReviewRating.Good, label: "Good", hint: "Normal", className: "good" },
  { rating: ReviewRating.Easy, label: "Easy", hint: "Later", className: "easy" }
] as const;

function formatDueDate(value: string) {
  return new Date(value).toLocaleDateString("zh-TW", { month: "numeric", day: "numeric" });
}

function actionClassName(variant: EmptyAction["variant"]) {
  if (variant === "secondary") return "secondary-action";
  if (variant === "review") return "review-action";
  if (variant === "add") return "add-action";
  return "primary-action";
}

function formatAppError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("Internal server error") || message.includes("Failed to fetch")) {
    return "Cannot connect to the API. Start the Firebase emulator or remove VITE_API_BASE_URL to use local mock mode.";
  }
  return message || "An unexpected error occurred.";
}
