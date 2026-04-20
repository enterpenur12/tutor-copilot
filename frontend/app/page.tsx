"use client";

import { useEffect, useMemo, useState } from "react";

const BACKEND = "https://tutor-copilot.onrender.com";
const MAX_FILE_BYTES = 1_000_000;
const ANALYTICS_STORAGE_KEY = "tcAnalyticsSnapshot";
const BROWSER_ID_STORAGE_KEY = "tcAnalyticsBrowserId";
const ANALYTICS_REFRESH_INTERVAL_MS = 30_000;
const FEEDBACK_PROMPT_TIMEOUT_MS = 9000;

const SAMPLE_RUBRIC = `Criteria:
- Accuracy: Claims are correct and supported.
- Clarity: Steps are explained and organized.
- Depth: Shows reasoning, not just answers.
- Mechanics: Grammar and formatting are clean.`;

const SAMPLE_WORK = `Student response:
The main cause is gravity, which pulls the object down. I calculated the slope as 2.5
by dividing rise over run. The graph shows a steady increase, so the trend is linear.`;

const SAMPLE_BEFORE = `Draft (before):
The author is saying that the community should recycle more. There are some examples
but the paragraphs are short. The conclusion repeats the introduction.`;

const SAMPLE_AFTER = `Draft (after):
The author argues that the community should recycle more, and they include specific
examples from the neighborhood program. The body paragraphs explain why the plan is
practical, and the conclusion restates the claim with a clear next step.`;

const RUBRIC_PRESETS = [
  { id: "blank", label: "Blank", value: "" },
  { id: "sample", label: "Sample rubric", value: SAMPLE_RUBRIC },
];

type Tone = "strict" | "balanced" | "friendly";

type ComparisonResult = {
  before_score: number;
  after_score: number;
  score_change: number;
  improvements: string[];
  remaining_gaps: string[];
  next_steps: { title: string; details: string }[];
  summary: string;
};

type ComparisonEntry = {
  id: string;
  createdAt: number;
  rubric: string;
  tone: Tone;
  draft_before: string;
  draft_after: string;
  result: ComparisonResult;
};

type AnalyticsSnapshot = {
  totalUsers: number;
  essaysAnalyzed: number;
  helpfulYes: number;
  helpfulNo: number;
  helpfulnessPercent: number;
};

const defaultAnalyticsSnapshot: AnalyticsSnapshot = {
  totalUsers: 0,
  essaysAnalyzed: 0,
  helpfulYes: 0,
  helpfulNo: 0,
  helpfulnessPercent: 0,
};

function countWords(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

async function readFileAsText(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Failed to read file."));
    reader.readAsText(file);
  });
}

function stripCodeFences(text: string) {
  return text.replace(/```json/gi, "").replace(/```/g, "").trim();
}

function cleanText(text: string) {
  return text
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\\//g, "/")
    .trim();
}

function formatList(title: string, items: unknown) {
  if (!Array.isArray(items) || items.length === 0) return "";
  const lines = items.map((item) => `- ${String(item)}`);
  return `${title}:\n${lines.join("\n")}`;
}

function formatFeedback(payload: unknown) {
  if (!payload || typeof payload !== "object") return "";
  const data = payload as Record<string, unknown>;
  const parts = [];
  if (typeof data.score === "number" || typeof data.score === "string") {
    parts.push(`Score: ${data.score}`);
  }
  const strengths = formatList("Strengths", data.strengths);
  if (strengths) parts.push(strengths);
  const weaknesses = formatList("Weaknesses", data.weaknesses);
  if (weaknesses) parts.push(weaknesses);
  const suggestions = formatList("Suggestions", data.suggestions);
  if (suggestions) parts.push(suggestions);
  return parts.join("\n\n");
}

function normalizeResponse(data: unknown) {
  if (!data) return "No response returned.";
  if (typeof data === "string") return cleanText(data);

  if (typeof data === "object") {
    const record = data as Record<string, unknown>;
    if (typeof record.feedback === "string") {
      const candidate = stripCodeFences(record.feedback);
      try {
        const parsed = JSON.parse(candidate);
        const formatted = formatFeedback(parsed);
        return formatted || JSON.stringify(parsed, null, 2);
      } catch {
        return cleanText(record.feedback);
      }
    }

    const formatted = formatFeedback(record);
    if (formatted) return formatted;
    return JSON.stringify(record, null, 2);
  }

  return String(data);
}

