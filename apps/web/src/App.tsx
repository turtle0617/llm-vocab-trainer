import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
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
import {
  getAuthStatus,
  getCurrentUserUid,
  isUsingMockAuth,
  signIn,
  signOut,
  subscribeAuthState,
  type AuthStatus
} from "./auth";
import { createBackgroundSyncScheduler, runExclusiveSync } from "./background-sync";
import { cacheCards, cacheSections, getCachedCards, getPendingReviewCount, queueReview, removeCachedCard } from "./offline";
import { syncPendingReviews } from "./sync";
import {
  cleanPodcastPaste,
  formatScheduledFeedback,
  getCardDueStatus,
  getDashboardAction,
  getPrimarySection,
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
  const [reviewIntensity, setReviewIntensity] = useState<ReviewIntensityId>("standard");
  const [settingsSaving, setSettingsSaving] = useState(false);
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
      notify(`複習強度已更新為 ${Math.round(settings.desiredRetention * 100)}%`);
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
        if (options.showToast) notify("正在同步資料...", "info");
        try {
          const syncResult = await syncPendingReviews();
          if (!cancelled && syncResult.status === "partial") {
            notify("部分離線複習尚未同步，登入或連線後會繼續同步。", "warning");
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
              if (options.showToast) notify("同步完成");
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

    window.addEventListener("online", backgroundSync.schedule);
    window.addEventListener("focus", backgroundSync.schedule);
    document.addEventListener("visibilitychange", backgroundSync.schedule);
    return () => {
      cancelled = true;
      unsubscribe();
      window.removeEventListener("online", backgroundSync.schedule);
      window.removeEventListener("focus", backgroundSync.schedule);
      document.removeEventListener("visibilitychange", backgroundSync.schedule);
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

  if (authStatus === "loading" || bootstrapping) {
    return <LoadingState title="正在載入帳號與同步資料" />;
  }

  if (authStatus === "anonymous" || authStatus === "requiresLogin") {
    return (
      <LoginView
        error={authError}
        pendingReviewCount={pendingReviewCount}
        requiresLogin={authStatus === "requiresLogin"}
        onLogin={handleLogin}
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
            <Layers size={18} /> 首頁
          </button>
          <button className={view === "sections" ? "active" : ""} onClick={() => setView("sections")}>
            <BookOpen size={18} /> 單字庫
          </button>
          <button className={view === "add" ? "active" : ""} onClick={() => openAdd(selectedSection?.id)}>
            <Plus size={18} /> 新增單字
          </button>
          <button className={view === "review" ? "active" : ""} onClick={() => openReview(selectedSection?.id)}>
            <RotateCcw size={18} /> 複習
          </button>
          <button className={view === "settings" ? "active" : ""} onClick={() => setView("settings")}>
            <Settings size={18} /> 設定
          </button>
          <button onClick={handleLogout}>
            <LogOut size={18} /> 登出
          </button>
        </nav>
      </aside>

      <main className="main">
        {error && <Alert message={error} />}
        {toast && <Toast message={toast.message} tone={toast.tone} />}
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
              notify(`已建立「${section.name}」`);
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
      onError("Groq Orpheus 單次最多支援 200 個字元。");
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
        onError("語音播放失敗，請稍後再試。");
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

function readPodcastPastePreference() {
  try {
    return localStorage.getItem(PODCAST_PASTE_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

function LoginView({
  error,
  pendingReviewCount,
  requiresLogin,
  onLogin
}: {
  error: string;
  pendingReviewCount: number;
  requiresLogin: boolean;
  onLogin: (email: string, password: string) => Promise<void>;
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
          <p className="eyebrow">登入</p>
          <h1>{requiresLogin ? "請重新登入" : "登入單字庫"}</h1>
          {requiresLogin && <p className="page-subtitle">登入狀態已過期，重新登入後會繼續同步資料。</p>}
        </div>
        {pendingReviewCount > 0 && (
          <InlineNotice
            tone="info"
            title={`有 ${pendingReviewCount} 筆離線複習待同步`}
            description="登入後會先同步離線複習，再載入首頁進度。"
          />
        )}
        {error && <InlineNotice tone="error" title="登入失敗" description={error} />}
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
          登入
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
  if (!dashboard) return <LoadingState title="正在載入今日進度" />;

  const action = getDashboardAction(dashboard);
  const primarySection = getPrimarySection(dashboard.sections);
  const trendScale = getTrendScale(dashboard.reviewTrend.map((day) => day.count));
  const primaryAction =
    action.kind === "review"
      ? () => onReview(primarySection?.id)
      : dashboard.sections.length > 0
        ? () => onAdd(primarySection?.id)
        : onCreateSection;

  return (
    <section className="page">
      <header className="page-header action-header">
        <div>
          <p className="eyebrow">首頁</p>
          <h1>今日複習</h1>
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
          {action.kind === "review" ? <RotateCcw size={18} /> : <Plus size={18} />}
          {action.label}
        </button>
      </header>
      <div className="stats-grid">
        <Stat label="今日到期" value={dashboard.totals.dueToday} />
        <Stat label="今日已複習" value={dashboard.totals.reviewedToday} />
        <Stat label="連續天數" value={dashboard.totals.streakDays} />
        <Stat label="總單字" value={dashboard.totals.totalCards} />
      </div>
      <div className="trend" aria-label="最近七天複習張數">
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
                  title={`${day.date.slice(5)}：${day.count} 張`}
                />
              </div>
              <span>{day.date.slice(5)}</span>
            </div>
          ))}
        </div>
        <span className="trend-unit">張</span>
      </div>
      {dashboard.sections.length > 0 ? (
        <SectionList sections={dashboard.sections} onOpen={onOpenSection} onReview={onReview} onAdd={onAdd} />
      ) : (
        <EmptyState
          title="還沒有牌組"
          description="先建立一個牌組，再加入要長期記住的單字。"
          primaryAction={{ label: "建立牌組", onClick: onCreateSection }}
        />
      )}
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
    const ok = window.confirm(`此牌組與其中 ${selected.totalCards} 張單字卡會被封存，之後不會出現在複習。`);
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
          <p className="eyebrow">單字庫</p>
          <h1>牌組與單字</h1>
        </div>
        <button className="secondary-action" onClick={() => setShowCreate((value) => !value)}>
          <Plus size={18} />
          New Section
        </button>
      </header>
      <div className="split">
        <div className="panel section-side">
          {showCreate && (
            <div className="create-section">
              <label htmlFor="section-name">牌組名稱</label>
              <div className="inline-form">
                <input
                  id="section-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void createSection();
                  }}
                  placeholder="例如：商務英文"
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
                <small>{section.dueToday > 0 ? `${section.dueToday} due` : "done"}</small>
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
                  <p>{selected.totalCards} words · {selected.dueToday} due today</p>
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
                        aria-label={`${isExpanded ? "收合" : "展開"} ${card.word} 詳細資訊`}
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
                            <SpeechButton text={card.word} speech={speech} label={`播放 ${card.word}`} />
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
                  title="這個牌組還沒有單字"
                  description="加入第一個單字後，它會立刻出現在今日複習。"
                  primaryAction={{ label: "新增單字", onClick: onAdd }}
                />
              )}
              {hasMore && <button className="load-more" onClick={() => loadCards(false)}>載入更多</button>}
            </>
          ) : (
            <EmptyState
              title="先建立一個牌組"
              description="牌組用來區分不同主題或難度的單字。"
              primaryAction={{ label: "New Section", onClick: () => setShowCreate(true) }}
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
          <dt>下次複習</dt>
          <dd>{formatDueDate(card.due)}</dd>
        </div>
        <div>
          <dt>狀態</dt>
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
                <SpeechButton text={example.en} speech={speech} label="播放例句" />
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
    setSuccess(`已加入「${selectedSection?.name ?? "目前牌組"}」`);
    setWord("");
    setGenerated(null);
    await onAdded();
  }

  if (sections.length === 0) {
    return (
      <section className="page narrow">
        <EmptyState
          title="先建立一個牌組"
          description="新增單字前，需要先有一個存放內容的牌組。"
          primaryAction={{ label: "建立牌組", onClick: onCreateSection }}
        />
      </section>
    );
  }

  return (
    <section className="page narrow">
      <header className="page-header">
        <div>
          <p className="eyebrow">新增單字</p>
          <h1>產生學習卡片</h1>
        </div>
      </header>
      {success && (
        <InlineNotice
          tone="success"
          title={success}
          actions={[
            { label: "繼續新增", onClick: () => setSuccess("") },
            { label: "開始複習", onClick: () => onReview(selectedSectionId), variant: "review" }
          ]}
        />
      )}
      <div className="panel stack">
        <select value={selectedSectionId} onChange={(event) => onSectionChange(event.target.value)}>
          <option value="">選擇牌組</option>
          {sections.map((section) => (
            <option key={section.id} value={section.id}>{section.name}</option>
          ))}
        </select>
        <label className="switch-row">
          <span>來自 podcast</span>
          <input
            type="checkbox"
            role="switch"
            checked={fromPodcast}
            onChange={(event) => updateFromPodcast(event.target.checked)}
          />
        </label>
        <div className="inline-form">
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
            {loading ? "產生中" : "Generate"}
          </button>
        </div>
        {error && (
          <InlineNotice
            tone="error"
            title="產生失敗"
            description={error}
            actions={[{ label: "重試", onClick: generate, variant: "primary" }]}
          />
        )}
      </div>
      {generated && (
        <GeneratedWordCard generated={generated} onAdd={addCard} speech={speech} />
      )}
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
      notify("已離線暫存，登入或連線後同步", "warning");
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
        title="先選擇一個牌組"
        description="複習會依照目前選取的牌組載入到期卡片。"
        primaryAction={{ label: "回單字庫", onClick: onDashboard }}
      />
    );
  }

  if (!current) {
    return (
      <section className="page review-page">
        <EmptyState
          title={`${section.name} 今天完成了`}
          description="沒有更多到期卡片。你可以回首頁看進度，或新增更多學習材料。"
          primaryAction={{ label: "回首頁", onClick: onDashboard }}
          secondaryAction={{ label: "新增單字", onClick: onAdd }}
        />
      </section>
    );
  }

  return (
    <section className="page review-page">
      <header className="page-header action-header">
        <div>
          <p className="eyebrow">複習 · {section.name}</p>
          <h1>{queue.length} due</h1>
        </div>
        {offline && <span className="offline-badge"><WifiOff size={16} /> 離線模式</span>}
      </header>
      {!flipped ? (
        <button className="review-card review-front" onClick={() => setFlipped(true)}>
          <span className="review-word">{current.word}</span>
          <span className="review-hint">點擊或按 Space 顯示答案</span>
        </button>
      ) : (
        <div className="review-card flipped">
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
  onAdd
}: {
  sections: SectionSummary[];
  onOpen: (id: string) => void;
  onReview: (id?: string) => void;
  onAdd: (id?: string) => void;
}) {
  return (
    <div className="section-grid">
      {sections.map((section) => (
        <article key={section.id} className="section-card">
          <button className="section-open" onClick={() => onOpen(section.id)}>
            <h3>{section.name}</h3>
            <ChevronRight size={18} />
          </button>
          <div className="section-metrics">
            <span>{section.totalCards} words</span>
            <span>{section.dueToday} due</span>
            <span>{section.reviewedToday} reviewed</span>
          </div>
          <div className="actions">
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
          <p className="eyebrow">Generated</p>
          <div className="heading-with-audio">
            <h2>{generated.word}</h2>
            <SpeechButton text={generated.word} speech={speech} label={`播放 ${generated.word}`} />
          </div>
        </div>
        <button onClick={onAdd}><Send size={17} /> Add</button>
      </div>
      {generated.entries.map((entry) => (
        <div key={`${entry.partOfSpeech}-${entry.zhDefinition}`} className="entry">
          <span className="tag">{entry.partOfSpeech}</span>
          <p><strong>{entry.zhDefinition}</strong> · {entry.enDefinition}</p>
          {entry.examples.map((example) => (
            <blockquote key={example.en}>
              <span className="example-line">
                <span>{example.en}</span>
                <SpeechButton text={example.en} speech={speech} label="播放例句" />
              </span>
              <small>{example.zh}</small>
            </blockquote>
          ))}
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
        <SpeechButton text={card.word} speech={speech} label={`播放 ${card.word}`} />
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
            <SpeechButton text={example.en} speech={speech} label="播放例句" />
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
          <p className="eyebrow">設定</p>
          <h1>複習強度</h1>
          <p className="page-subtitle">只調整保留率，不暴露 FSRS 模型參數。</p>
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
          title={`目前設定：${selected.label} ${Math.round(selected.retention * 100)}%`}
          description="越高代表記得更牢，但每天複習更多；越低代表複習較少，但忘記機率較高。此設定會套用到之後送出的複習排程，不會自動重排既有卡片。"
        />
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat">
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
  { rating: ReviewRating.Again, label: "Again", hint: "今天再看", className: "again" },
  { rating: ReviewRating.Hard, label: "Hard", hint: "較快複習", className: "hard" },
  { rating: ReviewRating.Good, label: "Good", hint: "正常", className: "good" },
  { rating: ReviewRating.Easy, label: "Easy", hint: "延後", className: "easy" }
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
    return "無法連線到 API。請確認 Firebase emulator 是否啟動，或移除 VITE_API_BASE_URL 使用本地 mock 模式。";
  }
  return message || "發生未預期的錯誤。";
}
