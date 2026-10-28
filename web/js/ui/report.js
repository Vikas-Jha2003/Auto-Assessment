/**
 * @file Student feedback reports: the HTML shown in the app, a standalone HTML file for
 * download, and the class marksheet as CSV.
 */
import { esc, fmt } from "./dom.js";

/**
 * Headings and labels of the student report, in English, Hindi and Tamil. Students read the
 * report, so its labels follow the language of the feedback where a translation is available.
 */
const LABELS = {
  en: { lang: "en", question: "Question", met: "Met", partially_met: "Partly met", not_met: "Not met", criterion: "Criterion",
        result: "Result", marks: "Marks", why: "Why, with evidence from the answer", strengths: "What you did well",
        improve: "How to improve", misconceptions: "Misconceptions to fix", example: "For example:", overall: "Overall",
        priorities: "Top priorities", plan: "Study plan", answer: "Student's answer", notAttempted: "(not attempted)", check: "Check this" },
  hi: { lang: "hi", question: "प्रश्न", met: "पूर्ण", partially_met: "आंशिक", not_met: "अपूर्ण", criterion: "मानदंड",
        result: "परिणाम", marks: "अंक", why: "कारण, आपके उत्तर से प्रमाण सहित", strengths: "आपने क्या अच्छा किया",
        improve: "सुधार कैसे करें", misconceptions: "सुधारने योग्य गलत धारणाएँ", example: "उदाहरण:", overall: "समग्र",
        priorities: "मुख्य प्राथमिकताएँ", plan: "अध्ययन योजना", answer: "छात्र का उत्तर", notAttempted: "(प्रयास नहीं किया)", check: "जाँचें" },
  ta: { lang: "ta", question: "கேள்வி", met: "முழுமை", partially_met: "பகுதி", not_met: "இல்லை", criterion: "அளவுகோல்",
        result: "முடிவு", marks: "மதிப்பெண்", why: "காரணம், உங்கள் விடையிலிருந்து சான்றுடன்", strengths: "நீங்கள் நன்றாகச் செய்தவை",
        improve: "எப்படி மேம்படுத்துவது", misconceptions: "திருத்த வேண்டிய தவறான கருத்துகள்", example: "எடுத்துக்காட்டு:", overall: "ஒட்டுமொத்தம்",
        priorities: "முதன்மை முன்னுரிமைகள்", plan: "படிப்புத் திட்டம்", answer: "மாணவரின் விடை", notAttempted: "(முயற்சிக்கவில்லை)", check: "சரிபார்க்கவும்" },
};

/**
 * Labels for a report: from the chosen feedback language, or, when it was "auto", from the
 * script the feedback is written in.
 * @param {import("../core/grader.js").StudentReport} report
 */
export function reportLabels(report) {
  const chosen = report.models?.language;
  if (chosen === "Hindi") return LABELS.hi;
  if (chosen === "Tamil") return LABELS.ta;
  if (chosen && chosen !== "auto") return LABELS.en;
  const sample = [report.overall?.summary, ...report.questions.map((q) => q.summary)].join(" ");
  const count = (re) => (sample.match(re) || []).length;
  const devanagari = count(/[\u0900-\u097f]/g), tamil = count(/[\u0b80-\u0bff]/g), latin = count(/[a-z]/gi);
  if (devanagari > latin && devanagari >= tamil) return LABELS.hi;
  if (tamil > latin) return LABELS.ta;
  return LABELS.en;
}

/** Description of a rubric criterion, by id. */
const criterionText = (exam, qid, cid) =>
  exam?.questions.find((q) => q.id === qid)?.rubric.find((c) => c.id === cid)?.description || cid;

/**
 * Feedback for one question: criterion table with evidence, strengths, improvements, misconceptions.
 * @param {import("../core/grader.js").QuestionResult} r
 * @param {import("../core/exam.js").Exam} exam
 * @param {{ answer?: string, labels?: typeof LABELS.en }} [options] `answer`: include the student's
 *   answer in a collapsible block. `labels`: headings in the report's language (see `reportLabels`).
 * @returns {string} HTML
 */