function formatScoreChange(value: number) {
  if (value > 0) return `+${value.toFixed(1)}`;
  if (value < 0) return value.toFixed(1);
  return "0.0";
}

function makeId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return String(Date.now());
}

function normalizeAnalyticsCount(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

function normalizeAnalyticsSnapshot(
  value: Partial<AnalyticsSnapshot> | null | undefined
) {
  return {
    totalUsers: normalizeAnalyticsCount(value?.totalUsers),
    essaysAnalyzed: normalizeAnalyticsCount(value?.essaysAnalyzed),
    helpfulYes: normalizeAnalyticsCount(value?.helpfulYes),
    helpfulNo: normalizeAnalyticsCount(value?.helpfulNo),
    helpfulnessPercent: normalizeAnalyticsCount(value?.helpfulnessPercent),
  };
}

function parseAnalyticsSnapshot(value: string | null) {
  if (!value) return defaultAnalyticsSnapshot;

  try {
    return normalizeAnalyticsSnapshot(
      JSON.parse(value) as Partial<AnalyticsSnapshot>
    );
  } catch {
    return defaultAnalyticsSnapshot;
  }
}

function getOrCreateBrowserId() {
  const existing = localStorage.getItem(BROWSER_ID_STORAGE_KEY);
  if (existing?.trim()) {
    return { browserId: existing, created: false };
  }
  const browserId = makeId();
  localStorage.setItem(BROWSER_ID_STORAGE_KEY, browserId);
  return { browserId, created: true };
}

async function fetchAnalytics() {
  const res = await fetch(`${BACKEND}/analytics`);
  if (!res.ok) {
    throw new Error("Failed to load analytics.");
  }
  const data = (await res.json()) as Partial<AnalyticsSnapshot>;
  return normalizeAnalyticsSnapshot(data);
}

async function postAnalytics(endpoint: string, body: Record<string, unknown>) {
  const res = await fetch(`${BACKEND}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error("Analytics update failed.");
  }
  const data = (await res.json()) as Partial<AnalyticsSnapshot>;
  return normalizeAnalyticsSnapshot(data);
}

export default function Home() {
  const [activeTab, setActiveTab] = useState<"feedback" | "compare">("feedback");
  const [rubricPreset, setRubricPreset] = useState("blank");
  const [rubric, setRubric] = useState("");
  const [studentWork, setStudentWork] = useState("");
  const [output, setOutput] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [uploadTarget, setUploadTarget] = useState<"rubric" | "student">(
    "student"
  );
  const [uploadMessage, setUploadMessage] = useState("");
  const [dropActive, setDropActive] = useState(false);

  const [tone, setTone] = useState<Tone>("balanced");
  const [draftBefore, setDraftBefore] = useState("");
  const [draftAfter, setDraftAfter] = useState("");
  const [comparisonResult, setComparisonResult] =
    useState<ComparisonResult | null>(null);
  const [compareError, setCompareError] = useState("");
  const [isComparing, setIsComparing] = useState(false);
  const [comparisonHistory, setComparisonHistory] = useState<ComparisonEntry[]>(
    []
  );
  const [analytics, setAnalytics] =
    useState<AnalyticsSnapshot>(defaultAnalyticsSnapshot);
  const [feedbackPromptOpen, setFeedbackPromptOpen] = useState(false);
  const [feedbackPending, setFeedbackPending] = useState(false);
  const [pendingFeedbackRunId, setPendingFeedbackRunId] = useState<
    string | null
  >(null);
  const [feedbackSubmitting, setFeedbackSubmitting] = useState(false);

  const rubricStats = useMemo(
    () => ({ words: countWords(rubric), chars: rubric.length }),
    [rubric]
  );
  const studentStats = useMemo(
    () => ({ words: countWords(studentWork), chars: studentWork.length }),
    [studentWork]
  );
  const draftBeforeStats = useMemo(
    () => ({ words: countWords(draftBefore), chars: draftBefore.length }),
    [draftBefore]
  );
  const draftAfterStats = useMemo(
    () => ({ words: countWords(draftAfter), chars: draftAfter.length }),
    [draftAfter]
  );
  useEffect(() => {
    localStorage.removeItem("comparisonHistory");
  }, []);

  useEffect(() => {
    let active = true;

    async function syncAnalytics() {
      const { browserId } = getOrCreateBrowserId();

      try {
        const registeredAnalytics = await postAnalytics(
          "/analytics/register-user",
          {
            browser_id: browserId,
          }
        );
        if (!active) return;
        persistAnalytics(registeredAnalytics);
      } catch {
        const fallbackAnalytics = parseAnalyticsSnapshot(
          localStorage.getItem(ANALYTICS_STORAGE_KEY)
        );
        if (!active) return;
        setAnalytics(fallbackAnalytics);
      }
    }

    void syncAnalytics();
    const intervalId = window.setInterval(() => {
      void fetchAnalytics()
        .then((snapshot) => {
          if (!active) return;
          persistAnalytics(snapshot);
        })
        .catch(() => {});
    }, ANALYTICS_REFRESH_INTERVAL_MS);

    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    if (!feedbackPromptOpen || !feedbackPending) return;

    const timer = window.setTimeout(() => {
      setFeedbackPromptOpen(false);
      setFeedbackPending(false);
      setPendingFeedbackRunId(null);
      setFeedbackSubmitting(false);
    }, FEEDBACK_PROMPT_TIMEOUT_MS);

    return () => window.clearTimeout(timer);
  }, [feedbackPromptOpen, feedbackPending]);

  function persistAnalytics(next: AnalyticsSnapshot) {
    setAnalytics(next);
    localStorage.setItem(ANALYTICS_STORAGE_KEY, JSON.stringify(next));
  }

  function updateRubric(nextValue: string) {
    setRubric(nextValue);
  }

  function applyRubricPreset(nextPreset: string) {
    setRubricPreset(nextPreset);
    const preset = RUBRIC_PRESETS.find((item) => item.id === nextPreset);
    if (preset) {
      setRubric(preset.value);
    }
  }

  function persistComparisonHistory(next: ComparisonEntry[]) {
    setComparisonHistory(next);
  }

  async function runAI() {
    if (!rubric.trim() || !studentWork.trim()) {
      setOutput("Please add both a rubric and student work to continue.");
      return;
    }
    setOutput("Analyzing draft...");
    setIsRunning(true);

    try {
      const res = await fetch(`${BACKEND}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rubric,
          student_work: studentWork,
        }),
      });

      if (!res.ok) {
        throw new Error("Run failed.");
      }

      const data = await res.json();
      setOutput(normalizeResponse(data));
      const runId = makeId();
      try {
        const snapshot = await postAnalytics("/analytics/run-success", {
          run_id: runId,
        });
        persistAnalytics(snapshot);
      } catch {}
      setPendingFeedbackRunId(runId);
      setFeedbackSubmitting(false);
      setFeedbackPending(true);
      setFeedbackPromptOpen(true);
    } catch {
      setOutput("Something went wrong. Please try again shortly.");
    } finally {
      setIsRunning(false);
    }
  }

  async function compareDrafts() {
    setIsComparing(true);
    setCompareError("");
    setComparisonResult(null);
    if (!rubric.trim() || !draftBefore.trim() || !draftAfter.trim()) {
      setCompareError("Please add a rubric, draft before, and draft after.");
      setIsComparing(false);
      return;
    }

    try {
      const res = await fetch(`${BACKEND}/compare`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rubric,
          draft_before: draftBefore,
          draft_after: draftAfter,
          tone,
        }),
      });

      const payload = await res.json();
      if (!payload?.ok) {
        setCompareError("We couldn't generate a comparison. Please try again.");
        return;
      }

      const result = payload.data as ComparisonResult;
      setComparisonResult(result);
      const entry: ComparisonEntry = {
        id: makeId(),
        createdAt: Date.now(),
        rubric,
        tone,
        draft_before: draftBefore,
        draft_after: draftAfter,
        result,
      };
      const nextHistory = [entry, ...comparisonHistory].slice(0, 25);
      persistComparisonHistory(nextHistory);
    } catch {
      setCompareError("Something went wrong. Please try again shortly.");
    } finally {
      setIsComparing(false);
    }
  }

  async function handleFileUpload(target: "rubric" | "student", file: File) {
    if (file.size > MAX_FILE_BYTES) {
      setUploadMessage(
        `File too large. Keep it under ${Math.round(
          MAX_FILE_BYTES / 1024
        )}KB.`
      );
      return;
    }
    try {
      const text = await readFileAsText(file);
      if (target === "rubric") {
        updateRubric(text);
      } else {
        setStudentWork(text);
      }
      setUploadMessage(`Loaded ${file.name} into ${target}.`);
    } catch {
      setUploadMessage("File read failed. Try again.");
    }
  }

  function restoreComparison(entry: ComparisonEntry) {
    setActiveTab("compare");
    setRubric(entry.rubric);
    setRubricPreset("blank");
    setTone(entry.tone);
    setDraftBefore(entry.draft_before);
    setDraftAfter(entry.draft_after);
    setComparisonResult(entry.result);
    setCompareError("");
  }

  function deleteComparison(entryId: string) {
    const next = comparisonHistory.filter((item) => item.id !== entryId);
    persistComparisonHistory(next);
  }

  function clearComparisonHistory() {
    persistComparisonHistory([]);
  }

  function submitHelpfulnessFeedback(answer: "yes" | "no") {
    if (!feedbackPending || !pendingFeedbackRunId || feedbackSubmitting) return;

    const runId = pendingFeedbackRunId;
    setFeedbackSubmitting(true);
    void postAnalytics("/analytics/helpfulness", {
      helpful: answer === "yes",
      run_id: runId,
    })
      .then((snapshot) => {
        persistAnalytics(snapshot);
      })
      .catch(() => {})
      .finally(() => {
        setFeedbackSubmitting(false);
      });
    setFeedbackPromptOpen(false);
    setFeedbackPending(false);
    setPendingFeedbackRunId(null);
  }

  const compareDisabled =
    isComparing ||
    !rubric.trim() ||
    !draftBefore.trim() ||
    !draftAfter.trim();

  return (
    <main className="hud">
      <aside className="analytics-panel" aria-label="Usage analytics">
        <div className="analytics-panel__eyebrow">Analytics</div>
        <div className="analytics-panel__grid">
          <div className="analytics-stat">
            <span className="analytics-stat__label analytics-stat__label--balanced">
              Total Users
            </span>
            <strong className="analytics-stat__value">
              {analytics.totalUsers}
            </strong>
          </div>
          <div className="analytics-stat">
            <span className="analytics-stat__label">Essays Analyzed</span>
            <strong className="analytics-stat__value">
              {analytics.essaysAnalyzed}
            </strong>
          </div>
          <div className="analytics-stat">
            <span className="analytics-stat__label">Helpfulness %</span>
            <strong className="analytics-stat__value">
              {analytics.helpfulnessPercent}%
            </strong>
          </div>
        </div>
        <div className="analytics-panel__footer">Updates after successful runs and answered feedback prompts.</div>
      </aside>

      <header className="hud__header">
        <div className="brand">
          <div className="brand__mark">TC</div>
          <div>
            <h1>Tutor Copilot</h1>
            <p>Rubric-aligned feedback and revision checks for student drafts.</p>
          </div>
        </div>
      </header>

      <div className="site-disclaimer">
        <span>For educational use only. Please do not submit personal, sensitive, or confidential information.</span>
        <span>User submissions are not stored after processing.</span>
      </div>

      <div className="tabs">
        <button
          className={`tab ${activeTab === "feedback" ? "tab--active" : ""}`}
          onClick={() => setActiveTab("feedback")}
        >
          Single Draft
        </button>
        <button
          className={`tab ${activeTab === "compare" ? "tab--active" : ""}`}
          onClick={() => setActiveTab("compare")}
        >
          Revision Comparison
        </button>
      </div>

      {activeTab === "feedback" ? (
        <section className="hud__grid">
          <div className="panel panel--input">
            <div className="panel__head">
              <div>
                <div className="panel__title">Rubric</div>
                <div className="panel__meta">
                  {rubricStats.words} words / {rubricStats.chars} chars
                </div>
              </div>
              <div className="panel__actions">
                <label className="field">
                  <span className="field__label">Rubric preset</span>
                  <select
                    className="select"
                    value={rubricPreset}
                    onChange={(e) => applyRubricPreset(e.target.value)}
                  >
                    {RUBRIC_PRESETS.map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.label}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="button button--ghost"
                  onClick={() => setRubric("")}
                >
                  Clear
                </button>
              </div>
            </div>
            <textarea
              className="hud__textarea"
              value={rubric}
              onChange={(e) => updateRubric(e.target.value)}
              rows={8}
              placeholder="Paste rubric criteria, point values, or quality standards."
            />
          </div>

          <div className="panel panel--input">
            <div className="panel__head">
              <div>
                <div className="panel__title">Student draft</div>
                <div className="panel__meta">
                  {studentStats.words} words / {studentStats.chars} chars
                </div>
              </div>
              <button
                className="button button--ghost"
                onClick={() => setStudentWork("")}
              >
                Clear
              </button>
            </div>
            <textarea
              className="hud__textarea"
              value={studentWork}
              onChange={(e) => setStudentWork(e.target.value)}
              rows={12}
              placeholder="Paste student response, essay, or step-by-step work."
            />
          </div>

          <div className="panel panel--controls">
            <div className="panel__head">
              <div>
                <div className="panel__title">Files and quick tools</div>
                <div className="panel__meta">
                  Target: {uploadTarget} / Max{" "}
                  {Math.round(MAX_FILE_BYTES / 1024)}KB
                </div>
              </div>
            </div>
            <div
              className={`dropzone ${dropActive ? "dropzone--active" : ""}`}
              onDragOver={(event) => {
                event.preventDefault();
                setDropActive(true);
              }}
              onDragLeave={() => setDropActive(false)}
              onDrop={async (event) => {
                event.preventDefault();
                setDropActive(false);
                const file = event.dataTransfer.files?.[0];
                if (!file) return;
                await handleFileUpload(uploadTarget, file);
              }}
            >
              <div>
                <div className="panel__title">Drop a file here</div>
                <div className="dropzone__hint">
                  We load text into the selected target.
                </div>
              </div>
              <div className="chip-row">
                <span className="chip">Text files only</span>
                <span className="chip">Local preview</span>
              </div>
            </div>
            <div style={{ marginTop: 16 }} className="action-row">
              <button
                className="button button--ghost"
                onClick={() => setUploadTarget("rubric")}
              >
                Route drops to rubric
              </button>
              <button
                className="button button--ghost"
                onClick={() => setUploadTarget("student")}
              >
                Route drops to student draft
              </button>
              <label className="button button--secondary">
                Upload to rubric
                <input
                  type="file"
                  accept=".txt,.md,.csv,.json"
                  hidden
                  onChange={async (event) => {
                    const file = event.target.files?.[0];
                    if (!file) return;
                    await handleFileUpload("rubric", file);
                  }}
                />
              </label>
              <label className="button button--secondary">
                Upload to student draft
                <input
                  type="file"
                  accept=".txt,.md,.csv,.json"
                  hidden
                  onChange={async (event) => {
                    const file = event.target.files?.[0];
                    if (!file) return;
                    await handleFileUpload("student", file);
                  }}
                />
              </label>
              <button
                className="button button--ghost"
                onClick={() => {
                  setRubricPreset("sample");
                  setRubric(SAMPLE_RUBRIC);
                  setStudentWork(SAMPLE_WORK);
                  setUploadMessage("Loaded sample rubric and student draft.");
                }}
              >
                Load sample
              </button>
              <button
                className="button button--ghost"
                onClick={() => {
                  setRubric("");
                  setStudentWork("");
                  setOutput("");
                  setUploadMessage("Cleared all fields.");
                }}
              >
                Reset all
              </button>
            </div>
            {uploadMessage ? (
              <div className="action-meta" style={{ marginTop: 10 }}>
                {uploadMessage}
              </div>
            ) : null}
          </div>

          <div className="panel panel--output">
            <div className="panel__head">
              <div className="panel__title">Output</div>
              <div className="action-row">
                <button
                  className="button button--ghost"
                  onClick={() => {
                    if (!output) return;
                    navigator.clipboard?.writeText(output);
                    setUploadMessage("Copied response to clipboard.");
                  }}
                >
                  Copy
                </button>
                <button
                  className="button button--ghost"
                  onClick={() => setOutput("")}
                >
                  Clear
                </button>
              </div>
            </div>
            <div className="output">
              <pre className="output__pre">
                {output || "Awaiting analysis..."}
              </pre>
            </div>
          </div>

          <div className="panel panel--actions">
            <div>
              <div className="panel__title">Run feedback</div>
              <p className="action-meta">
                Send rubric and student draft to your backend. The payload stays
                unchanged for compatibility.
              </p>
            </div>
            <div className="action-row">
              <button
                className="button button--primary"
                onClick={runAI}
                disabled={isRunning}
              >
                {isRunning ? "Running..." : "Run AI"}
              </button>
            </div>
            <div className="chip-row">
              <span className="chip">Endpoint</span>
              <span className="chip">{BACKEND}</span>
            </div>
            <div className="action-meta">
              <span className="badge">Note:</span> Avoid uploading files that
              exceed the size limit.
            </div>
          </div>
        </section>
      ) : (
        <section className="hud__grid">
          <div className="panel panel--full">
            <div className="panel__head">
              <div>
                <div className="panel__title">Rubric</div>
                <div className="panel__meta">
                  {rubricStats.words} words / {rubricStats.chars} chars
                </div>
              </div>
              <div className="panel__actions">
                <label className="field">
                  <span className="field__label">Rubric preset</span>
                  <select
                    className="select"
                    value={rubricPreset}
                    onChange={(e) => applyRubricPreset(e.target.value)}
                  >
                    {RUBRIC_PRESETS.map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.label}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="button button--ghost"
                  onClick={() => setRubric("")}
                >
                  Clear
                </button>
              </div>
            </div>
            <textarea
              className="hud__textarea"
              value={rubric}
              onChange={(e) => updateRubric(e.target.value)}
              rows={8}
              placeholder="Paste rubric criteria, point values, or quality standards."
            />
          </div>

          <div className="panel panel--full">
            <div className="panel__head">
              <div>
                <div className="panel__title">Drafts</div>
                <div className="panel__meta">
                  Before: {draftBeforeStats.words} words /{" "}
                  {draftBeforeStats.chars} chars | After:{" "}
                  {draftAfterStats.words} words / {draftAfterStats.chars} chars
                </div>
              </div>
              <div className="panel__actions">
                <label className="field">
                  <span className="field__label">Tone</span>
                  <select
                    className="select"
                    value={tone}
                    onChange={(e) => setTone(e.target.value as Tone)}
                  >
                    <option value="strict">Strict</option>
                    <option value="balanced">Balanced</option>
                    <option value="friendly">Friendly</option>
                  </select>
                </label>
                <button
                  className="button button--ghost"
                  onClick={() => {
                    setDraftBefore("");
                    setDraftAfter("");
                  }}
                >
                  Clear drafts
                </button>
                <button
                  className="button button--primary"
                  onClick={compareDrafts}
                  disabled={compareDisabled}
                >
                  {isComparing ? "Comparing revisions..." : "Compare"}
                </button>
              </div>
            </div>
            <div className="draft-grid">
              <div>
                <label className="field">
                  <span className="field__label">Draft 1 (Before)</span>
                  <textarea
                    className="hud__textarea"
                    value={draftBefore}
                    onChange={(e) => setDraftBefore(e.target.value)}
                    rows={8}
                    placeholder="Paste the earlier draft."
                  />
                </label>
              </div>
              <div>
                <label className="field">
                  <span className="field__label">Draft 2 (After)</span>
                  <textarea
                    className="hud__textarea"
                    value={draftAfter}
                    onChange={(e) => setDraftAfter(e.target.value)}
                    rows={8}
                    placeholder="Paste the revised draft."
                  />
                </label>
              </div>
            </div>
            <div className="action-row" style={{ marginTop: 12 }}>
              <button
                className="button button--ghost"
                onClick={() => {
                  setRubricPreset("sample");
                  setRubric(SAMPLE_RUBRIC);
                  setDraftBefore(SAMPLE_BEFORE);
                  setDraftAfter(SAMPLE_AFTER);
                }}
              >
                Load sample drafts
              </button>
              <button
                className="button button--ghost"
                onClick={() => setComparisonResult(null)}
              >
                Clear report
              </button>
            </div>
          </div>

          <div className="panel panel--span-7">
            <div className="panel__head">
              <div className="panel__title">Comparison report</div>
            </div>
            {isComparing ? (
              <div className="state">Comparing revisions...</div>
            ) : null}
            {compareError ? <div className="alert">{compareError}</div> : null}
            {comparisonResult ? (
              <div className="report">
                <div className="report__scores">
                  <div className="score-card">
                    <div className="score-card__label">Before</div>
                    <div className="score-card__value">
                      {comparisonResult.before_score.toFixed(1)}
                    </div>
                  </div>
                  <div className="score-card">
                    <div className="score-card__label">After</div>
                    <div className="score-card__value">
                      {comparisonResult.after_score.toFixed(1)}
                    </div>
                  </div>
                  <div className="score-card score-card--change">
                    <div className="score-card__label">Score change</div>
                    <div className="score-card__value">
                      {formatScoreChange(comparisonResult.score_change)}
                    </div>
                  </div>
                </div>

                <div className="report__section">
                  <h3>Improvements</h3>
                  {comparisonResult.improvements.length ? (
                    <ul className="list">
                      {comparisonResult.improvements.map((item, index) => (
                        <li key={`imp-${index}`}>{item}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="action-meta">No major improvements noted.</p>
                  )}
                </div>

                <div className="report__section">
                  <h3>Remaining gaps</h3>
                  {comparisonResult.remaining_gaps.length ? (
                    <ul className="list">
                      {comparisonResult.remaining_gaps.map((item, index) => (
                        <li key={`gap-${index}`}>{item}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="action-meta">No major gaps noted.</p>
                  )}
                </div>

                <div className="report__section">
                  <h3>Next steps</h3>
                  {comparisonResult.next_steps.length ? (
                    <div className="next-steps">
                      {comparisonResult.next_steps.map((step, index) => (
                        <div key={`step-${index}`} className="next-step">
                          <div className="next-step__title">{step.title}</div>
                          <div className="next-step__details">
                            {step.details}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="action-meta">
                      No next steps were provided.
                    </p>
                  )}
                </div>

                <div className="report__section">
                  <h3>Summary</h3>
                  <p>{comparisonResult.summary}</p>
                </div>
              </div>
            ) : (
              <div className="state">Run a comparison to see the report.</div>
            )}
          </div>

          <div className="panel panel--span-5">
            <div className="panel__head">
              <div className="panel__title">History</div>
              <button
                className="button button--ghost"
                onClick={clearComparisonHistory}
                disabled={comparisonHistory.length === 0}
              >
                Clear all
              </button>
            </div>
            {comparisonHistory.length === 0 ? (
              <div className="state">No comparisons saved yet.</div>
            ) : (
              <div className="history-list">
                {comparisonHistory.map((entry) => (
                  <div key={entry.id} className="history-card">
                    <div>
                      <div className="history-card__title">
                        {entry.result.before_score.toFixed(1)} to{" "}
                        {entry.result.after_score.toFixed(1)} (
                        {formatScoreChange(entry.result.score_change)})
                      </div>
                      <div className="history-card__meta">
                        {new Date(entry.createdAt).toLocaleString()}
                      </div>
                    </div>
                    <div className="action-row">
                      <button
                        className="button button--ghost"
                        onClick={() => restoreComparison(entry)}
                      >
                        Restore
                      </button>
                      <button
                        className="button button--ghost"
                        onClick={() => deleteComparison(entry.id)}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      )}

      <div
        className={`feedback-prompt ${
          feedbackPromptOpen ? "feedback-prompt--visible" : ""
        }`}
        role="status"
        aria-live="polite"
        aria-hidden={!feedbackPromptOpen}
      >
        <div className="feedback-prompt__question">
          Did this feedback help improve your essay?
        </div>
        <div className="feedback-prompt__actions">
          <button
            className="button button--secondary"
            onClick={() => submitHelpfulnessFeedback("yes")}
            type="button"
            disabled={feedbackSubmitting}
          >
            Yes
          </button>
          <button
            className="button button--ghost"
            onClick={() => submitHelpfulnessFeedback("no")}
            type="button"
            disabled={feedbackSubmitting}
          >
            No
          </button>
        </div>
      </div>
    </main>
  );
}
