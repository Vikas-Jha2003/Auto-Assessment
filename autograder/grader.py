"""Per-question grading: rubric-by-criterion marks with verbatim evidence, self-consistency
across several samples, automatic checks, and an audit pass that repairs whatever fails."""
from __future__ import annotations

import json
import statistics
from typing import Callable, List, Optional, Tuple

from . import prompts
from .llm import LLMClient
from .schemas import (CriterionResult, Exam, Improvement, OverallFeedback, Question,
                      QuestionResult)
from .textmatch import quote_in_text


def _round_step(x: float, step: float) -> float:
    return round(round(x / step) * step, 2) if step > 0 else round(x, 2)


def _rubric_text(q: Question) -> str:
    return "\n".join(f"- [{c.id}] ({c.marks:g} marks) {c.description}" for c in q.rubric)


def grader_user_prompt(exam: Exam, q: Question, answer: str) -> str:
    instr = f"GENERAL MARKING INSTRUCTIONS:\n{exam.instructions}\n\n" if exam.instructions.strip() else ""
    return prompts.GRADER_USER.format(
        instructions=instr, qid=q.id, max_marks=f"{q.max_marks:g}", question=q.text,
        rubric=_rubric_text(q), model_answer=q.model_answer or "(not provided)",
        answer=answer.strip() if answer.strip() else "[NO ANSWER - question not attempted]",
    )


# ------------------------------------------------------------ sanitising
def coerce_sample(raw: dict, q: Question, step: float) -> dict:
    """Align a raw model reply to the rubric: one entry per criterion, clamped and rounded marks."""
    by_id = {}
    for c in raw.get("criteria", []) or []:
        if isinstance(c, dict) and c.get("criterion_id") is not None:
            by_id[str(c["criterion_id"]).strip().lower()] = c

    criteria: List[CriterionResult] = []
    missing = []
    for crit in q.rubric:
        c = by_id.get(crit.id.lower())
        if c is None:
            missing.append(crit.id)
            criteria.append(CriterionResult(criterion_id=crit.id, status="not_met", marks_awarded=0.0,
                                            marks_available=crit.marks, evidence=[],
                                            justification="Grader did not return a decision for this criterion."))
            continue
        try:
            m = float(c.get("marks_awarded", 0) or 0)
        except (TypeError, ValueError):
            m = 0.0
        m = min(max(_round_step(m, step), 0.0), crit.marks)
        status = "met" if m >= crit.marks - 1e-9 else ("not_met" if m <= 1e-9 else "partially_met")
        ev = c.get("evidence") or []
        if isinstance(ev, str):
            ev = [ev]
        criteria.append(CriterionResult(
            criterion_id=crit.id, status=status, marks_awarded=m, marks_available=crit.marks,
            evidence=[str(e).strip().strip('"') for e in ev if str(e).strip()],
            justification=str(c.get("justification", "")).strip(),
        ))

    improvements = []
    for imp in raw.get("improvements", []) or []:
        if isinstance(imp, dict):
            try:
                improvements.append(Improvement(
                    criterion_id=str(imp.get("criterion_id", "")),
                    issue=str(imp.get("issue", "")), how_to_fix=str(imp.get("how_to_fix", "")),
                    example=str(imp.get("example", "") or "")))
            except Exception:  # noqa: BLE001
                pass
    return {
        "criteria": criteria,
        "strengths": [str(s) for s in raw.get("strengths", []) or []],
        "improvements": improvements,
        "misconceptions": [str(s) for s in raw.get("misconceptions", []) or []],
        "summary": str(raw.get("summary", "") or ""),
        "missing": missing,
    }


def total(sample: dict) -> float:
    return round(sum(c.marks_awarded for c in sample["criteria"]), 2)


def aggregate(samples: List[dict], q: Question, step: float) -> dict:
    """Median marks per criterion; text taken from the sample that agrees with the median."""
    if len(samples) == 1:
        return samples[0]
    criteria = []
    for i, crit in enumerate(q.rubric):
        marks = [s["criteria"][i].marks_awarded for s in samples]
        med = _round_step(statistics.median(marks), step)
        best = min(samples, key=lambda s: abs(s["criteria"][i].marks_awarded - med))["criteria"][i]
        c = best.model_copy(deep=True)
        if abs(c.marks_awarded - med) > 1e-9:
            c.marks_awarded = med
            c.status = "met" if med >= crit.marks - 1e-9 else ("not_met" if med <= 1e-9 else "partially_met")
        criteria.append(c)
    agg_total = sum(c.marks_awarded for c in criteria)
    rep = min(samples, key=lambda s: abs(total(s) - agg_total))
    return {**rep, "criteria": criteria, "missing": sorted({m for s in samples for m in s["missing"]})}


