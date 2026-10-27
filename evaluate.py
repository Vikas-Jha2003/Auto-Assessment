#!/usr/bin/env python3
"""Evaluate the grader against human (teacher) marks — numbers for your project report.

Metrics
  Marks agreement   : MAE per question, MAE on totals, exact / within-0.5 / within-1 agreement,
                      Pearson r, Quadratic Weighted Kappa (QWK, marks in 0.5 steps)
  Consistency       : with --repeats N, each sheet is graded N times; reports mean per-question std-dev
  Defensibility     : % of awarded criteria with verified verbatim evidence,
                      % of lost-mark criteria that got an improvement item
  Feedback quality  : optional LLM-judge (--judge) scores 1-5 for specificity, actionability,
                      rubric alignment and accuracy — the project's "Bar"

Usage
  python evaluate.py --exam samples/exam.yaml --answers-dir samples/answer_sheets \
                     --human samples/human_marks.json --repeats 2 --judge
  python evaluate.py ... --mock        # dry run, no API calls
"""
from __future__ import annotations

import argparse
import json
import math
import statistics
from pathlib import Path

from autograder import LLMClient, Settings
from autograder.pipeline import grade_sheet, prepare_exam, prepare_sheet
from autograder.schemas import Exam, QuestionResult

JUDGE_SYSTEM = """You evaluate the quality of feedback that an automatic grader gave a student on one exam answer.
Score each dimension from 1 (poor) to 5 (excellent):
- specificity: refers to the student's actual answer, not generic advice
- actionability: the student could follow it to write a better answer next time
- rubric_alignment: marks and feedback are clearly tied to the rubric criteria
- accuracy: the marks and claims about the answer are correct and fair
Return JSON: {"specificity": int, "actionability": int, "rubric_alignment": int, "accuracy": int, "comment": str}"""


# ------------------------------------------------------------------ metrics
def pearson(x, y):
    if len(x) < 2:
        return float("nan")
    mx, my = statistics.mean(x), statistics.mean(y)
    sx = math.sqrt(sum((a - mx) ** 2 for a in x))
    sy = math.sqrt(sum((b - my) ** 2 for b in y))
    return float("nan") if sx == 0 or sy == 0 else sum((a - mx) * (b - my) for a, b in zip(x, y)) / (sx * sy)


def qwk(a, b, step=0.5):
    """Quadratic weighted kappa on marks discretised to `step`."""
    a = [round(v / step) for v in a]
    b = [round(v / step) for v in b]
    lo, hi = min(a + b), max(a + b)
    n = hi - lo + 1
    if n == 1:
        return 1.0
    O = [[0] * n for _ in range(n)]
    for x, y in zip(a, b):
        O[x - lo][y - lo] += 1
    ha = [sum(r) for r in O]
    hb = [sum(O[i][j] for i in range(n)) for j in range(n)]
    N = len(a)
    num = den = 0.0
    for i in range(n):
        for j in range(n):
            w = (i - j) ** 2 / (n - 1) ** 2
            num += w * O[i][j]
            den += w * ha[i] * hb[j] / N
    return 1.0 if den == 0 else 1 - num / den


