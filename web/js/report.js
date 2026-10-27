// Student feedback reports: an HTML fragment used inside the app, a standalone HTML file, and Markdown.
import { effectiveMarks } from "./grader.js";

const csvEscape = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const toCSV = (rows) => rows.map((r) => r.map(csvEscape).join(",")).join("\n") + "\n";

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const fmt = (n) => String(+(+n).toFixed(2));
export const STATUS = { met: "Met", partially_met: "Partly met", not_met: "Not met" };

const critDesc = (exam, qid, cid) => exam?.questions.find((q) => q.id === qid)?.rubric.find((c) => c.id === cid)?.description || cid;

export function scoreMark(aw, max, cls = "") {
  return `<span class="score ${cls}" aria-label="${fmt(aw)} out of ${fmt(max)}"><span class="s-aw">${fmt(aw)}</span><span class="s-sep">/</span><span class="s-max">${fmt(max)}</span></span>`;
}

export function questionBlock(r, exam, { answer, controls = "" } = {}) {
  const q = exam?.questions.find((x) => x.id === r.question_id);
  const eff = effectiveMarks(r);
  const crit = r.criteria.map((c) => `
    <tr>
      <td>${esc(critDesc(exam, r.question_id, c.criterion_id))}</td>
      <td><span class="pill ${c.status}">${STATUS[c.status]}</span></td>
      <td class="num">${fmt(c.marks_awarded)}/${fmt(c.marks_available)}</td>
      <td>${esc(c.justification)}${c.evidence.map((e) => `<blockquote class="${c.evidence_verified === false ? "unverified" : ""}">${esc(e)}</blockquote>`).join("")}</td>
    </tr>`).join("");
  const list = (title, items, cls = "") => (items?.length ? `<h4>${title}</h4><ul class="${cls}">${items.join("")}</ul>` : "");
  const imps = r.improvements.map((i) => `<li><strong>${esc(i.issue)}</strong> ${esc(i.how_to_fix)}${i.example ? `<div class="example">For example: ${esc(i.example)}</div>` : ""}</li>`);
  return `
  <article class="qblock" id="q-${esc(r.question_id)}">
    <header class="qhead">
      <h3>Question ${esc(r.question_id)}</h3>
      ${scoreMark(eff, r.max_marks)}
      ${r.confidence !== "high" ? `<span class="conf ${r.confidence}" title="The independent grading passes disagreed or an automatic check failed">Check this</span>` : ""}
      ${r.override ? `<span class="conf adjusted">Adjusted by teacher (AI gave ${fmt(r.marks_awarded)})</span>` : ""}
    </header>
    ${q ? `<p class="qtext">${esc(q.text)}</p>` : ""}
    ${answer !== undefined ? `<details class="answer"><summary>Student's answer</summary><pre>${esc(answer || "(not attempted)")}</pre></details>` : ""}
    ${r.override?.note ? `<p class="override-note">Teacher's note: ${esc(r.override.note)}</p>` : ""}
    <p class="summary">${esc(r.summary)}</p>
    <div class="table-wrap"><table class="crit">
      <thead><tr><th>Criterion</th><th>Result</th><th>Marks</th><th>Why, with evidence from the answer</th></tr></thead>
      <tbody>${crit}</tbody></table></div>
    ${list("What you did well", r.strengths.map((s) => `<li>${esc(s)}</li>`))}
    ${list("How to improve", imps, "improve")}
    ${list("Misconceptions to fix", r.misconceptions.map((s) => `<li>${esc(s)}</li>`))}
    ${controls}
  </article>`;
}

export function overallBlock(o) {
  if (!o) return "";
  return `<section class="overall">
    <h3>Overall</h3><p>${esc(o.summary)}</p>
    <div class="two">
      <div><h4>Top priorities</h4><ol>${o.top_priorities.map((p) => `<li>${esc(p)}</li>`).join("")}</ol></div>
      <div><h4>Study plan</h4><ul>${o.study_plan.map((p) => `<li>${esc(p)}</li>`).join("")}</ul></div>
    </div></section>`;
}

const REPORT_CSS = `
:root{--bg:#f4f6f9;--surface:#fff;--subtle:#f8f9fb;--ink:#0f1a2e;--text:#283244;--muted:#5d6779;--line:#e1e5eb;
--brand:#1e2a78;--brand-soft:#eef0fa;--brand-text:#2d3a91;--ok:#157347;--ok-soft:#e7f4ec;--warn:#8a5a00;--warn-soft:#fcf3dc;--bad:#b42318;--bad-soft:#fdecea}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.6 "IBM Plex Sans",system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:900px;margin:0 auto;padding:32px 16px 64px}
h1,h3,h4{color:var(--ink);margin:0}h1{font-size:24px;margin-bottom:2px}h3{font-size:16.5px}h4{font-size:14px;margin:18px 0 6px}
.meta{color:var(--muted);margin:0 0 18px}
.total{font-size:34px;font-weight:600;color:var(--ink);letter-spacing:-.02em}.total .of{font-size:18px;color:var(--muted);font-weight:500}
.score{display:inline-flex;gap:2px;font-weight:600;font-size:13.5px;color:var(--brand-text);background:var(--brand-soft);border-radius:99px;padding:2px 11px}
.score .s-max,.score .s-sep{color:var(--muted);font-weight:500}
.qblock,.overall{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:20px 22px;margin:16px 0}
.qhead{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px}
.qtext{color:var(--muted);white-space:pre-wrap}.summary{font-weight:500;color:var(--ink)}
.conf{font-size:12.5px;border-radius:99px;padding:2px 10px;color:var(--warn);background:var(--warn-soft)}
.table-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:8px}table{border-collapse:collapse;width:100%;font-size:14px}
th,td{text-align:left;vertical-align:top;padding:9px 12px;border-bottom:1px solid var(--line)}th{color:var(--muted);font-weight:600;background:var(--subtle);font-size:12.5px}
tr:last-child td{border-bottom:0}.num{white-space:nowrap}
.pill{white-space:nowrap;font-size:12.5px;font-weight:600;border-radius:6px;padding:2px 8px}
.pill.met{background:var(--ok-soft);color:var(--ok)}.pill.partially_met{background:var(--warn-soft);color:var(--warn)}.pill.not_met{background:var(--bad-soft);color:var(--bad)}
blockquote{margin:6px 0 0;padding:2px 10px;border-left:3px solid var(--brand);color:var(--muted);font-style:italic}
blockquote.unverified{border-left-color:var(--warn)}
.improve li{margin-bottom:8px}.example{color:var(--muted)}
.two{display:grid;grid-template-columns:1fr 1fr;gap:0 24px}@media(max-width:640px){.two{grid-template-columns:1fr}}
details.answer summary{cursor:pointer;color:var(--brand-text);font-weight:500}
details.answer pre{white-space:pre-wrap;background:var(--subtle);border:1px solid var(--line);padding:10px;border-radius:8px;font:13px/1.5 ui-monospace,monospace}
footer{color:var(--muted);font-size:12px;margin-top:24px}
@media print{body{background:#fff}.qblock,.overall{break-inside:avoid}}`;

export function standaloneHTML(report, exam, answers) {
  const qs = report.questions.map((r) => questionBlock(r, exam, { answer: answers ? answers[r.question_id] : undefined })).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Feedback – ${esc(report.student_id)}</title>
<style>${REPORT_CSS}</style></head><body><main>
<h1>${esc(report.exam_title)}</h1>
<p class="meta">${esc(report.student_id)}</p>
<div class="total">${fmt(report.total_awarded)}<span class="of"> / ${fmt(report.total_marks)} · ${fmt(report.percentage)}%</span></div>
${overallBlock(report.overall)}${qs}
<footer>Graded against the rubric by ${esc(report.models?.grader || "an AI grader")}, ${report.models?.samples || 1} independent grading passes per question. Quotes are taken from the student's own answer.</footer>
</main></body></html>`;
}

export function markdown(report, exam) {
  const L = [`# ${report.exam_title} — ${report.student_id}`, ``, `**Total: ${fmt(report.total_awarded)} / ${fmt(report.total_marks)} (${fmt(report.percentage)}%)**`, ``,
    `| Question | Marks | Confidence |`, `|---|---|---|`,
    ...report.questions.map((q) => `| Q${q.question_id} | ${fmt(effectiveMarks(q))} / ${fmt(q.max_marks)}${q.override ? " (adjusted)" : ""} | ${q.confidence} |`), ``];
  if (report.overall) {
    L.push(`## Overall`, report.overall.summary, ``, `**Top priorities**`, ...report.overall.top_priorities.map((p, i) => `${i + 1}. ${p}`), ``,
      `**Study plan**`, ...report.overall.study_plan.map((p) => `- ${p}`), ``);
  }
  for (const q of report.questions) {
    L.push(`## Question ${q.question_id} — ${fmt(effectiveMarks(q))} / ${fmt(q.max_marks)}`, ``, q.summary, ``);
    if (q.override?.note) L.push(`*Teacher's note:* ${q.override.note}`, ``);
    L.push(`| Criterion | Result | Marks | Why |`, `|---|---|---|---|`);
    for (const c of q.criteria) L.push(`| ${critDesc(exam, q.question_id, c.criterion_id).replace(/\|/g, "/")} | ${STATUS[c.status]} | ${fmt(c.marks_awarded)}/${fmt(c.marks_available)} | ${c.justification.replace(/\|/g, "/").replace(/\n/g, " ")}${c.evidence.length ? " — “" + c.evidence.join("”, “") + "”" : ""} |`);
    L.push(``);
    if (q.strengths.length) L.push(`**What you did well**`, ...q.strengths.map((s) => `- ${s}`), ``);
    if (q.improvements.length) L.push(`**How to improve**`, ...q.improvements.map((i) => `- **${i.issue}** ${i.how_to_fix}${i.example ? `\n  - *Example:* ${i.example}` : ""}`), ``);
    if (q.misconceptions.length) L.push(`**Misconceptions to fix**`, ...q.misconceptions.map((s) => `- ${s}`), ``);
  }
  return L.join("\n");
}

export function classCSV(run) {
  const qs = run.exam.questions;
  const rows = [["student", "source", ...qs.map((q) => `Q${q.id} (/${fmt(q.max_marks)})`), "total", "max", "percent", "flags"]];
  for (const s of run.students) {
    if (!s.report) { rows.push([s.label, s.sourceLabel || "", ...qs.map(() => ""), "", "", "", s.status === "error" ? `error: ${s.error}` : s.status]); continue; }
    const r = s.report;
    const flags = r.questions.filter((q) => q.confidence !== "high").map((q) => `Q${q.question_id} ${q.confidence}`)
      .concat(r.questions.filter((q) => q.override).map((q) => `Q${q.question_id} adjusted`));
    rows.push([r.student_id, s.sourceLabel || s.label, ...r.questions.map((q) => fmt(effectiveMarks(q))), fmt(r.total_awarded), fmt(r.total_marks), fmt(r.percentage), flags.join("; ")]);
  }
  return toCSV(rows);
}
