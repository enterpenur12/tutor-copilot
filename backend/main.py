import hashlib
import json
import os
import time
from collections import defaultdict, deque
from pathlib import Path
from threading import RLock
from typing import Literal

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from openai import OpenAI
from pydantic import BaseModel, Field, ValidationError, validator
from starlette.middleware.base import BaseHTTPMiddleware

MAX_TEXT_CHARS = 12000
MAX_COMBINED_COMPARE_CHARS = 28000
MAX_REQUEST_BYTES = 40000
RATE_LIMIT_WINDOW_SECONDS = 60
RATE_LIMIT_REQUESTS_PER_WINDOW = 8
DAILY_LIMIT_WINDOW_SECONDS = 86400
DAILY_LIMIT_REQUESTS = 120
REQUEST_TIMEOUT_SECONDS = 45
ANALYTICS_ID_MAX_LENGTH = 128
ANALYTICS_STORAGE_PATH = Path(
    os.environ.get(
        "ANALYTICS_STORAGE_PATH",
        str(Path(__file__).with_name("analytics_store.json")),
    )
)
TRUSTED_ORIGINS = [
    "https://tutor-copilot.vercel.app",
    "http://localhost:3000",
]

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

app.add_middleware(
    CORSMiddleware,
    allow_origins=TRUSTED_ORIGINS,
    allow_credentials=False,
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["Content-Type"],
)


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "same-origin"
        response.headers["Cache-Control"] = "no-store"
        return response


app.add_middleware(SecurityHeadersMiddleware)


class InputModel(BaseModel):
    class Config:
        extra = "forbid"
        anystr_strip_whitespace = True

    @validator("*", pre=True)
    def ensure_text(cls, value):
        if value is None:
            raise ValueError("Field is required.")
        if not isinstance(value, str):
            raise ValueError("Field must be a string.")
        return value

    @validator("*")
    def reject_empty_text(cls, value: str):
        if not value.strip():
            raise ValueError("Field must not be empty.")
        return value


class RunRequest(InputModel):
    rubric: str = Field(..., min_length=1, max_length=MAX_TEXT_CHARS)
    student_work: str = Field(..., min_length=1, max_length=MAX_TEXT_CHARS)


class CompareRequest(InputModel):
    rubric: str = Field(..., min_length=1, max_length=MAX_TEXT_CHARS)
    draft_before: str = Field(..., min_length=1, max_length=MAX_TEXT_CHARS)
    draft_after: str = Field(..., min_length=1, max_length=MAX_TEXT_CHARS)
    tone: Literal["strict", "balanced", "friendly"]

    @validator("draft_after")
    def combined_size_guard(cls, value: str, values):
        rubric = values.get("rubric", "")
        draft_before = values.get("draft_before", "")
        if len(rubric) + len(draft_before) + len(value) > MAX_COMBINED_COMPARE_CHARS:
            raise ValueError("Combined input is too large.")
        return value


class BrowserRegistrationRequest(BaseModel):
    browser_id: str = Field(..., min_length=1, max_length=ANALYTICS_ID_MAX_LENGTH)

    class Config:
        extra = "forbid"

    @validator("browser_id")
    def validate_browser_id(cls, value: str):
        normalized = value.strip()
        if not normalized:
            raise ValueError("Browser ID is required.")
        return normalized


class AnalyticsRunRequest(BaseModel):
    run_id: str = Field(..., min_length=1, max_length=ANALYTICS_ID_MAX_LENGTH)

    class Config:
        extra = "forbid"

    @validator("run_id")
    def validate_run_id(cls, value: str):
        normalized = value.strip()
        if not normalized:
            raise ValueError("Run ID is required.")
        return normalized


class HelpfulnessRequest(BaseModel):
    helpful: bool
    run_id: str = Field(..., min_length=1, max_length=ANALYTICS_ID_MAX_LENGTH)

    class Config:
        extra = "forbid"

    @validator("run_id")
    def validate_run_id(cls, value: str):
        normalized = value.strip()
        if not normalized:
            raise ValueError("Run ID is required.")
        return normalized


class InMemoryRateLimiter:
    def __init__(self) -> None:
        self._buckets: dict[str, deque[float]] = defaultdict(deque)

    def check(self, key: str, limit: int, window_seconds: int) -> None:
        now = time.time()
        bucket = self._buckets[key]
        while bucket and bucket[0] <= now - window_seconds:
            bucket.popleft()
        if len(bucket) >= limit:
            raise HTTPException(
                status_code=429,
                detail="Too many requests. Please wait before trying again.",
            )
        bucket.append(now)


short_window_limiter = InMemoryRateLimiter()
daily_limiter = InMemoryRateLimiter()


