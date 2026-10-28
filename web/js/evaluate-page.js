/**
 * @file Entry point of the evaluation page (evaluate.html).
 *
 * Grades sheets that a teacher has already marked, optionally more than once, and reports how
 * closely the grader agrees with the teacher (core/evaluation.js). Can also ask an AI judge to
 * rate each piece of feedback. Uses exactly the same pipeline as the grading page.
 */
import { GradingRun } from "./core/pipeline.js";
import { LLM, isStopError } from "./core/llm.js";
import { JUDGE_SYSTEM } from "./core/prompts.js";
import { readTeacherMarks, evaluate } from "./core/evaluation.js";
import { browserReader } from "./browser/ingest.js";
import { $, esc, fmt, money, download } from "./ui/dom.js";
import { getSettings, onSettingsChange, openSettings, initSettingsDialog } from "./ui/settings.js";
import { files, getMode, initUploads } from "./ui/uploads.js";
import { initLanguagePicker, drawNotice, lockForm, formProblem } from "./ui/common.js";

/** The run currently grading (so Stop can reach it). */
let current = null;
let busy = false;
let cost = 0;

const status = (html) => { const el = $("#evalStatus"); el.hidden = false; el.innerHTML = html; };

$("#form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (busy) return;
  const csvFile = $("#teacherCsv").files[0];
  const problem = formProblem(files) || (!csvFile ? "Add the teacher's marks (CSV)." : "");
  $("#formError").textContent = problem;
  if (problem) { if (problem.includes("API key")) openSettings(); return; }
  busy = true;
  lockForm($("#form"), true);
  $("#evalResults").hidden = true;
  try {
    await runEvaluation(await csvFile.text(), +$("#repeats").value, $("#judge").checked);
  } catch (err) {
    status(`<div class="notice warn">${esc(err.message)}</div>`);
  } finally {
    busy = false;
    current = null;
    lockForm($("#form"), false);
  }
});

$("#evalStatus").addEventListener("click", (e) => { if (e.target.closest("[data-stop]")) current?.stop(); });

/** Grade the sheets `repeats` times, then compare with the teacher. */
async function runEvaluation(csvText, repeats, withJudge) {
  const runs = [];
  cost = 0;
  for (let k = 1; k <= repeats; k++) {
    current = k === 1
      ? new GradingRun({ settings: getSettings(), testFiles: { qp: files.qp, rubric: files.rubric, model: files.model },
          sheetFiles: files.sheets, mode: getMode(), reader: browserReader })
      : GradingRun.regrade(runs[0]);
    const label = repeats > 1 ? `Grading run ${k} of ${repeats}. ` : "";
    const show = () => {
      const done = current.students.filter((s) => s.report).length;
      status(`<p class="status"><span class="spinner" aria-hidden="true"></span>${esc(label)}${esc(current.step || `${done} of ${current.students.length || "?"} sheets graded.`)}
        <span class="muted">Cost ${money(cost + current.usage.costUsd)}</span> <button class="btn small" data-stop>Stop</button></p>`);
    };
    current.addEventListener("change", show);
    show();
    if (k === 1) {
      await current.start();
      if (current.status === "review") {
        const msgs = current.checks.filter((c) => c.level === "error").map((c) => c.message);
        throw new Error(`The documents don't seem to belong together: ${msgs.join(" ")}`);
      }
    } else {
      await current.start();
    }
    cost += current.usage.costUsd;
    if (current.status !== "done") throw new Error(current.message || "Grading stopped.");
    runs.push(current);
  }

  const exam = runs[0].exam;
  const result = evaluate(exam, runs, readTeacherMarks(csvText, exam));
  let judge = null;
  if (withJudge) judge = await judgeFeedback(runs[0]);
  $("#evalStatus").hidden = true;
  render(exam, runs, result, judge);
}

/** Ask an AI judge to rate each answer's feedback from 1 to 5 on four dimensions. */
async function judgeFeedback(run) {
  const llm = new LLM({ ...run.settings, max_parallel: 4 });
  const graded = run.students.filter((s) => s.report);
  const total = graded.reduce((a, s) => a + s.report.questions.length, 0);
  let done = 0;
  const scores = [];
  await Promise.all(graded.flatMap((s) => s.report.questions.map(async (r) => {
    const q = run.exam.questions.find((x) => x.id === r.question_id);
    const user = `QUESTION (${q.max_marks} marks): ${q.text}\nRUBRIC: ${q.rubric.map((c) => `[${c.id}] ${c.description} (${c.marks})`).join("; ")}\n` +
      `MODEL ANSWER: ${q.model_answer}\nSTUDENT ANSWER: ${s.answers?.[q.id] || "(blank)"}\n\nGRADER OUTPUT:\n` +
      JSON.stringify({ marks_awarded: r.marks_awarded, criteria: r.criteria, strengths: r.strengths, improvements: r.improvements, misconceptions: r.misconceptions, summary: r.summary }, null, 1);
    try { scores.push(await llm.chatJSON(run.settings.grader_model, JUDGE_SYSTEM, user, { task: "judge" })); }
    catch (e) { if (isStopError(e)) throw e; }
    done += 1;
    status(`<p class="status"><span class="spinner" aria-hidden="true"></span>Rating feedback… ${done} of ${total}</p>`);
  })));
  cost += llm.usage.costUsd;
  const dims = ["specificity", "actionability", "rubric_alignment", "accuracy"];
  const avg = (d) => { const v = scores.map((x) => +x[d]).filter(Number.isFinite); return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2) : null; };
  return { rated: scores.length, averages: Object.fromEntries(dims.map((d) => [d, avg(d)])) };
}

