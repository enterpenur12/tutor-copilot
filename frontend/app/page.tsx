"use client";

import { useMemo, useState } from "react";

const BACKEND = "https://tutor-copilot.onrender.com";
const MAX_FILE_BYTES = 1_000_000;

const SAMPLE_RUBRIC = `Criteria:
- Accuracy: Claims are correct and supported.
- Clarity: Steps are explained and organized.
- Depth: Shows reasoning, not just answers.
- Mechanics: Grammar and formatting are clean.`;

const SAMPLE_WORK = `Student response:
The main cause is gravity, which pulls the object down. I calculated the slope as 2.5
by dividing rise over run. The graph shows a steady increase, so the trend is linear.`;

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

export default function Home() {
  const [rubric, setRubric] = useState("");
  const [studentWork, setStudentWork] = useState("");
  const [output, setOutput] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [uploadTarget, setUploadTarget] = useState<"rubric" | "student">(
    "student"
  );
  const [uploadMessage, setUploadMessage] = useState("");
  const [dropActive, setDropActive] = useState(false);

  const rubricStats = useMemo(
    () => ({ words: countWords(rubric), chars: rubric.length }),
    [rubric]
  );
  const studentStats = useMemo(
    () => ({ words: countWords(studentWork), chars: studentWork.length }),
    [studentWork]
  );

  async function runAI() {
    setOutput("Running...");
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

      const data = await res.json();
      setOutput(JSON.stringify(data, null, 2));
    } catch (e) {
      setOutput("Failed to fetch. Try again in 30 seconds.");
    } finally {
      setIsRunning(false);
    }
  }

  return (
    <main className="hud">
      <header className="hud__header">
        <div className="brand">
          <div className="brand__mark">TC</div>
          <div>
            <h1>Tutor Copilot</h1>
            <p>Precision HUD for rubric-first tutoring feedback.</p>
          </div>
        </div>
        <div className="status">
          <span className="status__dot" />
          <span>System online</span>
          <span className="status__chip">SECURE</span>
        </div>
      </header>

      <section className="hud__grid">
        <div className="panel panel--input">
          <div className="panel__head">
            <div className="panel__title">Rubric matrix</div>
            <div className="panel__meta">
              {rubricStats.words} words · {rubricStats.chars} chars
            </div>
            <button
              className="button button--ghost"
              onClick={() => setRubric("")}
            >
              Clear
            </button>
          </div>
          <textarea
            className="hud__textarea"
            value={rubric}
            onChange={(e) => setRubric(e.target.value)}
            rows={8}
            placeholder="Drop your rubric criteria, point values, or quality standards here."
          />
        </div>

        <div className="panel panel--input">
          <div className="panel__head">
            <div className="panel__title">Student work</div>
            <div className="panel__meta">
              {studentStats.words} words · {studentStats.chars} chars
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
            <div className="panel__title">File intake + quick tools</div>
            <div className="panel__meta">
              Max {Math.round(MAX_FILE_BYTES / 1024)}KB · .txt .md .csv .json
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
                if (uploadTarget === "rubric") {
                  setRubric(text);
                } else {
                  setStudentWork(text);
                }
                setUploadMessage(`Loaded ${file.name} into ${uploadTarget}.`);
              } catch (error) {
                setUploadMessage("File read failed. Try again.");
              }
            }}
          >
            <div>
              <div className="panel__title">Drag a file here</div>
              <div className="dropzone__hint">
                Auto-routes into rubric or student work.
              </div>
            </div>
            <div className="chip-row">
              <span className="chip">Secure intake</span>
              <span className="chip">Local parse</span>
            </div>
          </div>
          <div style={{ marginTop: 16 }} className="action-row">
            <select
              className="select"
              value={uploadTarget}
              onChange={(event) =>
                setUploadTarget(event.target.value as "rubric" | "student")
              }
            >
              <option value="rubric">Send to rubric</option>
              <option value="student">Send to student work</option>
            </select>
            <label className="button button--secondary">
              Upload file
              <input
                type="file"
                accept=".txt,.md,.csv,.json"
                hidden
                onChange={async (event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
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
                    if (uploadTarget === "rubric") {
                      setRubric(text);
                    } else {
                      setStudentWork(text);
                    }
                    setUploadMessage(`Loaded ${file.name} into ${uploadTarget}.`);
                  } catch (error) {
                    setUploadMessage("File read failed. Try again.");
                  }
                }}
              />
            </label>
            <button
              className="button button--ghost"
              onClick={() => {
                setRubric(SAMPLE_RUBRIC);
                setStudentWork(SAMPLE_WORK);
                setUploadMessage("Loaded sample rubric + student work.");
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
            <div className="panel__title">AI response</div>
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
            <div className="panel__title">Action console</div>
            <p className="action-meta">
              Send rubric + student work to your tutor AI backend. The payload
              stays unchanged for compatibility.
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
    </main>
  );
}