class AnalyticsStore:
    def __init__(self, path: Path) -> None:
        self._path = path
        self._lock = RLock()
        self._state = self._load()

    def _default_state(self) -> dict:
        return {
            "_browserIds": set(),
            "_successfulRunIds": set(),
            "_helpfulnessByRun": {},
        }

    def _normalize_id_collection(self, value: object) -> set[str]:
        if not isinstance(value, list):
            return set()
        normalized: set[str] = set()
        for item in value:
            if not isinstance(item, str):
                continue
            cleaned = item.strip()
            if cleaned:
                normalized.add(cleaned[:ANALYTICS_ID_MAX_LENGTH])
        return normalized

    def _normalize_state(self, raw: object) -> dict:
        state = self._default_state()
        if not isinstance(raw, dict):
            return state

        state["_browserIds"] = self._normalize_id_collection(
            raw.get("_browserIds", raw.get("browserIds"))
        )
        state["_successfulRunIds"] = self._normalize_id_collection(
            raw.get("_successfulRunIds", raw.get("successfulRunIds"))
        )
        helpfulness_by_run = raw.get("_helpfulnessByRun", raw.get("helpfulnessByRun"))
        if isinstance(helpfulness_by_run, dict):
            for run_id, helpful in helpfulness_by_run.items():
                if not isinstance(run_id, str) or not isinstance(helpful, bool):
                    continue
                cleaned = run_id.strip()
                if cleaned:
                    normalized_id = cleaned[:ANALYTICS_ID_MAX_LENGTH]
                    state["_helpfulnessByRun"][normalized_id] = helpful
        return state

    def _serialize(self, state: dict) -> dict:
        return {
            "browserIds": sorted(state["_browserIds"]),
            "successfulRunIds": sorted(state["_successfulRunIds"]),
            "helpfulnessByRun": dict(sorted(state["_helpfulnessByRun"].items())),
        }

    def _build_snapshot_unlocked(self) -> dict:
        helpful_yes = sum(
            1 for helpful in self._state["_helpfulnessByRun"].values() if helpful
        )
        helpful_no = sum(
            1 for helpful in self._state["_helpfulnessByRun"].values() if not helpful
        )
        total_feedback = helpful_yes + helpful_no
        helpfulness_percent = (
            round((helpful_yes / total_feedback) * 100) if total_feedback else 0
        )

        return {
            "totalUsers": len(self._state["_browserIds"]),
            "essaysAnalyzed": len(self._state["_successfulRunIds"]),
            "helpfulYes": helpful_yes,
            "helpfulNo": helpful_no,
            "helpfulnessPercent": helpfulness_percent,
        }

    def _write_unlocked(self, state: dict) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        temp_path = self._path.with_suffix(".tmp")
        with temp_path.open("w", encoding="utf-8") as handle:
            json.dump(self._serialize(state), handle, indent=2, sort_keys=True)
        temp_path.replace(self._path)

    def _load(self) -> dict:
        if not self._path.exists():
            state = self._default_state()
            self._write_unlocked(state)
            return state

        try:
            with self._path.open("r", encoding="utf-8") as handle:
                raw = json.load(handle)
        except (OSError, json.JSONDecodeError):
            raw = {}

        state = self._normalize_state(raw)
        self._write_unlocked(state)
        return state

    def snapshot(self) -> dict:
        with self._lock:
            return self._build_snapshot_unlocked()

    def register_browser(self, browser_id: str) -> dict:
        with self._lock:
            self._state["_browserIds"].add(browser_id)
            self._write_unlocked(self._state)
            return self.snapshot()

    def register_successful_run(self, run_id: str) -> dict:
        with self._lock:
            self._state["_successfulRunIds"].add(run_id)
            self._write_unlocked(self._state)
            return self.snapshot()

    def register_helpfulness(self, run_id: str, helpful: bool) -> dict:
        with self._lock:
            if run_id not in self._state["_successfulRunIds"]:
                raise HTTPException(status_code=404, detail="Run not found.")
            if run_id in self._state["_helpfulnessByRun"]:
                return self.snapshot()
            self._state["_helpfulnessByRun"][run_id] = helpful
            self._write_unlocked(self._state)
            return self.snapshot()


analytics_store = AnalyticsStore(ANALYTICS_STORAGE_PATH)


def _get_client_token(request: Request) -> str:
    forwarded_for = request.headers.get("x-forwarded-for", "")
    if forwarded_for:
        client_value = forwarded_for.split(",")[0].strip()
    elif request.client and request.client.host:
        client_value = request.client.host
    else:
        client_value = "unknown"
    return hashlib.sha256(client_value.encode("utf-8")).hexdigest()


def _enforce_origin(request: Request) -> None:
    origin = request.headers.get("origin")
    if origin and origin not in TRUSTED_ORIGINS:
        raise HTTPException(status_code=403, detail="Origin not allowed.")


def _get_openai_client() -> OpenAI:
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=503, detail="Service temporarily unavailable.")
    return OpenAI(api_key=api_key, timeout=REQUEST_TIMEOUT_SECONDS)


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


