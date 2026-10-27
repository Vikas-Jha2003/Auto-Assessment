"""Generate 'raw' versions of the sample exam (TXT + PDF), the way a teacher would actually hand them over:
a question paper, a separate marking scheme, and a separate model-answer document.

    python scripts/make_raw_samples.py
"""
import textwrap
from pathlib import Path

import pymupdf as fitz
import yaml

ROOT = Path(__file__).resolve().parents[1]
S = ROOT / "samples"
exam = yaml.safe_load((S / "exam.yaml").read_text())
out = S / "raw"
out.mkdir(exist_ok=True)

qp = [exam["title"], "Time: 90 minutes        Maximum marks: "
      f"{sum(q['max_marks'] for q in exam['questions']):g}", "Answer ALL questions.", ""]
for q in exam["questions"]:
    qp.append(f"Q{q['id']}. ({q['max_marks']:g} marks) {q['text']}")
    qp.append("")

rb = [f"MARKING SCHEME — {exam['title']}", "", "General: " + exam["instructions"].strip(), ""]
for q in exam["questions"]:
    rb.append(f"Question {q['id']} [{q['max_marks']:g} marks]")
    for c in q["rubric"]:
        rb.append(f"  * {c['description']}  — {c['marks']:g} mark{'s' if c['marks'] != 1 else ''}")
    rb.append("")

ma = [f"MODEL ANSWERS — {exam['title']}", ""]
for q in exam["questions"]:
    ma.append(f"Answer {q['id']}:")
    ma.append(q["model_answer"].strip())
    ma.append("")


docs = {"question_paper": "\n".join(qp), "rubric": "\n".join(rb), "model_answers": "\n".join(ma)}


def write_pdf(text: str, path: Path, width_chars: int = 95, lines_per_page: int = 60):
    # the built-in Helvetica font only covers Latin-1, so swap a few symbols
    for a, b in {"—": "-", "≈": "~", "×": "x", "·": ".", "’": "'"}.items():
        text = text.replace(a, b)
    lines = []
    for para in text.splitlines():
        lines += textwrap.wrap(para, width_chars, subsequent_indent="    " if para.startswith("  ") else "") or [""]
    pdf = fitz.open()
    for i in range(0, len(lines), lines_per_page):
        page = pdf.new_page(width=595, height=842)  # A4
        y = 50
        for ln in lines[i:i + lines_per_page]:
            page.insert_text((45, y), ln, fontsize=9.5, fontname="helv")
            y += 12.3
    pdf.save(path)


for name, text in docs.items():
    (out / f"{name}.txt").write_text(text)
    write_pdf(text, out / f"{name}.pdf")
    print("wrote", out / f"{name}.txt", "and .pdf")
