import { useEffect, useMemo, useState } from "react";
import {
  BookOpen,
  CheckCircle2,
  ChevronRight,
  Layers,
  Library,
  LoaderCircle,
  Plus,
  RotateCcw,
  Send,
  Settings,
  Sparkles,
  Trash2,
  WifiOff
} from "lucide-react";
import type { DashboardResponse, GeneratedWord, SectionSummary, VocabCard } from "@vocab/shared";
import { ReviewRating } from "@vocab/shared";
import { api } from "./api";
import { cacheCards, cacheSections, getCachedCards, queueReview } from "./offline";
import {
  formatScheduledFeedback,
  getCardDueStatus,
  getDashboardAction,
  getPrimarySection,
  reviewIntensityPresets,
  type ReviewIntensityId
} from "./ui-logic";

type View = "dashboard" | "sections" | "add" | "review" | "settings";
type ToastState = { message: string; tone?: "success" | "warning" };
type EmptyAction = { label: string; onClick: () => void; variant?: "primary" | "secondary" };

export function App() {
  const [view, setView] = useState<View>("dashboard");
  const [dashboard, setDashboard] = useState<DashboardResponse | null>(null);
  const [sections, setSections] = useState<SectionSummary[]>([]);
  const [selectedSectionId, setSelectedSectionId] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [toast, setToast] = useState<ToastState | null>(null);
  const [reviewIntensity, setReviewIntensity] = useState<ReviewIntensityId>("standard");
  const [settingsSaving, setSettingsSaving] = useState(false);

  const selectedSection = useMemo(
    () => sections.find((section) => section.id === selectedSectionId) ?? getPrimarySection(sections),
    [sections, selectedSectionId]
  );

  function notify(message: string, tone: ToastState["tone"] = "success") {
    setToast({ message, tone });
    window.setTimeout(() => setToast(null), 3000);
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
      setDashboard(next);
      setSections(next.sections);
      if (!selectedSectionId && next.sections[0]) setSelectedSectionId(getPrimarySection(next.sections)?.id ?? "");
      await cacheSections(next.sections);
    } catch (err) {
      setError(formatAppError(err));
    }
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
    void loadDashboard();
    void loadSettings();
  }, []);

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
          />
        )}
        {view === "review" && (
          <Review
            section={selectedSection}
            onDone={loadDashboard}
            onAdd={() => openAdd(selectedSection?.id)}
            onDashboard={() => setView("dashboard")}
            notify={notify}
          />
        )}
        {view === "settings" && (
          <SettingsView intensity={reviewIntensity} saving={settingsSaving} onChange={updateReviewIntensity} />
        )}
      </main>
    </div>
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
        <button className={action.kind === "done" ? "secondary-action" : "primary-action"} onClick={primaryAction}>
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
      <div className="trend" aria-label="最近七天複習量">
        {dashboard.reviewTrend.map((day) => (
          <div key={day.date} className="bar-wrap">
            <div className={`bar ${day.count === 0 ? "empty-bar" : ""}`} style={{ height: `${day.count === 0 ? 2 : Math.max(10, day.count * 12)}px` }} />
            <span>{day.date.slice(5)}</span>
          </div>
        ))}
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
  onDeleted
}: {
  sections: SectionSummary[];
  selectedSectionId: string;
  onCreated: (section: SectionSummary) => void;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onReview: () => void;
  onDeleted: () => void;
}) {
  const [name, setName] = useState("");
  const [cards, setCards] = useState<VocabCard[]>([]);
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
    const ok = window.confirm(`Delete deck "${selected.name}"? Cards in this deck will no longer appear.`);
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
    await onDeleted();
  }

  useEffect(() => {
    setCards([]);
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
                  <button onClick={onAdd}>
                    <Plus size={17} />
                    <span className="button-label">Add</span>
                  </button>
                  <button className={selected.dueToday > 0 ? "" : "secondary-action"} onClick={onReview}>
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
                  {cards.map((card) => (
                    <article key={card.id} className="word-row">
                      <strong>{card.word}</strong>
                      <span>{card.content.entries[0]?.zhDefinition}</span>
                      <time>{formatDueDate(card.due)}</time>
                      <span className={`status-pill ${getCardDueStatus(card).toLowerCase()}`}>{getCardDueStatus(card)}</span>
                      <button className="icon-danger" title={`Delete ${card.word}`} onClick={() => deleteCard(card)}>
                        <Trash2 size={17} />
                      </button>
                    </article>
                  ))}
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

function AddWord({
  sections,
  selectedSectionId,
  onSectionChange,
  onAdded,
  onReview,
  onCreateSection
}: {
  sections: SectionSummary[];
  selectedSectionId: string;
  onSectionChange: (id: string) => void;
  onAdded: () => void;
  onReview: (id?: string) => void;
  onCreateSection: () => void;
}) {
  const [word, setWord] = useState("");
  const [generated, setGenerated] = useState<GeneratedWord | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const selectedSection = sections.find((section) => section.id === selectedSectionId);
  const canSubmit = Boolean(selectedSectionId && word.trim());

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
            { label: "開始複習", onClick: () => onReview(selectedSectionId), variant: "primary" }
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
        <div className="inline-form">
          <input
            value={word}
            onChange={(event) => setWord(event.target.value)}
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
        <GeneratedWordCard generated={generated} onAdd={addCard} />
      )}
    </section>
  );
}

