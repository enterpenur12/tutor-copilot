"use client";

import { useState } from "react";

export default function Home() {
  const [message, setMessage] = useState("");

  async function callBackend() {
    setMessage("Loading...");

    const res = await fetch("https://tutor-copilot.onrender.com/health");

    const data = await res.json();

    setMessage(data.message);
  }

  return (
    <main style={{ padding: 40 }}>
      <h1>Frontend is working</h1>

      <button
        onClick={callBackend}
        style={{ marginTop: 20, padding: 10 }}
      >
        Call Backend
      </button>

      <p style={{ marginTop: 20 }}>{message}</p>
    </main>
  );
}

