/**
 * @file The results area: run status and actions, document-check panel, the class marksheet,
 * and one student's report. Everything is redrawn from the `GradingRun`'s state.
 */
import { $, esc, fmt, money, safeName, toast, download } from "./dom.js";
import { questionBlock, overallBlock, standaloneHTML, marksheetCSV, reportLabels } from "./report.js";

/** @type {import("../core/pipeline.js").GradingRun | null} */
let run = null;
/** Student whose report is open. */
let selected = null;
/** Called when the teacher starts a new batch. */
let onNewBatch = () => {};

const CHECK_SOURCE = { question_paper: "Question paper", rubric: "Rubric", model_answers: "Model answers" };

/** Show a run (or hide the results area when `r` is null). */
export function showRun(r) {
  run = r;
  selected = null;
  $("#report").hidden = true;
  if (run) run.addEventListener("change", scheduleDraw);
  draw();
}

let drawQueued = false;
/** Redraw at most once per animation frame, however many changes arrive. */
function scheduleDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => { drawQueued = false; draw(); });
}

function draw() {
  const el = $("#run");
  el.hidden = !run;
  if (!run) return;
  el.innerHTML = headerHTML() + checksHTML() + testHTML() + marksheetHTML();
  if (selected) drawReport();
}

/** Title, status line, progress bar and action buttons. */
function headerHTML() {
  const total = run.students.length;
  const done = run.students.filter((s) => s.report).length;
  const failed = run.students.filter((s) => s.status === "error").length;
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const status = {
    idle: "Getting ready",
    reading: run.step || "Getting ready",
    review: "Grading has not started: please check the documents.",
    grading: `Grading… ${done} of ${plural(total, "sheet")} done.`,
    done: `Done. ${done} of ${plural(total, "sheet")} graded${failed ? `, ${failed} could not be graded` : ""}.`,
    stopped: `${done} of ${total || "?"} sheets graded.`,
  }[run.status];

  const actions = [];
  if (run.busy) actions.push(`<button class="btn" data-a="stop">Stop</button>`);
  else {
    if (run.status === "stopped") actions.push(`<button class="btn primary" data-a="continue">Continue</button>`);
    if (run.status === "review") actions.push(`<button class="btn" data-a="anyway">Grade anyway</button>`);
    if (failed) actions.push(`<button class="btn primary" data-a="retry">Try failed sheets again</button>`);
    if (done) actions.push(`<button class="btn" data-a="csv">Download marksheet</button><button class="btn" data-a="zip">Download all reports</button>`);
    actions.push(`<button class="btn ghost" data-a="new">Grade another batch</button>`);
  }
  const pct = total ? Math.round((100 * done) / total) : 0;
  return `
    <div class="run-head">
      <div><h2>Results</h2>
        <p class="status">${run.busy ? `<span class="spinner" aria-hidden="true"></span>` : ""}${esc(status)}
        <span class="muted">Cost ${money(run.usage.costUsd)}${run.settings.mock ? " (demo mode)" : ""}</span></p></div>
      <div class="row">${actions.join("")}</div>
    </div>
    ${run.busy && total ? `<div class="progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><div style="width:${pct}%"></div></div>` : ""}
    ${run.message ? `<div class="notice warn">${esc(run.message)}</div>` : ""}`;
}

/** Problems the document check found. Errors stop grading until the teacher decides. */
function checksHTML() {
  const errors = run.checks.filter((c) => c.level === "error");
  const warnings = run.checks.filter((c) => c.level === "warning");
  const item = (c) => `<li><strong>${esc(CHECK_SOURCE[c.about] || "Documents")}${c.question_id ? `, Q${esc(c.question_id)}` : ""}:</strong> ${esc(c.message)}</li>`;
  if (errors.length && run.status === "review") {
    return `<div class="check-panel error">
      <h3>These documents don't seem to belong together</h3>
      <ul>${errors.map(item).join("")}</ul>
      <p>Replace the wrong file above and press <strong>Grade answer sheets</strong> again. Nothing has been graded, so no grading cost was spent.
      If the files are right, press <strong>Grade anyway</strong>.</p></div>`;
  }
  if (!errors.length && !warnings.length) return "";
  return `<div class="check-panel">
      <h3>Things to check in the test documents</h3>
      <ul>${[...errors, ...warnings].map(item).join("")}</ul>
      <p class="small muted">${errors.length ? "You chose to grade anyway. " : ""}Where a model answer looks wrong, the grader follows the rubric and correct subject knowledge instead.</p></div>`;
}

/** The questions and criteria the grader is using, so the teacher can verify them. */
function testHTML() {
  const exam = run.exam;
  if (!exam) return "";
  const qs = exam.questions;
  const max = qs.reduce((a, q) => a + q.max_marks, 0);
  return `<details class="testinfo"><summary>Questions and rubric read from your documents: ${qs.length} question${qs.length === 1 ? "" : "s"}, ${fmt(max)} marks</summary>
    ${run.warnings.length ? `<ul class="warnings">${run.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}
    <ol class="qlist">${qs.map((q) => `<li><p><strong>Q${esc(q.id)}</strong> <span class="muted">(${fmt(q.max_marks)} marks)</span> ${esc(q.text)}</p>
      <ul>${q.rubric.map((c) => `<li>${esc(c.description)} <span class="muted">— ${fmt(c.marks)}</span></li>`).join("")}</ul></li>`).join("")}</ol></details>`;
}

/** One row per student; marks are coloured by the share of the question's marks. */
function marksheetHTML() {
  if (!run.students.length) return "";
  const qs = run.exam?.questions || [];
  const graded = run.students.filter((s) => s.report);
  const rows = run.students.map((s, i) => {
    if (!s.report) {
      const state = s.status === "working" ? `<span class="badge working">${esc(s.step || "Working")}</span>`
        : s.status === "error" ? `<span class="badge error">Could not grade</span> <span class="small">${esc(s.error)}</span>`
        : `<span class="badge">Waiting</span>`;
      return `<tr><th scope="row">${esc(s.label)}<div class="src">${esc(s.source)}</div></th><td colspan="${qs.length + 1}">${state}</td></tr>`;
    }
    const r = s.report;
    const cells = r.questions.map((q) => {
      const share = q.marks_awarded / q.max_marks;
      const flag = q.confidence !== "high" ? `<span class="flag" title="Worth checking: the grading passes disagreed or a check failed">⚑</span>` : "";
      return `<td class="num"><span class="${share < 0.4 ? "lo" : share < 0.7 ? "mid" : "hi"}">${fmt(q.marks_awarded)}</span>${flag}</td>`;
    }).join("");
    const notThisTest = s.notThisTest ? ` <span class="conf" title="No answers to this question paper were found on this sheet">Not this test?</span>` : "";
    return `<tr class="click ${selected === s ? "sel" : ""}" data-i="${i}" tabindex="0">
      <th scope="row"><a href="#report" data-i="${i}">${esc(r.student_id)}</a>${notThisTest}<div class="src">${esc(s.source)}</div></th>
      ${cells}<td class="num total"><strong>${fmt(r.total_awarded)}</strong>/${fmt(r.total_marks)}</td></tr>`;
  }).join("");

  let footer = "";
  if (graded.length > 1) {
    const mean = (f) => graded.reduce((a, s) => a + f(s), 0) / graded.length;
    footer = `<tfoot><tr><th scope="row">Class average</th>${qs.map((q, k) => `<td class="num">${fmt(mean((s) => s.report.questions[k].marks_awarded).toFixed(1))}</td>`).join("")}
      <td class="num total">${fmt(mean((s) => s.report.total_awarded).toFixed(1))}</td></tr></tfoot>`;
  }
  return `<div class="table-wrap"><table class="marksheet">
      <thead><tr><th scope="col">Student</th>${qs.map((q) => `<th scope="col" class="num">Q${esc(q.id)}<span class="muted">/${fmt(q.max_marks)}</span></th>`).join("")}<th scope="col" class="num">Total</th></tr></thead>
      <tbody>${rows}</tbody>${footer}</table></div>
    ${graded.length ? `<p class="small muted">Click a student to see their feedback. ⚑ marks an answer worth checking.</p>` : ""}`;
}

// ------------------------------------------------------------------ one student's report

function openReport(student) {
  if (!student?.report) return;
  selected = student;
  draw();
  $("#report").scrollIntoView({ behavior: "smooth", block: "start" });
}

function drawReport() {
  const st = selected, r = st.report, labels = reportLabels(r);
  const graded = run.students.filter((s) => s.report), i = graded.indexOf(st);
  const el = $("#report");
  el.hidden = false;
  el.innerHTML = `
    <div class="report-head">
      <div><h2>${esc(r.student_id)}</h2><p class="muted small">${esc(st.source)}</p></div>
      <div class="report-score"><span class="total-big">${fmt(r.total_awarded)}<span class="of"> / ${fmt(r.total_marks)}</span></span>
        <span class="pct">${fmt(r.percentage)}%</span><span class="bar" aria-hidden="true"><span style="width:${Math.min(100, r.percentage)}%"></span></span></div>
      <div class="row">
        ${graded[i - 1] ? `<button class="btn" data-nav="${run.students.indexOf(graded[i - 1])}">Previous</button>` : ""}
        ${graded[i + 1] ? `<button class="btn" data-nav="${run.students.indexOf(graded[i + 1])}">Next student</button>` : ""}
        <button class="btn" data-download>Download report</button>
      </div>
    </div>
    ${r.models?.mock ? `<div class="notice warn">Demo mode: these marks are not real.</div>` : ""}
    ${st.warnings?.length ? `<div class="notice warn">${st.warnings.map(esc).join("<br>")}</div>` : ""}
    ${overallBlock(r.overall, labels)}
    ${r.questions.map((q) => questionBlock(q, run.exam, { answer: st.answers?.[q.question_id] ?? "", labels })).join("")}
    ${st.sheetText ? `<details class="sheettext"><summary>Full text read from the sheet</summary><pre>${esc(st.sheetText)}</pre></details>` : ""}`;
}

// ------------------------------------------------------------------ downloads

async function downloadAllReports() {
  if (!window.JSZip) { toast("Still loading. Try again in a moment.", "error"); return; }
  const zip = new window.JSZip(), used = new Set();
  zip.file("marksheet.csv", marksheetCSV(run.exam, run.students));
  for (const s of run.students.filter((x) => x.report)) {
    let base = safeName(s.report.student_id);
    while (used.has(base)) base += "_";
    used.add(base);
    zip.file(`${base}.html`, standaloneHTML(s.report, run.exam, s.answers));
  }
  download("feedback_reports.zip", await zip.generateAsync({ type: "blob" }));
}

// ------------------------------------------------------------------ events

/**
 * Wire up the results area. Call once at start-up.
 * @param {{ onNewBatch: () => void, beforeResume: (run: any) => void }} handlers
 *   `beforeResume` lets the caller apply current settings (e.g. a raised spending limit).
 */
export function initResults({ onNewBatch: newBatch, beforeResume }) {
  onNewBatch = newBatch;
  $("#run").addEventListener("click", (e) => {
    const action = e.target.closest("button[data-a]")?.dataset.a;
    if (action) {
      if (action === "stop") run.stop();
      if (action === "continue") { beforeResume(run); run.start(); }
      if (action === "anyway") run.gradeAnyway();
      if (action === "retry") { beforeResume(run); run.retryFailed(); }
      if (action === "csv") download("marksheet.csv", marksheetCSV(run.exam, run.students), "text/csv");
      if (action === "zip") downloadAllReports();
      if (action === "new") onNewBatch();
      return;
    }
    const row = e.target.closest("tr.click");
    if (row) { e.preventDefault(); openReport(run.students[+row.dataset.i]); }
  });
  $("#run").addEventListener("keydown", (e) => {
    const row = e.target.closest("tr.click");
    if (row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openReport(run.students[+row.dataset.i]); }
  });
  $("#report").addEventListener("click", (e) => {
    const nav = e.target.closest("[data-nav]");
    if (nav) openReport(run.students[+nav.dataset.nav]);
    else if (e.target.closest("[data-download]")) {
      download(`${safeName(selected.report.student_id)}_feedback.html`, standaloneHTML(selected.report, run.exam, selected.answers), "text/html");
    }
  });
}