function Review({
  section,
  onDone,
  onAdd,
  onDashboard,
  notify
}: {
  section?: SectionSummary;
  onDone: () => void;
  onAdd: () => void;
  onDashboard: () => void;
  notify: (message: string, tone?: ToastState["tone"]) => void;
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
      cardId: current.id,
      sectionId: section.id,
      rating: nextRating,
      reviewedAt: reviewedAt.toISOString()
    };
    try {
      const result = await api.review(review);
      notify(formatScheduledFeedback(result.nextDue, reviewedAt));
    } catch {
      await queueReview(review);
      notify("已離線暫存，連線後同步", "warning");
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
  }, [section?.id]);

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
          <ReviewAnswer card={current} />
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
              <button onClick={() => onReview(section.id)}><RotateCcw size={16} /> Review</button>
            ) : (
              <span className="done-pill"><CheckCircle2 size={15} /> Done</span>
            )}
            <button className="secondary-action" onClick={() => onAdd(section.id)}><Plus size={16} /> Add</button>
          </div>
        </article>
      ))}
    </div>
  );
}

function GeneratedWordCard({ generated, onAdd }: { generated: GeneratedWord; onAdd: () => void }) {
  return (
    <article className="generated-card">
      <div className="detail-header">
        <div>
          <p className="eyebrow">Generated</p>
          <h2>{generated.word}</h2>
        </div>
        <button onClick={onAdd}><Send size={17} /> Add</button>
      </div>
      {generated.entries.map((entry) => (
        <div key={`${entry.partOfSpeech}-${entry.zhDefinition}`} className="entry">
          <span className="tag">{entry.partOfSpeech}</span>
          <p><strong>{entry.zhDefinition}</strong> · {entry.enDefinition}</p>
          {entry.examples.map((example) => (
            <blockquote key={example.en}>
              {example.en}
              <small>{example.zh}</small>
            </blockquote>
          ))}
        </div>
      ))}
    </article>
  );
}

function ReviewAnswer({ card }: { card: VocabCard }) {
  return (
    <div className="answer">
      <h2>{card.word}</h2>
      {card.content.entries.map((entry, index) => (
        <ReviewEntry key={`${entry.partOfSpeech}-${entry.zhDefinition}`} entry={entry} isFirst={index === 0} />
      ))}
    </div>
  );
}

function ReviewEntry({ entry, isFirst }: { entry: GeneratedWord["entries"][number]; isFirst: boolean }) {
  return (
    <div className={`entry ${isFirst ? "compact-entry" : ""}`}>
      <span className="tag">{entry.partOfSpeech}</span>
      <p><strong>{entry.zhDefinition}</strong> · {entry.enDefinition}</p>
      {entry.examples.map((example) => (
        <blockquote key={example.en}>
          {example.en}
          <small>{example.zh}</small>
        </blockquote>
      ))}
    </div>
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
              <span>{Math.round(preset.retention * 100)}%</span>
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
          {primaryAction && <button className={primaryAction.variant === "secondary" ? "secondary-action" : ""} onClick={primaryAction.onClick}>{primaryAction.label}</button>}
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
  return <div className={`toast ${tone}`}>{message}</div>;
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
              className={action.variant === "primary" ? "" : "secondary-action"}
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

function formatAppError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("Internal server error") || message.includes("Failed to fetch")) {
    return "無法連線到 API。請確認 Firebase emulator 是否啟動，或移除 VITE_API_BASE_URL 使用本地 mock 模式。";
  }
  return message || "發生未預期的錯誤。";
}
