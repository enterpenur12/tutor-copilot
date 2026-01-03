"use client";

import { useState } from "react";

const BACKEND = "https://tutor-copilot.onrender.com";

export default function Home() {
  const [rubric, setRubric] = useState("");
  const [studentWork, setStudentWork] = useState("");
  const [output, setOutput] = useState("");

  async function runAI() {
    setOutput("Running...");

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
    }
  }

  return (
    <main style={{ padding: 40, maxWidth: 900, margin: "0 auto" }}>
      <h1 style={{ fontSize: 28, fontWeight: 700 }}>Tutor Copilot</h1>

      <p style={{ marginTop: 10 }}>
        Paste rubric + student work, then click Run.
      </p>

      <h2 style={{ marginTop: 20 }}>Rubric</h2>
      <textarea
        value={rubric}
        onChange={(e) => setRubric(e.target.value)}
        rows={6}
        style={{ width: "100%", padding: 10 }}
      />

      <h2 style={{ marginTop: 20 }}>Student work</h2>
      <textarea
        value={studentWork}
        onChange={(e) => setStudentWork(e.target.value)}
        rows={10}
        style={{ width: "100%", padding: 10 }}
      />

      <button
        onClick={runAI}
        style={{ marginTop: 20, padding: 12, cursor: "pointer" }}
      >
        Run AI
      </button>

      <pre style={{ marginTop: 20, whiteSpace: "pre-wrap" }}>{output}</pre>
    </main>
  );
}