export function questionBlock(r, exam, { answer, labels: L = LABELS.en } = {}) {
  const question = exam?.questions.find((q) => q.id === r.question_id);
  const rows = r.criteria.map((c) => `
    <tr>
      <td>${esc(criterionText(exam, r.question_id, c.criterion_id))}</td>
      <td><span class="pill ${c.status}">${L[c.status]}</span></td>
      <td class="num">${fmt(c.marks_awarded)}/${fmt(c.marks_available)}</td>
      <td>${esc(c.justification)}${c.evidence.map((e) => `<blockquote class="${c.evidence_verified === false ? "unverified" : ""}">${esc(e)}</blockquote>`).join("")}</td>
    </tr>`).join("");
  const list = (title, items, cls = "") => (items.length ? `<h4>${title}</h4><ul class="${cls}">${items.join("")}</ul>` : "");
  const improvements = r.improvements.map((i) =>
    `<li><strong>${esc(i.issue)}</strong> ${esc(i.how_to_fix)}${i.example ? `<div class="example">${L.example} ${esc(i.example)}</div>` : ""}</li>`);
  return `
  <article class="qblock" id="q-${esc(r.question_id)}">
    <header class="qhead">
      <h3>${L.question} ${esc(r.question_id)}</h3>
      <span class="score">${fmt(r.marks_awarded)}<span class="s-sep"> / </span><span class="s-max">${fmt(r.max_marks)}</span></span>
      ${r.confidence !== "high" ? `<span class="conf ${r.confidence}" title="The independent grading passes disagreed or an automatic check failed">${L.check}</span>` : ""}
    </header>
    ${question ? `<p class="qtext">${esc(question.text)}</p>` : ""}
    ${answer !== undefined ? `<details class="answer"><summary>${L.answer}</summary><pre>${esc(answer || L.notAttempted)}</pre></details>` : ""}
    <p class="summary">${esc(r.summary)}</p>
    <div class="table-wrap"><table class="crit">
      <thead><tr><th>${L.criterion}</th><th>${L.result}</th><th>${L.marks}</th><th>${L.why}</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    ${list(L.strengths, r.strengths.map((s) => `<li>${esc(s)}</li>`))}
    ${list(L.improve, improvements, "improve")}
    ${list(L.misconceptions, r.misconceptions.map((s) => `<li>${esc(s)}</li>`))}
  </article>`;
}

/** Overall summary, top priorities and study plan. @returns {string} HTML */
export function overallBlock(o, L = LABELS.en) {
  if (!o) return "";
  return `<section class="overall">
    <h3>${L.overall}</h3><p>${esc(o.summary)}</p>
    <div class="two">
      <div><h4>${L.priorities}</h4><ol>${o.top_priorities.map((p) => `<li>${esc(p)}</li>`).join("")}</ol></div>
      <div><h4>${L.plan}</h4><ul>${o.study_plan.map((p) => `<li>${esc(p)}</li>`).join("")}</ul></div>
    </div></section>`;
}

/** Styles for the downloaded report (self-contained; no external files). */
const REPORT_CSS = `
:root{--bg:#f4f6f9;--surface:#fff;--subtle:#f8f9fb;--ink:#0f1a2e;--text:#283244;--muted:#5d6779;--line:#e1e5eb;
--brand:#1e2a78;--brand-soft:#eef0fa;--brand-text:#2d3a91;--ok:#157347;--ok-soft:#e7f4ec;--warn:#8a5a00;--warn-soft:#fcf3dc;--bad:#b42318;--bad-soft:#fdecea}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.6 "IBM Plex Sans",system-ui,-apple-system,"Segoe UI","Nirmala UI","Noto Sans Devanagari","Noto Sans Tamil",sans-serif}
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

/**
 * A complete HTML page with one student's feedback, for download or printing.
 * @param {import("../core/grader.js").StudentReport} report
 * @param {import("../core/exam.js").Exam} exam
 * @param {Record<string, string>} [answers]
 * @returns {string}
 */
export function standaloneHTML(report, exam, answers) {
  const labels = reportLabels(report);
  const questions = report.questions.map((r) => questionBlock(r, exam, { answer: answers ? answers[r.question_id] : undefined, labels })).join("");
  return `<!doctype html><html lang="${labels.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Feedback – ${esc(report.student_id)}</title><style>${REPORT_CSS}</style></head><body><main>
<h1>${esc(report.exam_title)}</h1>
<p class="meta">${esc(report.student_id)}</p>
<div class="total">${fmt(report.total_awarded)}<span class="of"> / ${fmt(report.total_marks)} · ${fmt(report.percentage)}%</span></div>
${overallBlock(report.overall, labels)}${questions}
<footer>Graded against the rubric by ${esc(report.models?.grader || "an AI grader")}, with ${report.models?.samples || 1} independent grading passes per question. Quotes are taken from the student's own answer.</footer>
</main></body></html>`;
}

const csvCell = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

/**
 * The class marksheet as CSV. Starts with a byte-order mark so Excel shows names in Indian
 * scripts correctly.
 * @param {import("../core/exam.js").Exam} exam
 * @param {import("../core/pipeline.js").Student[]} students
 * @returns {string}
 */
export function marksheetCSV(exam, students) {
  const qs = exam.questions;
  const rows = [["student", "source", ...qs.map((q) => `Q${q.id} (/${fmt(q.max_marks)})`), "total", "max", "percent", "notes"]];
  for (const s of students) {
    if (!s.report) {
      rows.push([s.label, s.source, ...qs.map(() => ""), "", "", "", s.status === "error" ? `could not grade: ${s.error}` : "not graded"]);
      continue;
    }
    const r = s.report;
    const notes = r.questions.filter((q) => q.confidence !== "high").map((q) => `check Q${q.question_id}`);
    if (s.notThisTest) notes.unshift("sheet may belong to a different test");
    rows.push([r.student_id, s.source, ...r.questions.map((q) => fmt(q.marks_awarded)), fmt(r.total_awarded), fmt(r.total_marks), fmt(r.percentage), notes.join("; ")]);
  }
  return "\ufeff" + rows.map((row) => row.map(csvCell).join(",")).join("\n") + "\n";
}
