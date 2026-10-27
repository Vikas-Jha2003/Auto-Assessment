"""Render a GradingReport as Markdown (for students / LMS) or a standalone HTML page."""
from __future__ import annotations

import html
from typing import Optional

from .schemas import Exam, GradingReport

STATUS_ICON = {"met": "✅", "partially_met": "🟡", "not_met": "❌"}
STATUS_LABEL = {"met": "Met", "partially_met": "Partly met", "not_met": "Not met"}


def _crit_desc(exam: Optional[Exam], qid: str, cid: str) -> str:
    if not exam:
        return ""
    for q in exam.questions:
        if q.id == qid:
            for c in q.rubric:
                if c.id == cid:
                    return c.description
    return ""


def to_markdown(r: GradingReport, exam: Optional[Exam] = None, include_debug: bool = False) -> str:
    out = [f"# {r.exam_title} — Feedback for {r.student_id}",
           f"**Total: {r.total_awarded:g} / {r.total_marks:g} ({r.percentage:g}%)**", ""]
    out.append("| Question | Marks | Confidence |\n|---|---|---|")
    for q in r.questions:
        out.append(f"| Q{q.question_id} | {q.marks_awarded:g} / {q.max_marks:g} | {q.confidence} |")
    out.append("")
    if r.overall:
        out += ["## Overall", r.overall.summary, ""]
        if r.overall.top_priorities:
            out.append("**Top priorities**")
            out += [f"{i}. {p}" for i, p in enumerate(r.overall.top_priorities, 1)]
            out.append("")
        if r.overall.study_plan:
            out.append("**Study plan**")
            out += [f"- {p}" for p in r.overall.study_plan]
            out.append("")

    for q in r.questions:
        out += [f"## Question {q.question_id} — {q.marks_awarded:g} / {q.max_marks:g}", "", q.summary, ""]
        out.append("| Criterion | Result | Marks | Why |\n|---|---|---|---|")
        for c in q.criteria:
            desc = _crit_desc(exam, q.question_id, c.criterion_id) or c.criterion_id
            why = c.justification.replace("|", "/").replace("\n", " ")
            out.append(f"| {desc.replace('|', '/')} | {STATUS_ICON[c.status]} {STATUS_LABEL[c.status]} | "
                       f"{c.marks_awarded:g}/{c.marks_available:g} | {why} |")
        out.append("")
        ev = [(c.criterion_id, e) for c in q.criteria for e in c.evidence if c.marks_awarded > 0]
        if ev:
            out.append("**What earned marks (from your answer)**")
            out += [f"- “{e}”" for _, e in ev]
            out.append("")
        if q.strengths:
            out.append("**What you did well**")
            out += [f"- {s}" for s in q.strengths]
            out.append("")
        if q.improvements:
            out.append("**How to improve**")
            for i in q.improvements:
                line = f"- **{i.issue}** {i.how_to_fix}"
                if i.example:
                    line += f"\n  - *Example:* {i.example}"
                out.append(line)
            out.append("")
        if q.misconceptions:
            out.append("**Misconceptions to fix**")
            out += [f"- {m}" for m in q.misconceptions]
            out.append("")
        if include_debug and (q.flags or len(q.sample_totals) > 1):
            out.append(f"<sub>Sample totals: {q.sample_totals}. Flags: {'; '.join(q.flags) or 'none'}</sub>")
            out.append("")
    if include_debug:
        out.append(f"<sub>Models: {r.models}. Usage: {r.usage}</sub>")
    return "\n".join(out)


