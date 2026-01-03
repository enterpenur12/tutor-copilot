import json
import os
from typing import Literal

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from openai import OpenAI

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://tutor-copilot.vercel.app",
        "http://localhost:3000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class RunRequest(BaseModel):
    rubric: str
    student_work: str


class CompareRequest(BaseModel):
    rubric: str
    draft_before: str
    draft_after: str
    tone: Literal["strict", "balanced", "friendly"]

@app.get("/health")
def health():
    return {"message": "Backend is working"}

@app.post("/run")
def run(req: RunRequest):
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        return {"error": "OPENAI_API_KEY missing in Render environment."}

    client = OpenAI(api_key=api_key)

    prompt = f"""
    IMPORTANT CALIBRATION RULE (READ CAREFULLY):

In many real classrooms, a score of 100 does NOT require perfection.
A score of 100 is appropriate when:
- The student clearly met the purpose of the assignment
- The writing is strong, clear, and complete
- Any rubric gaps are minor and not meaningful
- There is no clear reason a teacher would deduct points

If the work feels “fully successful” and you would not reasonably mark it down,
you SHOULD assign a score between 95 and 100.

Do NOT cap strong essays in the high 80s simply because small rubric elements are missing.
Think like a real teacher deciding whether there is a justification to take points off.
You are an AI writing feedback assistant acting as a thoughtful, experienced high school teacher.

Your role is to evaluate student writing using the rubric as a GUIDE, not a checklist.
Real teachers use professional judgment — you must do the same.

CORE PRINCIPLES (VERY IMPORTANT):
- Use the rubric to guide evaluation, but apply human-like judgment.
- Do NOT penalize students harshly for minor omissions if overall quality is strong.
- Consider clarity, insight, effort, and coherence in addition to rubric alignment.
- Assume this is a draft unless explicitly stated otherwise.
- Be fair, reasonable, and encouraging while remaining honest.

WHAT YOU MUST NOT DO:
- Do NOT rewrite the students work.
- Do NOT provide model answers or sentences to copy.
- Do NOT invent rubric criteria.
- Do NOT mention AI, OpenAI, or ChatGPT.

SCORING PHILOSOPHY (THIS MATTERS MOST):
- Score MUST be between 65 and 100.
- NEVER assign a score below 65.
- Use these grade bands with PROFESSIONAL LENIENCY:
  
  • 90–100 (A):
    Student meets most rubric expectations and shows strong understanding.
    Minor rubric gaps should NOT prevent an A if the writing is thoughtful, clear, and effective.

  • 80–89 (B):
    Student generally meets rubric expectations but has noticeable gaps,
    underdeveloped sections, or inconsistent execution.

  • 65–79 (C):
    Student misses several important rubric elements or shows weak clarity,
    but still demonstrates some understanding and effort.

- Avoid extreme scores unless clearly justified.
- Be conservative with 95+ scores, but do not be afraid to give low 90s for solid work.

EVALUATION GUIDANCE (THINK LIKE A TEACHER):
- If an essay is strong overall, do NOT over-penalize for missing small rubric items.
- If ideas are thoughtful but organization is weak, balance those factors.
- If the rubric is vague, rely on clarity, reasoning, and communication quality.
- Focus on whether the student is on the right track.

Rubric:
{req.rubric}

Student submission:
{req.student_work}

Return ONLY valid JSON with keys:
- score (65-100 number)
- strengths (array of strings)
- weaknesses (array of strings)
- suggestions (array of strings)
"""

    response = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": prompt}],
        temperature=0.3,
    )

    return {"feedback": response.choices[0].message.content}


def _strip_code_fences(text: str) -> str:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.replace("```json", "").replace("```", "").strip()
    return cleaned


def _parse_json_once(raw_text: str) -> dict:
    cleaned = _strip_code_fences(raw_text)
    return json.loads(cleaned)


def _normalize_compare_payload(data: dict) -> dict:
    def clamp_score(value: float) -> float:
        return max(65.0, min(100.0, value))

    before = clamp_score(float(data.get("before_score", 65)))
    after = clamp_score(float(data.get("after_score", before)))
    improvements = [
        str(item) for item in data.get("improvements", []) if str(item).strip()
    ]
    remaining_gaps = [
        str(item) for item in data.get("remaining_gaps", []) if str(item).strip()
    ]
    next_steps = []
    for item in data.get("next_steps", []) or []:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title", "")).strip()
        details = str(item.get("details", "")).strip()
        if title or details:
            next_steps.append({"title": title or "Next step", "details": details})
    summary = str(data.get("summary", "")).strip()

    return {
        "before_score": before,
        "after_score": after,
        "score_change": after - before,
        "improvements": improvements,
        "remaining_gaps": remaining_gaps,
        "next_steps": next_steps,
        "summary": summary,
    }


def _build_compare_prompt(req: CompareRequest, json_only: bool) -> str:
    strict_json = ""
    if json_only:
        strict_json = "\nReturn ONLY valid JSON. Do not include markdown or commentary.\n"

    return f"""
You are an experienced high school teacher providing rubric-guided feedback.
Apply professional leniency: judge holistically, not as a checklist.

Tone: {req.tone}

Task:
- Score BOTH drafts (before and after) using the rubric as a guide.
- Scores must be between 65 and 100. Never go below 65.
- Compare the drafts to identify improvements and remaining gaps.
- Do NOT rewrite or edit the drafts.
- Do NOT generate a full revised essay.

Rubric:
{req.rubric}

Draft BEFORE:
{req.draft_before}

Draft AFTER:
{req.draft_after}

Return JSON with this shape:
{{
  "before_score": number,
  "after_score": number,
  "score_change": number,
  "improvements": string[],
  "remaining_gaps": string[],
  "next_steps": [{{"title": string, "details": string}}],
  "summary": string
}}
{strict_json}
""".strip()


@app.post("/compare")
def compare(req: CompareRequest):
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        return {
            "ok": False,
            "error": {
                "message": "OPENAI_API_KEY missing in Render environment.",
                "code": "missing_api_key",
            },
        }

    client = OpenAI(api_key=api_key)

    def request_compare(json_only: bool) -> dict:
        prompt = _build_compare_prompt(req, json_only=json_only)
        response = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": prompt}],
            temperature=0.3,
        )
        return _parse_json_once(response.choices[0].message.content)

    try:
        raw_data = request_compare(json_only=False)
    except Exception:
        try:
            raw_data = request_compare(json_only=True)
        except Exception:
            return {
                "ok": False,
                "error": {
                    "message": "Model response was not valid JSON.",
                    "code": "invalid_model_json",
                },
            }

    normalized = _normalize_compare_payload(raw_data if isinstance(raw_data, dict) else {})
    return {"ok": True, "data": normalized}