def judge(llm: LLMClient, exam: Exam, r: QuestionResult, answer: str, model: str) -> dict:
    q = next(x for x in exam.questions if x.id == r.question_id)
    user = (f"QUESTION ({q.max_marks:g} marks): {q.text}\nRUBRIC: "
            + "; ".join(f"[{c.id}] {c.description} ({c.marks:g})" for c in q.rubric)
            + f"\nMODEL ANSWER: {q.model_answer}\nSTUDENT ANSWER: {answer or '(blank)'}\n\nGRADER OUTPUT:\n"
            + r.model_dump_json(include={"marks_awarded", "criteria", "strengths", "improvements",
                                         "misconceptions", "summary"}, indent=1))
    return llm.chat_json(model, JUDGE_SYSTEM, user, task="judge")


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--exam", required=True)
    ap.add_argument("--answers-dir", required=True)
    ap.add_argument("--human", required=True, help="JSON: {sheet_file_stem: {question_id: marks}}")
    ap.add_argument("--repeats", type=int, default=1, help="Grade each sheet N times to measure consistency")
    ap.add_argument("--judge", action="store_true", help="Score feedback quality with an LLM judge")
    ap.add_argument("--judge-model", help="Model for the judge (default: GRADER_MODEL)")
    ap.add_argument("--samples", type=int)
    ap.add_argument("--grader-model")
    ap.add_argument("--budget", type=float)
    ap.add_argument("--mock", action="store_true")
    ap.add_argument("--out", default="results/eval")
    a = ap.parse_args(argv)

    s = Settings()
    s.mock = s.mock or a.mock
    if a.samples:
        s.samples = a.samples
    if a.grader_model:
        s.grader_model = a.grader_model
    if a.budget is not None:
        s.budget_usd = a.budget
    llm = LLMClient(s)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)

    human = {k: v for k, v in json.loads(Path(a.human).read_text()).items() if not k.startswith("_")}
    p = Path(a.exam)
    exam, _ = prepare_exam(llm, [(p.name, p.read_bytes())])

    rows, per_q_std, judge_scores = [], [], []
    ev_awarded = ev_verified = lost = lost_covered = 0
    for stem, marks in human.items():
        files = sorted(Path(a.answers_dir).glob(stem + ".*"))
        if not files:
            print(f"[skip] no answer sheet for {stem}")
            continue
        f = files[0]
        sheet, _, _ = prepare_sheet(llm, exam, [(f.name, f.read_bytes())])
        runs = []
        for k in range(a.repeats):
            print(f"Grading {stem} (run {k + 1}/{a.repeats}) ...")
            runs.append(grade_sheet(llm, exam, sheet, with_overall=False))
        rep = runs[0]
        (out / f"{stem}.json").write_text(rep.model_dump_json(indent=2))
        for i, q in enumerate(exam.questions):
            preds = [r.questions[i].marks_awarded for r in runs]
            if len(preds) > 1:
                per_q_std.append(statistics.pstdev(preds))
            h = float(marks.get(q.id, marks.get(str(q.id), 0)))
            rows.append({"sheet": stem, "q": q.id, "max": q.max_marks, "human": h,
                         "auto": statistics.mean(preds), "runs": preds})
            qr = rep.questions[i]
            for c in qr.criteria:
                if c.marks_awarded > 0:
                    ev_awarded += 1
                    ev_verified += bool(c.evidence_verified)
                if c.marks_awarded < c.marks_available:
                    lost += 1
                    lost_covered += any(im.criterion_id.lower() == c.criterion_id.lower() for im in qr.improvements)
            if a.judge and not s.mock:
                try:
                    j = judge(llm, exam, qr, sheet.get(q.id), a.judge_model or s.grader_model)
                    judge_scores.append({"sheet": stem, "q": q.id, **j})
                except Exception as e:  # noqa: BLE001
                    print(f"[warn] judge failed for {stem} Q{q.id}: {e}")

    hum = [r["human"] for r in rows]
    aut = [r["auto"] for r in rows]
    err = [abs(x - y) for x, y in zip(hum, aut)]
    tot_h, tot_a = {}, {}
    for r in rows:
        tot_h[r["sheet"]] = tot_h.get(r["sheet"], 0) + r["human"]
        tot_a[r["sheet"]] = tot_a.get(r["sheet"], 0) + r["auto"]
    norm_err = [abs(r["human"] - r["auto"]) / r["max"] for r in rows]

    metrics = {
        "n_question_answers": len(rows),
        "mae_marks": round(statistics.mean(err), 3) if err else None,
        "mae_pct_of_question": round(100 * statistics.mean(norm_err), 1) if norm_err else None,
        "exact_agreement": round(sum(e < 1e-9 for e in err) / len(err), 3) if err else None,
        "within_0.5": round(sum(e <= 0.5 + 1e-9 for e in err) / len(err), 3) if err else None,
        "within_1": round(sum(e <= 1 + 1e-9 for e in err) / len(err), 3) if err else None,
        "pearson_r": round(pearson(hum, aut), 3),
        "qwk": round(qwk(hum, aut), 3),
        "total_mae": round(statistics.mean(abs(tot_h[k] - tot_a[k]) for k in tot_h), 2) if tot_h else None,
        "consistency_mean_std": round(statistics.mean(per_q_std), 3) if per_q_std else None,
        "evidence_verified_rate": round(ev_verified / ev_awarded, 3) if ev_awarded else None,
        "lost_marks_with_feedback_rate": round(lost_covered / lost, 3) if lost else None,
        "cost_usd": llm.usage.as_dict()["cost_usd"],
    }
    if judge_scores:
        for dim in ("specificity", "actionability", "rubric_alignment", "accuracy"):
            vals = [j[dim] for j in judge_scores if isinstance(j.get(dim), (int, float))]
            metrics[f"judge_{dim}"] = round(statistics.mean(vals), 2) if vals else None

    (out / "eval_results.json").write_text(json.dumps({"metrics": metrics, "rows": rows,
                                                       "judge": judge_scores}, indent=2))
    md = ["# Evaluation results", "", f"Grader: `{s.grader_model}`, samples/question: {s.samples}, "
          f"repeats: {a.repeats}{' (MOCK)' if s.mock else ''}", "", "| Metric | Value |", "|---|---|"]
    md += [f"| {k} | {v} |" for k, v in metrics.items()]
    md += ["", "| Sheet | Q | Max | Human | Auto | Runs |", "|---|---|---|---|---|---|"]
    md += [f"| {r['sheet']} | {r['q']} | {r['max']:g} | {r['human']:g} | {r['auto']:.2f} | {r['runs']} |" for r in rows]
    md += ["", "| Sheet | Human total | Auto total |", "|---|---|---|"]
    md += [f"| {k} | {tot_h[k]:g} | {tot_a[k]:.2f} |" for k in tot_h]
    (out / "eval_report.md").write_text("\n".join(md))
    print("\n".join(md[:len(metrics) + 6]))
    print(f"\nSaved {out / 'eval_report.md'} and {out / 'eval_results.json'}")


if __name__ == "__main__":
    main()