def to_html(r: GradingReport, exam: Optional[Exam] = None) -> str:
    e = html.escape
    pct = r.percentage
    rows = []
    for q in r.questions:
        crit_rows = "".join(
            f"<tr><td>{e(_crit_desc(exam, q.question_id, c.criterion_id) or c.criterion_id)}</td>"
            f"<td class='st {c.status}'>{STATUS_LABEL[c.status]}</td>"
            f"<td class='num'>{c.marks_awarded:g}/{c.marks_available:g}</td>"
            f"<td>{e(c.justification)}"
            + ("".join(f"<blockquote>{e(x)}</blockquote>" for x in c.evidence) if c.evidence else "")
            + "</td></tr>"
            for c in q.criteria)
        strengths = "".join(f"<li>{e(s)}</li>" for s in q.strengths)
        imps = "".join(
            f"<li><b>{e(i.issue)}</b> {e(i.how_to_fix)}"
            + (f"<div class='ex'>Example: {e(i.example)}</div>" if i.example else "") + "</li>"
            for i in q.improvements)
        mis = "".join(f"<li>{e(m)}</li>" for m in q.misconceptions)
        qtext = ""
        if exam:
            qq = next((x for x in exam.questions if x.id == q.question_id), None)
            qtext = f"<p class='qtext'>{e(qq.text)}</p>" if qq else ""
        rows.append(f"""
<section class="q">
  <div class="qhead"><h2>Question {e(q.question_id)}</h2>
    <span class="score">{q.marks_awarded:g} / {q.max_marks:g}</span>
    <span class="conf {q.confidence}">{q.confidence} confidence</span></div>
  {qtext}
  <p class="summary">{e(q.summary)}</p>
  <table><thead><tr><th>Criterion</th><th>Result</th><th>Marks</th><th>Why (with evidence from your answer)</th></tr></thead>
  <tbody>{crit_rows}</tbody></table>
  {"<h3>What you did well</h3><ul>" + strengths + "</ul>" if strengths else ""}
  {"<h3>How to improve</h3><ul class='imp'>" + imps + "</ul>" if imps else ""}
  {"<h3>Misconceptions to fix</h3><ul>" + mis + "</ul>" if mis else ""}
</section>""")
    overall = ""
    if r.overall:
        pri = "".join(f"<li>{e(p)}</li>" for p in r.overall.top_priorities)
        plan = "".join(f"<li>{e(p)}</li>" for p in r.overall.study_plan)
        overall = (f"<section class='overall'><h2>Overall</h2><p>{e(r.overall.summary)}</p>"
                   f"<h3>Top priorities</h3><ol>{pri}</ol><h3>Study plan</h3><ul>{plan}</ul></section>")
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Feedback – {e(r.student_id)}</title>
<style>
:root{{--bg:#f7f7fb;--card:#fff;--ink:#1d1b36;--mut:#5d5b77;--acc:#5b54d6;--line:#e4e3f0;
--met:#e6f6ec;--metc:#17713b;--part:#fff5dd;--partc:#8a5a00;--not:#fde8e8;--notc:#a12828}}
@media (prefers-color-scheme:dark){{:root{{--bg:#14131f;--card:#1d1c2b;--ink:#ecebf7;--mut:#a7a5c2;--acc:#9b95ff;
--line:#2f2d44;--met:#173323;--metc:#7fdc9f;--part:#3a2f12;--partc:#f2c66a;--not:#3c1a1a;--notc:#ff9b9b}}}}
body{{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 system-ui,-apple-system,Segoe UI,sans-serif}}
main{{max-width:980px;margin:0 auto;padding:24px 16px 64px}}
header{{display:flex;flex-wrap:wrap;align-items:baseline;gap:12px 24px;margin-bottom:16px}}
h1{{font-size:24px;margin:0}} h2{{font-size:19px;margin:0}} h3{{font-size:15px;margin:18px 0 6px}}
.total{{font-size:22px;font-weight:700;color:var(--acc)}}
.bar{{height:8px;background:var(--line);border-radius:4px;overflow:hidden;margin:4px 0 20px}}
.bar>div{{height:100%;background:var(--acc)}}
section{{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px;margin:14px 0}}
.qhead{{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center}}
.score{{font-weight:700;font-size:17px}} .qtext{{color:var(--mut);white-space:pre-wrap}}
.conf{{font-size:12px;padding:2px 8px;border-radius:99px;border:1px solid var(--line);color:var(--mut)}}
.conf.low{{color:var(--notc)}} .summary{{font-weight:500}}
.tw{{overflow-x:auto}} table{{width:100%;border-collapse:collapse;font-size:14px;display:block;overflow-x:auto}}
th,td{{text-align:left;vertical-align:top;padding:8px;border-bottom:1px solid var(--line)}}
th{{color:var(--mut);font-weight:600}} .num{{white-space:nowrap}}
.st{{white-space:nowrap;font-weight:600}} .st.met{{background:var(--met);color:var(--metc)}}
.st.partially_met{{background:var(--part);color:var(--partc)}} .st.not_met{{background:var(--not);color:var(--notc)}}
blockquote{{margin:6px 0 0;padding:4px 10px;border-left:3px solid var(--acc);color:var(--mut);font-style:italic}}
.imp li{{margin-bottom:8px}} .ex{{color:var(--mut);margin-top:2px}}
footer{{color:var(--mut);font-size:12px;margin-top:24px}}
</style></head><body><main>
<header><h1>{e(r.exam_title)}</h1><span>Student: <b>{e(r.student_id)}</b></span>
<span class="total">{r.total_awarded:g} / {r.total_marks:g} ({pct:g}%)</span></header>
<div class="bar"><div style="width:{min(max(pct, 0), 100)}%"></div></div>
{overall}
{''.join(rows)}
<footer>Graded automatically against the rubric. Grader model: {e(str(r.models.get('grader', '')))},
{r.models.get('samples', 1)} independent grading samples per question.</footer>
</main></body></html>"""
