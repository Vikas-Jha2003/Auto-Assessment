"""Data models for the whole pipeline (validated with pydantic)."""
from __future__ import annotations

from typing import List, Literal, Optional

from pydantic import BaseModel, Field


# ---------------------------------------------------------------- exam inputs
class Criterion(BaseModel):
    id: str = Field(description="Short id, e.g. 'Q1.a' or 'C1'")
    description: str = Field(description="What the student must show to earn these marks")
    marks: float = Field(gt=0)


class Question(BaseModel):
    id: str = Field(description="Question number as printed, e.g. '1', '2b'")
    text: str
    max_marks: float = Field(gt=0)
    rubric: List[Criterion]
    model_answer: str = ""

    def rubric_total(self) -> float:
        return round(sum(c.marks for c in self.rubric), 2)


class Exam(BaseModel):
    title: str = "Exam"
    instructions: str = ""
    questions: List[Question]

    @property
    def total_marks(self) -> float:
        return round(sum(q.max_marks for q in self.questions), 2)


class StudentAnswer(BaseModel):
    question_id: str
    answer: str = ""  # verbatim text of the student's answer ("" = not attempted)


class AnswerSheet(BaseModel):
    student_id: str = "student"
    answers: List[StudentAnswer]

    def get(self, qid: str) -> str:
        for a in self.answers:
            if a.question_id.strip().lower() == qid.strip().lower():
                return a.answer
        return ""


# ------------------------------------------------------------- grading output
class CriterionResult(BaseModel):
    criterion_id: str
    status: Literal["met", "partially_met", "not_met"]
    marks_awarded: float
    marks_available: float
    evidence: List[str] = Field(default_factory=list,
                                description="Verbatim quotes from the student's answer")
    justification: str = Field(description="Why these marks, referring to the rubric wording")
    evidence_verified: Optional[bool] = None  # filled in by code, not the LLM


class Improvement(BaseModel):
    criterion_id: str
    issue: str = Field(description="What exactly is missing or wrong")
    how_to_fix: str = Field(description="Concrete, actionable step the student can take")
    example: str = Field("", description="A short example sentence / step showing the fix")


class QuestionResult(BaseModel):
    question_id: str
    marks_awarded: float
    max_marks: float
    criteria: List[CriterionResult]
    strengths: List[str] = Field(default_factory=list)
    improvements: List[Improvement] = Field(default_factory=list)
    misconceptions: List[str] = Field(default_factory=list)
    summary: str = ""
    # reliability info, filled in by code
    confidence: Literal["high", "medium", "low"] = "high"
    sample_totals: List[float] = Field(default_factory=list)
    flags: List[str] = Field(default_factory=list)


class OverallFeedback(BaseModel):
    summary: str
    top_priorities: List[str] = Field(default_factory=list)
    study_plan: List[str] = Field(default_factory=list)


class GradingReport(BaseModel):
    exam_title: str
    student_id: str
    total_awarded: float
    total_marks: float
    percentage: float
    questions: List[QuestionResult]
    overall: Optional[OverallFeedback] = None
    models: dict = Field(default_factory=dict)
    usage: dict = Field(default_factory=dict)
