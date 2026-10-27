"""Offline tests (no API key needed):  python -m pytest -q"""
import json
from pathlib import Path

from autograder import LLMClient, Settings
from autograder.grader import check, coerce_sample, grade_question
from autograder.pipeline import prepare_exam, prepare_sheet
from autograder.textmatch import quote_in_text
from evaluate import qwk

ROOT = Path(__file__).resolve().parents[1]


def exam():
    p = ROOT / "samples" / "exam.yaml"
    llm = LLMClient(Settings(mock=True))
    e, warnings = prepare_exam(llm, [(p.name, p.read_bytes())])
    assert not warnings
    return llm, e


def test_rubrics_sum_to_max():
    _, e = exam()
    assert e.total_marks == 30
    for q in e.questions:
        assert q.rubric_total() == q.max_marks


def test_quote_matching_tolerates_small_noise():
    text = "Overfitting means the model memorises the training data, including the noise in it."
    assert quote_in_text("the model memorises the training data", text)
    assert quote_in_text("the model memorizes the training data", text)  # spelling variant
    assert not quote_in_text("dropout randomly switches off neurons", text)


def test_coerce_clamps_and_fills_missing():
    _, e = exam()
    q = e.questions[0]  # criteria 2 + 1 + 1
    raw = {"criteria": [{"criterion_id": "1.1", "marks_awarded": 7, "evidence": ["x"], "justification": "j"}]}
    s = coerce_sample(raw, q, 0.5)
    assert s["criteria"][0].marks_awarded == 2 and s["criteria"][0].status == "met"
    assert s["missing"] == ["1.2", "1.3"]


def test_checker_catches_invented_evidence():
    _, e = exam()
    q = e.questions[0]
    raw = {"criteria": [{"criterion_id": "1.1", "marks_awarded": 2, "evidence": ["a quote the student never wrote"],
                         "justification": "j"},
                        {"criterion_id": "1.2", "marks_awarded": 0, "evidence": [], "justification": "j"},
                        {"criterion_id": "1.3", "marks_awarded": 0, "evidence": [], "justification": "j"}],
           "improvements": []}
    problems = check(coerce_sample(raw, q, 0.5), "Overfitting is bad.", q)
    assert any("none of its evidence" in p for p in problems)
    assert sum("no improvement item" in p for p in problems) == 2


def test_audit_runs_when_checks_fail():
    llm, e = exam()
    calls = []
    orig = llm._mock.respond

    def fake(task, system, user):
        calls.append(task)
        if task == "grade":  # first pass invents a quote -> must trigger the audit
            return json.dumps({"criteria": [{"criterion_id": c.id, "marks_awarded": c.marks,
                                             "evidence": ["invented quote xyz"], "justification": "j"}
                                            for c in e.questions[0].rubric], "improvements": []})
        return orig(task, system, user)

    llm._mock.respond = fake
    r = grade_question(llm, e, e.questions[0], "Overfitting is when the model memorises training noise.")
    assert "audit" in calls and "audited" in r.flags


def test_answer_sheet_split_out_of_order():
    llm, e = exam()
    p = ROOT / "samples" / "answer_sheets" / "student_C.txt"
    sheet, _, _ = prepare_sheet(llm, e, [(p.name, p.read_bytes())])
    assert "precision" in sheet.get("3")
    assert "Overfitting" in sheet.get("1")


def test_qwk():
    assert qwk([0, 1, 2, 3], [0, 1, 2, 3]) == 1.0
    assert qwk([0, 1, 2, 3], [3, 2, 1, 0]) < 0