def _build_run_prompt(req: RunRequest) -> str:
    return f"""
IMPORTANT CALIBRATION RULE (READ CAREFULLY):

In many real classrooms, a score of 100 does NOT require perfection.
A score of 100 is appropriate when:
- The student clearly met the purpose of the assignment
- The writing is strong, clear, and complete
- Any rubric gaps are minor and not meaningful
- There is no clear reason a teacher would deduct points

If the work feels fully successful and you would not reasonably mark it down,
you SHOULD assign a score between 95 and 100.

Do NOT cap strong essays in the high 80s simply because small rubric elements are missing.
Think like a real teacher deciding whether there is a justification to take points off.
You are an AI writing feedback assistant acting as a thoughtful, experienced high school teacher.

Your role is to evaluate student writing using the rubric as a GUIDE, not a checklist.
Real teachers use professional judgment and you must do the same.

CORE PRINCIPLES (VERY IMPORTANT):
- Use the rubric to guide evaluation, but apply human-like judgment.
- Do NOT penalize students harshly for minor omissions if overall quality is strong.
- Consider clarity, insight, effort, and coherence in addition to rubric alignment.
- Assume this is a draft unless explicitly stated otherwise.
- Be fair, reasonable, and encouraging while remaining honest.

WHAT YOU MUST NOT DO:
- Do NOT rewrite the student's work.
- Do NOT provide model answers or sentences to copy.
- Do NOT invent rubric criteria.
- Do NOT mention AI, OpenAI, or ChatGPT.

SCORING PHILOSOPHY (THIS MATTERS MOST):
- Score MUST be between 65 and 100.
- NEVER assign a score below 65.
- Use these grade bands with PROFESSIONAL LENIENCY:

  - 90-100 (A):
    Student meets most rubric expectations and shows strong understanding.
    Minor rubric gaps should NOT prevent an A if the writing is thoughtful, clear, and effective.

  - 80-89 (B):
    Student generally meets rubric expectations but has noticeable gaps,
    underdeveloped sections, or inconsistent execution.

  - 65-79 (C):
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
""".strip()


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


def _call_chat_completion(client: OpenAI, prompt: str) -> str:
    response = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": prompt}],
        temperature=0.3,
    )
    message = response.choices[0].message.content
    if not message:
        raise HTTPException(status_code=502, detail="Upstream service failed.")
    return message


@app.exception_handler(HTTPException)
async def http_exception_handler(_: Request, exc: HTTPException):
    return JSONResponse(status_code=exc.status_code, content={"error": exc.detail})


@app.exception_handler(RequestValidationError)
@app.exception_handler(ValidationError)
async def validation_exception_handler(_: Request, __):
    return JSONResponse(status_code=422, content={"error": "Invalid request payload."})


@app.exception_handler(Exception)
async def generic_exception_handler(_: Request, __: Exception):
    return JSONResponse(
        status_code=500,
        content={"error": "Something went wrong. Please try again shortly."},
    )


@app.middleware("http")
async def protect_request(request: Request, call_next):
    if request.method == "OPTIONS":
        return await call_next(request)

    _enforce_origin(request)

    if request.url.path in {
        "/run",
        "/compare",
        "/analytics/register-user",
        "/analytics/run-success",
        "/analytics/helpfulness",
    }:
        content_length = request.headers.get("content-length")
        if content_length and int(content_length) > MAX_REQUEST_BYTES:
            raise HTTPException(status_code=413, detail="Request payload is too large.")
        client_token = _get_client_token(request)
        short_window_limiter.check(
            key=f"minute:{client_token}",
            limit=RATE_LIMIT_REQUESTS_PER_WINDOW,
            window_seconds=RATE_LIMIT_WINDOW_SECONDS,
        )
        daily_limiter.check(
            key=f"day:{client_token}",
            limit=DAILY_LIMIT_REQUESTS,
            window_seconds=DAILY_LIMIT_WINDOW_SECONDS,
        )

    return await call_next(request)


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/analytics")
def get_analytics():
    return analytics_store.snapshot()


@app.post("/analytics/register-user")
def register_user(req: BrowserRegistrationRequest):
    return analytics_store.register_browser(req.browser_id)


@app.post("/analytics/run-success")
def register_run_success(req: AnalyticsRunRequest):
    return analytics_store.register_successful_run(req.run_id)


@app.post("/analytics/helpfulness")
def register_helpfulness(req: HelpfulnessRequest):
    return analytics_store.register_helpfulness(req.run_id, req.helpful)


@app.post("/run")
def run(req: RunRequest):
    client = _get_openai_client()
    prompt = _build_run_prompt(req)

    try:
        content = _call_chat_completion(client, prompt)
        return {"feedback": content}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail="Unable to generate feedback right now.",
        ) from exc


@app.post("/compare")
def compare(req: CompareRequest):
    client = _get_openai_client()

    def request_compare(json_only: bool) -> dict:
        prompt = _build_compare_prompt(req, json_only=json_only)
        return _parse_json_once(_call_chat_completion(client, prompt))

    try:
        raw_data = request_compare(json_only=False)
    except Exception:
        try:
            raw_data = request_compare(json_only=True)
        except Exception as exc:
            raise HTTPException(
                status_code=502,
                detail="Unable to generate comparison right now.",
            ) from exc

    normalized = _normalize_compare_payload(raw_data if isinstance(raw_data, dict) else {})
    return {"ok": True, "data": normalized}
