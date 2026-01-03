import os
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
You are a strict but helpful teacher.

Rubric:
{req.rubric}

Student submission:
{req.student_work}

Return ONLY valid JSON with keys:
- score (0-100 number)
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