# ------------------------------------------------------------- checking
def check(sample: dict, answer: str, q: Question) -> List[str]:
    """Automatic checks that make a grade defensible. Returns a list of problems."""
    problems = []
    if sample.get("missing"):
        problems.append(f"No decision returned for criteria {sample['missing']}.")
    for c in sample["criteria"]:
        verified = [e for e in c.evidence if quote_in_text(e, answer)]
        c.evidence_verified = bool(verified) if c.evidence else None
        if c.marks_awarded > 0 and not verified:
            problems.append(f"Criterion {c.criterion_id} awards {c.marks_awarded:g} marks but none of its evidence "
                            f"quotes appear verbatim in the student answer: {c.evidence}")
        elif c.evidence and len(verified) < len(c.evidence):
            bad = [e for e in c.evidence if e not in verified]
            problems.append(f"Criterion {c.criterion_id} has quotes not found in the answer: {bad}")
    covered = {i.criterion_id.lower() for i in sample["improvements"]}
    for c in sample["criteria"]:
        if c.marks_awarded < c.marks_available - 1e-9 and c.criterion_id.lower() not in covered:
            problems.append(f"Criterion {c.criterion_id} lost marks but has no improvement item "
                            f"(issue / how_to_fix / example).")
    for imp in sample["improvements"]:
        if len(imp.how_to_fix.split()) < 5:
            problems.append(f"Improvement for {imp.criterion_id} is too vague: '{imp.how_to_fix}'.")
    return problems


def _to_payload(sample: dict) -> dict:
    return {
        "criteria": [c.model_dump(exclude={"evidence_verified"}) for c in sample["criteria"]],
        "strengths": sample["strengths"],
        "improvements": [i.model_dump() for i in sample["improvements"]],
        "misconceptions": sample["misconceptions"],
        "summary": sample["summary"],
    }


# -------------------------------------------------------------- grading
def grade_question(llm: LLMClient, exam: Exam, q: Question, answer: str) -> QuestionResult:
    s = llm.s
    step = s.mark_step
    user = grader_user_prompt(exam, q, answer)
    system = prompts.GRADER_SYSTEM.format(step=f"{step:g}")
    attempted = bool(answer.strip())
    n = s.samples if attempted else 1
    temp = s.temperature if n > 1 else 0.0

    samples = []
    for k in range(n):
        raw = llm.chat_json(s.grader_model, system, user, task="grade", temperature=temp)
        samples.append(coerce_sample(raw, q, step))
    totals = [total(x) for x in samples]
    result = aggregate(samples, q, step)
    spread = (max(totals) - min(totals)) if totals else 0.0
    disagreement = spread > s.disagreement_threshold * q.max_marks

    problems = check(result, answer, q)
    if disagreement:
        problems.append(f"Independent grading samples disagreed: totals {totals} out of {q.max_marks:g}. "
                        f"Re-examine borderline criteria carefully and settle on the defensible mark.")
    flags: List[str] = []
    if problems:
        audit_user = (
            user + "\n\nDRAFT GRADING:\n" + json.dumps(_to_payload(result), indent=1) +
            "\n\nPROBLEMS FOUND BY THE CHECKER:\n- " + "\n- ".join(problems)
        )
        audit_system = prompts.AUDIT_SYSTEM.format(rules=system)
        try:
            raw = llm.chat_json(s.grader_model, audit_system, audit_user, task="audit", temperature=0.0)
            audited = coerce_sample(raw, q, step)
            remaining = check(audited, answer, q)
            # keep the audited version unless it made things worse
            if len(remaining) <= len([p for p in problems if not p.startswith("Independent")]):
                result, problems = audited, remaining
            flags.append("audited")
        except Exception as e:  # noqa: BLE001
            flags.append(f"audit failed: {e}")
        flags += [f"check: {p}" for p in problems]

    awarded = round(sum(c.marks_awarded for c in result["criteria"]), 2)
    if disagreement and any(p for p in problems):
        confidence = "low"
    elif disagreement or problems:
        confidence = "medium"
    else:
        confidence = "high"
    return QuestionResult(
        question_id=q.id, marks_awarded=awarded, max_marks=q.max_marks, criteria=result["criteria"],
        strengths=result["strengths"], improvements=result["improvements"],
        misconceptions=result["misconceptions"], summary=result["summary"],
        confidence=confidence, sample_totals=totals, flags=flags,
    )


def overall_feedback(llm: LLMClient, exam: Exam, results: List[QuestionResult]) -> Optional[OverallFeedback]:
    lines = []
    for r in results:
        q = next(q for q in exam.questions if q.id == r.question_id)
        lines.append(f"Q{r.question_id} ({r.marks_awarded:g}/{r.max_marks:g}) - {q.text[:150]}\n"
                     f"  summary: {r.summary}\n"
                     f"  gaps: {[i.issue for i in r.improvements]}\n"
                     f"  misconceptions: {r.misconceptions}")
    total_aw = sum(r.marks_awarded for r in results)
    user = (f"EXAM: {exam.title}\nTOTAL: {total_aw:g}/{exam.total_marks:g}\n\n" + "\n\n".join(lines))
    data = llm.chat_json(llm.s.grader_model, prompts.OVERALL_SYSTEM, user, task="overall")
    return OverallFeedback.model_validate(data)


ProgressFn = Callable[[str, float], None]
