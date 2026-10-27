"""Build the structured Exam and AnswerSheet from raw text (LLM) or from YAML/JSON files (no LLM)."""
from __future__ import annotations

import json
from pathlib import Path
from typing import List, Optional, Tuple

import yaml

from . import prompts
from .llm import LLMClient
from .schemas import AnswerSheet, Exam, Question, StudentAnswer
from .textmatch import quote_in_text

STRUCTURED_EXTS = {".json", ".yaml", ".yml"}


def is_structured(name: str) -> bool:
    return Path(name).suffix.lower() in STRUCTURED_EXTS


def load_structured(name: str, data: bytes) -> dict:
    text = data.decode("utf-8")
    return json.loads(text) if name.lower().endswith(".json") else yaml.safe_load(text)


# ------------------------------------------------------------------- exam
def normalise_exam(exam: Exam) -> Tuple[Exam, List[str]]:
    """Make rubric totals match max marks; return warnings for anything adjusted."""
    warnings = []
    for q in exam.questions:
        total = q.rubric_total()
        if not q.rubric:
            warnings.append(f"Q{q.id}: no rubric criteria; grading against the model answer only.")
            from .schemas import Criterion
            q.rubric = [Criterion(id=f"{q.id}.1", description="Answer matches the key points of the model answer",
                                  marks=q.max_marks)]
        elif abs(total - q.max_marks) > 1e-6:
            warnings.append(f"Q{q.id}: rubric criteria add up to {total} but the question is worth "
                            f"{q.max_marks}; criteria were rescaled proportionally.")
            factor = q.max_marks / total
            for c in q.rubric:
                c.marks = round(c.marks * factor, 2)
    return exam, warnings


def build_exam(llm: Optional[LLMClient], question_paper: str, rubric: str, model_answers: str) -> Exam:
    if llm is None:
        raise ValueError("Unstructured exam documents need the LLM to be structured.")
    user = (
        "QUESTION PAPER:\n" + question_paper.strip() +
        "\n\nRUBRIC / MARKING SCHEME:\n" + (rubric.strip() or "(none provided)") +
        "\n\nMODEL ANSWERS:\n" + (model_answers.strip() or "(none provided)")
    )
    data = llm.chat_json(llm.s.fast_model, prompts.STRUCTURE_SYSTEM, user, task="structure_exam", max_tokens=8000)
    return Exam.model_validate(data)


# ----------------------------------------------------------- answer sheet
def build_answer_sheet(llm: Optional[LLMClient], exam: Exam, sheet_text: str) -> Tuple[AnswerSheet, List[str]]:
    if llm is None:
        raise ValueError("Unstructured answer sheets need the LLM to be split into questions.")
    qlist = "\n".join(f"- id \"{q.id}\": {q.text[:200]}" for q in exam.questions)
    user = f"QUESTIONS:\n{qlist}\n\nANSWER SHEET:\n<<<\n{sheet_text}\n>>>"
    data = llm.chat_json(llm.s.fast_model, prompts.SPLIT_SYSTEM, user, task="split_answers", max_tokens=8000)
    sheet = AnswerSheet.model_validate(data)
    return align_sheet(exam, sheet, sheet_text)


def align_sheet(exam: Exam, sheet: AnswerSheet, source_text: Optional[str] = None) -> Tuple[AnswerSheet, List[str]]:
    """Ensure one answer per exam question and (if we have the source) that answers are verbatim."""
    warnings = []
    answers = []
    for q in exam.questions:
        ans = sheet.get(q.id)
        if source_text and ans:
            # check line-by-line so a long answer isn't rejected for one OCR glitch
            lines = [ln for ln in ans.splitlines() if len(ln.strip()) > 15]
            missing = [ln for ln in lines if not quote_in_text(ln, source_text, threshold=0.85)]
            if lines and len(missing) / len(lines) > 0.3:
                warnings.append(f"Q{q.id}: the extracted answer may not be verbatim from the sheet "
                                f"({len(missing)}/{len(lines)} lines not found). Check the transcription.")
        answers.append(StudentAnswer(question_id=q.id, answer=ans))
    known = {q.id.lower() for q in exam.questions}
    extra = [a.question_id for a in sheet.answers if a.question_id.lower() not in known and a.answer.strip()]
    if extra:
        warnings.append(f"Answers found for unknown question ids {extra}; they were not graded.")
    return AnswerSheet(student_id=sheet.student_id, answers=answers), warnings
