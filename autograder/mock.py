"""Offline stand-in for the LLM so the whole pipeline can be tested without spending credits.

It uses crude keyword overlap, so its marks are NOT meaningful - it only exercises the plumbing
(parsing, aggregation, checks, audit, reports). Enable with --mock or AUTOGRADER_MOCK=1.
"""
from __future__ import annotations

import json
import re
from typing import Any

STOP = set("""a an the and or of to in on for with is are be by as that this it its from at which what how why
explain describe state give one two three marks mark answer student correct mentions shows uses""".split())


def _words(s: str) -> set:
    return {w for w in re.findall(r"[a-z0-9]+", s.lower()) if w not in STOP and len(w) > 2}


def _text(user: Any) -> str:
    if isinstance(user, str):
        return user
    return "\n".join(p.get("text", "") for p in user if isinstance(p, dict))


class MockBackend:
    def respond(self, task: str, system: str, user: Any) -> str:
        t = _text(user)
        base = task.split(":")[0]
        if base == "grade" or base == "audit":
            return json.dumps(self._grade(t))
        if base == "split_answers":
            return json.dumps(self._split(t))
        if base == "structure_exam":
            return json.dumps(self._structure(t))
        if base == "overall":
            return json.dumps({"summary": "Mock overall summary.",
                               "top_priorities": ["Mock priority 1", "Mock priority 2", "Mock priority 3"],
                               "study_plan": ["Mock study step 1", "Mock study step 2", "Mock study step 3"]})
        if base == "transcribe":
            return "[mock transcription]"
        return "{}"

    # -------------------------------------------------------------- grading
    def _grade(self, t: str) -> dict:
        crits = re.findall(r"- \[([^\]]+)\] \(([\d.]+) marks\) (.+)", t)
        m = re.search(r"<<<STUDENT_ANSWER\n(.*?)\nSTUDENT_ANSWER>>>", t, re.S)
        answer = m.group(1) if m else ""
        sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+|\n", answer) if len(s.strip()) > 3]
        aw = _words(answer)
        criteria, improvements = [], []
        for cid, marks, desc in crits:
            marks = float(marks)
            dw = _words(desc)
            ratio = len(dw & aw) / max(1, len(dw))
            if "NO ANSWER" in answer:
                ratio = 0
            frac = 1.0 if ratio >= 0.5 else (0.5 if ratio >= 0.25 else 0.0)
            awarded = round(marks * frac * 2) / 2
            best = max(sentences, key=lambda s: len(_words(s) & dw), default="")
            criteria.append({
                "criterion_id": cid, "marks_awarded": awarded, "marks_available": marks,
                "status": "met" if frac == 1 else ("partially_met" if frac else "not_met"),
                "evidence": [best] if awarded and best else [],
                "justification": f"Keyword overlap with the criterion was {ratio:.0%}.",
            })
            if awarded < marks:
                improvements.append({"criterion_id": cid, "issue": f"Your answer does not fully address: {desc}",
                                     "how_to_fix": f"Add an explicit explanation covering: {desc}",
                                     "example": "(mock example sentence)"})
        return {"criteria": criteria, "strengths": ["(mock) You attempted the question."],
                "improvements": improvements, "misconceptions": [], "summary": "(mock) Keyword-based grade."}

    def _split(self, t: str) -> dict:
        ids = re.findall(r'- id "([^"]+)"', t)
        sheet = t.split("ANSWER SHEET:\n<<<\n", 1)[-1].rsplit("\n>>>", 1)[0]
        name = re.search(r"(?:Name|Student|Roll)[^:]*:\s*(.+)", sheet)
        answers = []
        for qid in ids:
            pat = rf"(?im)^\s*(?:Q(?:uestion)?\.?\s*|Ans(?:wer)?\.?\s*)?{re.escape(qid)}\s*[).:-]?\s*(.*?)(?=^\s*(?:Q(?:uestion)?\.?\s*|Ans(?:wer)?\.?\s*)?(?:{'|'.join(map(re.escape, ids))})\s*[).:-]|\Z)"
            m = re.search(pat, sheet, re.S)
            answers.append({"question_id": qid, "answer": m.group(1).strip() if m else ""})
        return {"student_id": name.group(1).strip() if name else "student", "answers": answers}

    def _structure(self, t: str) -> dict:
        qs = re.findall(r"(?im)^Q(\w+)[.)]?\s*\((\d+(?:\.\d+)?) marks?\)\s*(.+)$", t)
        return {"title": "Mock-structured exam", "instructions": "",
                "questions": [{"id": qid, "text": text, "max_marks": float(mk),
                               "rubric": [{"id": f"{qid}.1", "description": text, "marks": float(mk)}],
                               "model_answer": ""} for qid, mk, text in qs]}
