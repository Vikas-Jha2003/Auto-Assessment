#!/usr/bin/env python3
"""Command-line grader.

Examples
  # one student, structured exam file
  python grade.py --exam samples/exam.yaml --answers samples/answer_sheets/student_A.txt

  # raw documents (PDF / DOCX / TXT / images) for everything
  python grade.py --questions qp.pdf --rubric rubric.pdf --model-answers model.pdf \
                  --answers sheet_page1.jpg sheet_page2.jpg

  # a whole class: every file in a folder is one student's sheet
  python grade.py --exam samples/exam.yaml --answers-dir samples/answer_sheets --out results/

  # test the plumbing without an API key or credits
  python grade.py --exam samples/exam.yaml --answers samples/answer_sheets/student_A.txt --mock
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

from autograder import LLMClient, Settings
from autograder.pipeline import grade_sheet, prepare_exam, prepare_sheet
from autograder.report import to_html, to_markdown

SHEET_EXTS = {".txt", ".md", ".pdf", ".docx", ".png", ".jpg", ".jpeg", ".webp", ".json", ".yaml", ".yml"}


def read_files(paths):
    return [(Path(p).name, Path(p).read_bytes()) for p in paths or []]


def safe(name: str) -> str:
    return re.sub(r"[^\w.-]+", "_", name).strip("_") or "student"


def main(argv=None):
    ap = argparse.ArgumentParser(description="Grade answer sheets against a rubric with detailed feedback.")
    src = ap.add_argument_group("exam (give --exam OR --questions [+ --rubric + --model-answers])")
    src.add_argument("--exam", help="Structured exam file (.yaml/.json) with questions, rubric and model answers")
    src.add_argument("--questions", nargs="+", help="Question paper file(s)")
    src.add_argument("--rubric", nargs="+", help="Rubric / marking scheme file(s)")
    src.add_argument("--model-answers", nargs="+", help="Model answer file(s)")
    sh = ap.add_argument_group("answer sheets")
    sh.add_argument("--answers", nargs="+", help="One student's answer sheet (several files = pages in order)")
    sh.add_argument("--answers-dir", help="Folder where each file is a different student's sheet")
    ap.add_argument("--out", default="results", help="Output folder (default: results/)")
    ap.add_argument("--mock", action="store_true", help="Use the offline mock LLM (no API calls)")
    ap.add_argument("--samples", type=int, help="Grading samples per question (self-consistency)")
    ap.add_argument("--grader-model", help="Override GRADER_MODEL")
    ap.add_argument("--fast-model", help="Override FAST_MODEL")
    ap.add_argument("--budget", type=float, help="Stop when spend (USD) reaches this amount")
    ap.add_argument("--list-models", action="store_true", help="List OpenRouter models with prices and exit")
    a = ap.parse_args(argv)

    s = Settings()
    if a.mock:
        s.mock = True
    if a.samples:
        s.samples = a.samples
    if a.grader_model:
        s.grader_model = a.grader_model
    if a.fast_model:
        s.fast_model = a.fast_model
    if a.budget is not None:
        s.budget_usd = a.budget
    llm = LLMClient(s)

    if a.list_models:
        for m in sorted(llm.list_models(), key=lambda m: m["id"]):
            p = m.get("pricing") or {}
            mods = ",".join((m.get("architecture") or {}).get("input_modalities") or [])
            try:
                pin = float(p.get("prompt", 0)) * 1e6
                pout = float(p.get("completion", 0)) * 1e6
                print(f"{m['id']:<55} ${pin:>7.2f} in / ${pout:>7.2f} out per 1M tokens  [{mods}]")
            except (TypeError, ValueError):
                print(m["id"])
        return 0

    if not (a.exam or a.questions):
        ap.error("give --exam or --questions")
    if not (a.answers or a.answers_dir):
        ap.error("give --answers or --answers-dir")

    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)

    print(f"Models: grader={s.grader_model}  fast={s.fast_model}  vision={s.vision_model}"
          f"  samples={s.samples}{'  [MOCK]' if s.mock else ''}")
    exam, warnings = prepare_exam(llm, read_files([a.exam] if a.exam else a.questions),
                                  read_files(a.rubric), read_files(a.model_answers))
    (out / "exam_structured.json").write_text(exam.model_dump_json(indent=2))
    print(f"Exam: {exam.title} — {len(exam.questions)} questions, {exam.total_marks:g} marks "
          f"(structured copy saved to {out / 'exam_structured.json'})")
    for w in warnings:
        print(f"  ! {w}")

    if a.answers_dir:
        sheets = [[p] for p in sorted(Path(a.answers_dir).iterdir())
                  if p.suffix.lower() in SHEET_EXTS and not p.name.startswith(".")]
    else:
        sheets = [a.answers]

    summary = []
    for files in sheets:
        name = Path(files[0]).stem
        print(f"\n== {name} ==")
        sheet, w, _ = prepare_sheet(llm, exam, read_files(files))
        for x in w:
            print(f"  ! {x}")
        if sheet.student_id in ("", "student"):
            sheet.student_id = name
        report = grade_sheet(llm, exam, sheet, progress=lambda msg, f: print(f"  {msg}"))
        report.usage = llm.usage.as_dict()
        base = out / safe(name)
        base.with_suffix(".json").write_text(report.model_dump_json(indent=2))
        base.with_suffix(".md").write_text(to_markdown(report, exam, include_debug=True))
        base.with_suffix(".html").write_text(to_html(report, exam))
        for q in report.questions:
            flag = "" if q.confidence == "high" else f"  [{q.confidence} confidence]"
            print(f"  Q{q.question_id}: {q.marks_awarded:g}/{q.max_marks:g}  samples={q.sample_totals}{flag}")
        print(f"  TOTAL {report.total_awarded:g}/{report.total_marks:g} ({report.percentage:g}%)"
              f"  -> {base}.html")
        summary.append({"file": name, "student_id": report.student_id, "total": report.total_awarded,
                        "max": report.total_marks,
                        **{f"Q{q.question_id}": q.marks_awarded for q in report.questions}})

    (out / "summary.json").write_text(json.dumps(summary, indent=2))
    u = llm.usage.as_dict()
    print(f"\nAPI calls: {u['calls']}  tokens: {u['prompt_tokens']}+{u['completion_tokens']}  "
          f"cost: ${u['cost_usd']:.4f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
