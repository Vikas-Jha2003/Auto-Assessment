"""End-to-end: files in -> GradingReport out."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from typing import Callable, List, Optional, Tuple

from .config import Settings
from .grader import grade_question, overall_feedback
from .ingest import files_to_text
from .llm import LLMClient
from .schemas import AnswerSheet, Exam, GradingReport, QuestionResult
from .structure import (align_sheet, build_answer_sheet, build_exam, is_structured,
                        load_structured, normalise_exam)

Files = List[Tuple[str, bytes]]  # (filename, bytes)


@dataclass
class PreparedInputs:
    exam: Exam
    sheet: AnswerSheet
    warnings: List[str] = field(default_factory=list)
    sheet_text: str = ""


def prepare_exam(llm: LLMClient, question_paper: Files, rubric: Files = (), model_answers: Files = ()) -> Tuple[Exam, List[str]]:
    """A single structured file (exam.yaml / exam.json) may hold questions + rubric + model answers."""
    if len(question_paper) == 1 and is_structured(question_paper[0][0]):
        exam = Exam.model_validate(load_structured(*question_paper[0]))
    else:
        qp = files_to_text(llm, list(question_paper), "question paper")
        rb = files_to_text(llm, list(rubric), "rubric") if rubric else ""
        ma = files_to_text(llm, list(model_answers), "model answers") if model_answers else ""
        exam = build_exam(llm, qp, rb, ma)
    return normalise_exam(exam)


def prepare_sheet(llm: LLMClient, exam: Exam, answer_sheet: Files) -> Tuple[AnswerSheet, List[str], str]:
    if len(answer_sheet) == 1 and is_structured(answer_sheet[0][0]):
        sheet = AnswerSheet.model_validate(load_structured(*answer_sheet[0]))
        sheet, w = align_sheet(exam, sheet)
        return sheet, w, ""
    text = files_to_text(llm, list(answer_sheet), "answer sheet")
    sheet, w = build_answer_sheet(llm, exam, text)
    return sheet, w, text


def grade_sheet(llm: LLMClient, exam: Exam, sheet: AnswerSheet,
                progress: Optional[Callable[[str, float], None]] = None,
                with_overall: bool = True) -> GradingReport:
    s = llm.s
    results: dict = {}
    done = 0
    n = len(exam.questions)
    with ThreadPoolExecutor(max_workers=max(1, s.max_workers)) as pool:
        futs = {pool.submit(grade_question, llm, exam, q, sheet.get(q.id)): q for q in exam.questions}
        for fut in as_completed(futs):
            q = futs[fut]
            results[q.id] = fut.result()
            done += 1
            if progress:
                progress(f"Graded question {q.id} ({done}/{n})", 0.1 + 0.8 * done / n)
    ordered: List[QuestionResult] = [results[q.id] for q in exam.questions]
    overall = None
    if with_overall:
        if progress:
            progress("Writing overall feedback", 0.92)
        try:
            overall = overall_feedback(llm, exam, ordered)
        except Exception as e:  # noqa: BLE001 - overall summary is a nice-to-have
            overall = None
            print(f"[warn] overall feedback failed: {e}")
    total = round(sum(r.marks_awarded for r in ordered), 2)
    report = GradingReport(
        exam_title=exam.title, student_id=sheet.student_id, total_awarded=total,
        total_marks=exam.total_marks,
        percentage=round(100 * total / exam.total_marks, 1) if exam.total_marks else 0.0,
        questions=ordered, overall=overall,
        models={"grader": s.grader_model, "fast": s.fast_model, "vision": s.vision_model,
                "samples": s.samples, "mock": s.mock},
        usage=llm.usage.as_dict(),
    )
    if progress:
        progress("Done", 1.0)
    return report


def run(settings: Settings, question_paper: Files, answer_sheet: Files, rubric: Files = (),
        model_answers: Files = (), progress=None, llm: Optional[LLMClient] = None):
    """Convenience wrapper used by the CLI and the web app. Returns (report, prepared_inputs)."""
    llm = llm or LLMClient(settings)
    if progress:
        progress("Reading the question paper, rubric and model answers", 0.02)
    exam, w1 = prepare_exam(llm, question_paper, rubric, model_answers)
    if progress:
        progress("Reading and splitting the answer sheet", 0.08)
    sheet, w2, text = prepare_sheet(llm, exam, answer_sheet)
    prepared = PreparedInputs(exam=exam, sheet=sheet, warnings=w1 + w2, sheet_text=text)
    report = grade_sheet(llm, exam, sheet, progress=progress)
    report.usage = llm.usage.as_dict()
    return report, prepared