/** Show the metrics, the per-answer comparison, and download links. */
function render(exam, runs, { metrics, rows, unmatched }, judge) {
  const el = $("#evalResults");
  el.hidden = false;
  if (!rows.length) {
    el.innerHTML = `<div class="notice warn">None of the students in the CSV matched a graded sheet. Use the names or roll numbers shown on the sheets.</div>`;
    return;
  }
  const judgeHTML = judge ? `<h3>Feedback quality (AI judge, 1–5)</h3>
    <div class="table-wrap"><table><tbody>${Object.entries(judge.averages).map(([k, v]) =>
      `<tr><td>${esc(k.replace("_", " "))}</td><td class="num"><strong>${v ?? "–"}</strong></td></tr>`).join("")}</tbody></table></div>
    <p class="small muted">${judge.rated} answers rated by ${esc(runs[0].settings.grader_model)}.</p>` : "";
  el.innerHTML = `
    <div class="run-head"><div><h2>Evaluation results</h2>
      <p class="status">${rows.length} answers from ${new Set(rows.map((r) => r.student)).size} students, graded ${runs.length} time${runs.length > 1 ? "s" : ""}.
      <span class="muted">Cost ${money(cost)}</span></p></div>
      <div class="row"><button class="btn" data-dl="md">Download report</button><button class="btn" data-dl="json">Download data (JSON)</button></div></div>
    ${unmatched.length ? `<p class="small muted">Rows in the CSV with no matching sheet in this batch (skipped): ${esc(unmatched.join(", "))}</p>` : ""}
    <div class="table-wrap"><table class="metrics"><thead><tr><th>Metric</th><th class="num">Value</th><th>What it means</th></tr></thead>
      <tbody>${metrics.map(([name, value, meaning]) => `<tr><td>${esc(name)}</td><td class="num"><strong>${value ?? "–"}</strong></td><td class="muted">${esc(meaning)}</td></tr>`).join("")}</tbody></table></div>
    ${judgeHTML}
    <h3>Answer by answer</h3>
    <div class="table-wrap"><table><thead><tr><th>Student</th><th>Q</th><th class="num">Teacher</th><th class="num">Grader</th>${runs.length > 1 ? `<th class="num">Each run</th>` : ""}<th class="num">Difference</th></tr></thead>
      <tbody>${rows.map((r) => `<tr><td>${esc(r.student)}</td><td>${esc(r.question)}</td><td class="num">${fmt(r.teacher)}</td><td class="num">${fmt(r.ai.toFixed(2))}</td>
        ${runs.length > 1 ? `<td class="num">${r.runs.map(fmt).join(", ")}</td>` : ""}
        <td class="num ${Math.abs(r.ai - r.teacher) > 1 ? "lo" : ""}">${fmt((r.ai - r.teacher).toFixed(2))}</td></tr>`).join("")}</tbody></table></div>`;

  el.querySelector("[data-dl='md']").onclick = () => download("evaluation_report.md", markdownReport(exam, runs, metrics, rows, judge), "text/markdown");
  el.querySelector("[data-dl='json']").onclick = () => download("evaluation.json",
    JSON.stringify({ settings: { ...runs[0].settings, api_key: undefined }, metrics, judge, rows }, null, 2), "application/json");
  el.scrollIntoView({ behavior: "smooth", block: "start" });
}

/** The results as Markdown, ready to paste into a project report. */
function markdownReport(exam, runs, metrics, rows, judge) {
  const s = runs[0].settings;
  const lines = [
    `# Evaluation: ${exam.title}`, "",
    `Grader: \`${s.grader_model}\`, reader: \`${s.reading_model}\`, ${s.samples} grading passes per answer, graded ${runs.length} time(s). Cost $${cost.toFixed(2)}.`, "",
    "| Metric | Value | What it means |", "|---|---|---|",
    ...metrics.map(([n, v, m]) => `| ${n} | ${v ?? "–"} | ${m} |`), "",
  ];
  if (judge) lines.push("## Feedback quality (AI judge, 1–5)", "", "| Dimension | Average |", "|---|---|",
    ...Object.entries(judge.averages).map(([k, v]) => `| ${k.replace("_", " ")} | ${v ?? "–"} |`), "");
  lines.push("## Answer by answer", "", "| Student | Q | Teacher | Grader | Difference |", "|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.student} | ${r.question} | ${fmt(r.teacher)} | ${fmt(r.ai.toFixed(2))} | ${fmt((r.ai - r.teacher).toFixed(2))} |`));
  return lines.join("\n") + "\n";
}

initSettingsDialog();
onSettingsChange(() => { drawNotice(); $("#formError").textContent = ""; });
initUploads(() => busy);
initLanguagePicker();
drawNotice();
