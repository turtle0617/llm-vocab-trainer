import { useEffect, useMemo, useState } from "react";
import {
  BookOpen,
  ChevronRight,
  Trash2,
  Layers,
  Library,
  Plus,
  RotateCcw,
  Send,
  Sparkles
} from "lucide-react";
import type { DashboardResponse, GeneratedWord, SectionSummary, VocabCard } from "@vocab/shared";
import { ReviewRating } from "@vocab/shared";
import { api } from "./api";
import { cacheCards, cacheSections, getCachedCards, queueReview } from "./offline";

type View = "dashboard" | "sections" | "add" | "review";

export function App() {
  const [view, setView] = useState<View>("dashboard");
  const [dashboard, setDashboard] = useState<DashboardResponse | null>(null);
  const [sections, setSections] = useState<SectionSummary[]>([]);
  const [selectedSectionId, setSelectedSectionId] = useState<string>("");
  const [error, setError] = useState<string>("");

  const selectedSection = useMemo(
    () => sections.find((section) => section.id === selectedSectionId) ?? sections[0],
    [sections, selectedSectionId]
  );

  async function loadDashboard() {
    setError("");
    try {
      const next = await api.dashboard();
      setDashboard(next);
      setSections(next.sections);
      if (!selectedSectionId && next.sections[0]) setSelectedSectionId(next.sections[0].id);
      await cacheSections(next.sections);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load dashboard");
    }
  }

  useEffect(() => {
    void loadDashboard();
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
            <Layers size={18} /> Dashboard
          </button>
          <button className={view === "sections" ? "active" : ""} onClick={() => setView("sections")}>
            <BookOpen size={18} /> Sections
          </button>
          <button className={view === "add" ? "active" : ""} onClick={() => setView("add")}>
            <Plus size={18} /> Add Word
          </button>
          <button className={view === "review" ? "active" : ""} onClick={() => setView("review")}>
            <RotateCcw size={18} /> Review
          </button>
        </nav>
      </aside>

      <main className="main">
        {error && <div className="alert">{error}</div>}
        {view === "dashboard" && (
          <Dashboard
            dashboard={dashboard}
            onOpenSection={(id) => {
              setSelectedSectionId(id);
              setView("sections");
            }}
            onReview={(id) => {
              setSelectedSectionId(id);
              setView("review");
            }}
            onAdd={(id) => {
              setSelectedSectionId(id);
              setView("add");
            }}
          />
        )}
        {view === "sections" && (
          <Sections
            sections={sections}
            selectedSectionId={selectedSection?.id ?? ""}
            onCreated={async (section) => {
              setSections((current) => [section, ...current]);
              setSelectedSectionId(section.id);
              await loadDashboard();
            }}
            onSelect={setSelectedSectionId}
            onAdd={() => setView("add")}
            onReview={() => setView("review")}
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
          />
        )}
        {view === "review" && (
          <Review section={selectedSection} onDone={loadDashboard} />
        )}
      </main>
    </div>
  );
}

function Dashboard({
  dashboard,
  onOpenSection,
  onReview,
  onAdd
}: {
  dashboard: DashboardResponse | null;
  onOpenSection: (id: string) => void;
  onReview: (id: string) => void;
  onAdd: (id: string) => void;
}) {
  if (!dashboard) return <EmptyState title="Loading dashboard" />;

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Dashboard</p>
          <h1>今日複習</h1>
        </div>
      </header>
      <div className="stats-grid">
        <Stat label="今日到期" value={dashboard.totals.dueToday} />
        <Stat label="今日已複習" value={dashboard.totals.reviewedToday} />
        <Stat label="連續天數" value={dashboard.totals.streakDays} />
        <Stat label="總單字" value={dashboard.totals.totalCards} />
      </div>
      <div className="trend">
        {dashboard.reviewTrend.map((day) => (
          <div key={day.date} className="bar-wrap">
            <div className="bar" style={{ height: `${Math.max(8, day.count * 12)}px` }} />
            <span>{day.date.slice(5)}</span>
          </div>
        ))}
      </div>
      <SectionList sections={dashboard.sections} onOpen={onOpenSection} onReview={onReview} onAdd={onAdd} />
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
  const selected = sections.find((section) => section.id === selectedSectionId);

  async function createSection() {
    if (!name.trim()) return;
    const section = await api.createSection({ name: name.trim() });
    setName("");
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
      <header className="page-header">
        <div>
          <p className="eyebrow">Sections</p>
          <h1>單字庫</h1>
        </div>
      </header>
      <div className="split">
        <div className="panel">
          <div className="inline-form">
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="New section" />
            <button onClick={createSection}>
              <Plus size={18} />
            </button>
          </div>
          <div className="section-menu">
            {sections.map((section) => (
              <button
                key={section.id}
                className={section.id === selectedSectionId ? "active" : ""}
                onClick={() => onSelect(section.id)}
              >
                <span>{section.name}</span>
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
                <div className="actions">
                  <button onClick={onAdd}>
                    <Plus size={17} />
                    <span className="button-label">Add</span>
                  </button>
                  <button onClick={onReview}>
                    <RotateCcw size={17} />
                    <span className="button-label">Review</span>
                  </button>
                  <button className="danger ghost" onClick={deleteSelectedSection}>
                    <Trash2 size={17} />
                    <span className="button-label">Delete Deck</span>
                  </button>
                </div>
              </div>
              <div className="cards-list">
                {cards.map((card) => (
                  <article key={card.id} className="word-row">
                    <strong>{card.word}</strong>
                    <span>{card.content.entries[0]?.zhDefinition}</span>
                    <time>{new Date(card.due).toLocaleDateString()}</time>
                    <button className="icon-danger" title={`Delete ${card.word}`} onClick={() => deleteCard(card)}>
                      <Trash2 size={17} />
                    </button>
                  </article>
                ))}
              </div>
              {hasMore && <button className="load-more" onClick={() => loadCards(false)}>Load more</button>}
            </>
          ) : (
            <EmptyState title="Create your first section" />
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
  onAdded
}: {
  sections: SectionSummary[];
  selectedSectionId: string;
  onSectionChange: (id: string) => void;
  onAdded: () => void;
}) {
  const [word, setWord] = useState("");
  const [generated, setGenerated] = useState<GeneratedWord | null>(null);
  const [loading, setLoading] = useState(false);
  const canSubmit = selectedSectionId && word.trim();

  async function generate() {
    if (!canSubmit) return;
    setLoading(true);
    try {
      setGenerated(await api.generateWord({ word: word.trim(), sectionId: selectedSectionId, locale: "zh-TW" }));
    } finally {
      setLoading(false);
    }
  }

  async function addCard() {
    if (!generated || !selectedSectionId) return;
    await api.createCard({ sectionId: selectedSectionId, content: generated });
    setWord("");
    setGenerated(null);
    await onAdded();
  }

  return (
    <section className="page narrow">
      <header className="page-header">
        <div>
          <p className="eyebrow">Add Word</p>
          <h1>新增單字</h1>
        </div>
      </header>
      <div className="panel stack">
        <select value={selectedSectionId} onChange={(event) => onSectionChange(event.target.value)}>
          <option value="">Select section</option>
          {sections.map((section) => (
            <option key={section.id} value={section.id}>{section.name}</option>
          ))}
        </select>
        <div className="inline-form">
          <input value={word} onChange={(event) => setWord(event.target.value)} placeholder="English word or phrase" />
          <button disabled={!canSubmit || loading} onClick={generate}>
            <Sparkles size={18} /> Generate
          </button>
        </div>
      </div>
      {generated && (
        <GeneratedWordCard generated={generated} onAdd={addCard} />
      )}
    </section>
  );
}

function Review({ section, onDone }: { section?: SectionSummary; onDone: () => void }) {
  const [queue, setQueue] = useState<VocabCard[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [flipped, setFlipped] = useState(false);
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
      setQueue((existing) => (reset ? page.items : [...existing, ...page.items]));
      setCursor(page.nextCursor);
      setHasMore(page.hasMore);
      await cacheCards(page.items);
    } catch {
      const cached = await getCachedCards(section.id);
      setQueue(cached);
    }
  }

  useEffect(() => {
    setQueue([]);
    setCursor(null);
    setHasMore(false);
    setFlipped(false);
    void load(true);
  }, [section?.id]);

  async function rate(rating: ReviewRating) {
    if (!current || !section) return;
    const review = {
      cardId: current.id,
      sectionId: section.id,
      rating,
      reviewedAt: new Date().toISOString()
    };
    try {
      await api.review(review);
    } catch {
      await queueReview(review);
    }
    setQueue((existing) => existing.slice(1));
    setFlipped(false);
    if (queue.length < 6 && hasMore) void load(false);
    await onDone();
  }

  if (!section) return <EmptyState title="Select a section first" />;
  if (!current) return <EmptyState title={`${section.name} is done for now`} />;

  return (
    <section className="page review-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Review · {section.name}</p>
          <h1>{queue.length} due</h1>
        </div>
      </header>
      <button className={`review-card ${flipped ? "flipped" : ""}`} onClick={() => setFlipped(true)}>
        {!flipped ? (
          <span className="review-word">{current.word}</span>
        ) : (
          <div className="answer">
            <h2>{current.word}</h2>
            {current.content.entries.map((entry) => (
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
          </div>
        )}
      </button>
      {flipped && (
        <footer className="review-actions">
          <button className="again" onClick={() => rate(ReviewRating.Again)}>Again</button>
          <button className="hard" onClick={() => rate(ReviewRating.Hard)}>Hard</button>
          <button className="good" onClick={() => rate(ReviewRating.Good)}>Good</button>
          <button className="easy" onClick={() => rate(ReviewRating.Easy)}>Easy</button>
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
  onReview: (id: string) => void;
  onAdd: (id: string) => void;
}) {
  return (
    <div className="section-grid">
      {sections.map((section) => (
        <article key={section.id} className="section-card">
          <button className="section-open" onClick={() => onOpen(section.id)}>
            <h3>{section.name}</h3>
            <ChevronRight size={18} />
          </button>
          <p>{section.totalCards} words · {section.dueToday} due</p>
          <div className="actions">
            <button onClick={() => onReview(section.id)}><RotateCcw size={16} /> Review</button>
            <button onClick={() => onAdd(section.id)}><Plus size={16} /> Add</button>
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

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function EmptyState({ title }: { title: string }) {
  return <div className="empty">{title}</div>;
}
