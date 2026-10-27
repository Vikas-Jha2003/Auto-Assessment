// Auto-Assessment — one page: upload the test and the answer sheets, grade, read the feedback.
import { LLM, Usage, BudgetExceeded, FatalApiError, checkKey } from "./llm.js";
import { readFilesText, readPages, readLocal, ext, ACCEPT, IMAGE_EXT } from "./ingest.js";
import { buildExam, normaliseExam, validateExam, splitSheet, groupFiles, detectStudents, textUnits } from "./structure.js";
import { gradeQuestion, overallFeedback, buildReport } from "./grader.js";
import { esc, fmt, questionBlock, overallBlock, standaloneHTML, classCSV } from "./report.js";

const $ = (s, r = document) => r.querySelector(s);
const STUDENTS_AT_ONCE = 3;

// ------------------------------------------------------------------ settings
const SETTINGS_KEY = "aa.settings";
const DEFAULTS = {
  api_key: "", grader_model: "anthropic/claude-sonnet-5.5", reading_model: "anthropic/claude-haiku-5.5",
  samples: 3, budget_usd: 3, mock: false,
};
function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") }; } catch { return { ...DEFAULTS }; }
}
let settings = loadSettings();
function saveSettings(s) {
  settings = s;
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* storage blocked: keep for this visit */ }
}
// what the grading engine expects
const engineSettings = () => ({
  ...settings, fast_model: settings.reading_model, vision_model: settings.reading_model,
  temperature: 0.4, disagreement_threshold: 0.2, mark_step: 0.5, max_parallel: 4, overall_feedback: true,
});

// ------------------------------------------------------------------ helpers
function toast(msg, kind = "info", ms = 4000) {
  const el = document.createElement("div");
  el.className = `toast ${kind}`; el.setAttribute("role", "status"); el.textContent = msg;
  $("#toasts").append(el); setTimeout(() => el.remove(), ms);
}
function download(name, content, type = "text/plain") {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
const safeName = (s) => String(s || "file").replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "file";
const money = (x) => (x > 0 && x < 0.01 ? `$${x.toFixed(4)}` : `$${(x || 0).toFixed(2)}`);
// "Ananya Rao    Roll No: 21CS042" -> "Ananya Rao (21CS042)"
const tidyName = (s) => {
  const t = String(s || "").replace(/\s+/g, " ").replace(/^(name|student)\s*:\s*/i, "").trim();
  const m = t.match(/^(.*?)[\s,;|-]*\(?\s*roll(?:\s*no)?\.?\s*[:#-]?\s*([\w/-]+)\)?$/i);
  return m && m[1] ? `${m[1].trim()} (${m[2]})` : t;
};
const stopError = (e) => e?.name === "AbortError" || e instanceof BudgetExceeded || e instanceof FatalApiError;

// ------------------------------------------------------------------ uploads
const files = { qp: [], rubric: [], model: [], sheets: [] };
let mode = "individual";
const SLOT_HINTS = {
  qp: "PDF, Word, text or photo",
  rubric: "Marks per point, or mark bands",
  model: "One answer per question",
  sheets: "Select or drop all the files at once",
};

const ICON_UPLOAD = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V4m0 0L7.5 8.5M12 4l4.5 4.5"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>`;
const ICON_FILE = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>`;
const ICON_IMAGE = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M20.5 16l-5-5-8.5 8.5"/></svg>`;

// what was read from each file, locally and for free
const fileInfo = new WeakMap(); // File -> { state: "reading" | "ok" | "error", pages, scanned, words, text, error }
function inspect(file, slot) {
  if (fileInfo.has(file)) return;
  fileInfo.set(file, { state: "reading" });
  readLocal(file).then((r) => {
    fileInfo.set(file, { state: "ok", pages: r.pages.length, scanned: r.scanned, words: r.words,
      text: r.pages.map((p, i) => (p.image ? `[Page ${i + 1}: scanned or photographed. The AI reads it when grading.]` : p.text)).join("\n\n") });
  }).catch((e) => fileInfo.set(file, { state: "error", error: e.message })).finally(() => drawChips(slot));
}
function fileMeta(f) {
  const i = fileInfo.get(f) || { state: "reading" };
  if (i.state === "reading") return `<span class="meta">Reading…</span>`;
  if (i.state === "error") return `<span class="meta err">${esc(i.error)}</span>`;
  const pages = i.pages > 1 ? `${i.pages} pages` : "1 page";
  if (i.scanned === i.pages) return `<span class="meta">${pages} · scanned, read by AI when grading</span>`;
  return `<span class="meta">${pages} · ${i.words.toLocaleString()} words${i.scanned ? ` · ${i.scanned} scanned` : ""}</span>`;
}

function buildSlot(slot) {
  const key = slot.dataset.slot;
  const id = `file-${key}`;
  slot.insertAdjacentHTML("beforeend", `
    <div class="dropzone">
      <input type="file" id="${id}" multiple accept="${ACCEPT}" class="visually-hidden">
      <label for="${id}">${ICON_UPLOAD}<span class="dz-label">${key === "sheets" ? "Upload answer sheets" : "Upload file"}</span>
      <span class="dz-hint">${SLOT_HINTS[key]}</span></label>
    </div>
    <ul class="files"></ul>`);
  const input = $("input", slot), zone = $(".dropzone", slot);
  const add = (list) => {
    const ok = list.filter((f) => ACCEPT.split(",").includes("." + ext(f.name)));
    if (ok.length < list.length) toast("Some files were skipped. Use PDF, Word (.docx), text or image files.", "error");
    files[key].push(...ok); ok.forEach((f) => inspect(f, slot)); drawChips(slot); clearError();
  };
  input.addEventListener("change", () => { add([...input.files]); input.value = ""; });
  zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("over"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", (e) => { e.preventDefault(); zone.classList.remove("over"); if (!busy()) add([...e.dataTransfer.files]); });
  $(".files", slot).addEventListener("click", (e) => {
    const rm = e.target.closest("button.x"), pv = e.target.closest("button.pv");
    if (pv) return preview(files[key][+pv.dataset.i]);
    if (!rm || busy()) return;
    files[key].splice(+rm.dataset.i, 1); drawChips(slot);
  });
  drawChips(slot);
}

function drawChips(slot) {
  const key = slot.dataset.slot, list = files[key], ul = $(".files", slot);
  ul.innerHTML = list.map((f, i) => `<li>
      <span class="ficon">${IMAGE_EXT.includes(ext(f.name)) ? ICON_IMAGE : ICON_FILE}</span>
      <span class="fname"><span class="fn">${esc(f.name)}</span>${fileMeta(f)}</span>
      ${fileInfo.get(f)?.state === "ok" ? `<button type="button" class="pv" data-i="${i}">Preview</button>` : ""}
      <button type="button" class="x" data-i="${i}" aria-label="Remove ${esc(f.name)}">×</button></li>`).join("");
  slot.classList.toggle("filled", list.length > 0);
  if (key === "sheets" && list.length) {
    const n = groupFiles(list, true).length;
    ul.insertAdjacentHTML("beforeend", `<li class="count">${list.length} file${list.length === 1 ? "" : "s"}${mode === "individual" ? ` · ${n} student${n === 1 ? "" : "s"}` : " · students are found when grading starts"}</li>`);
  }
}

const previewDlg = $("#preview");
function preview(f) {
  const i = fileInfo.get(f);
  $("#previewTitle").textContent = f.name;
  $("#previewMeta").innerHTML = fileMeta(f);
  $("#previewText").textContent = i?.text?.trim() || "(no text found)";
  previewDlg.showModal();
}

function drawMode() {
  document.querySelectorAll(".seg button").forEach((b) => b.setAttribute("aria-checked", b.dataset.mode === mode));
  $("#modeHint").innerHTML = mode === "individual"
    ? `Each file is one student. Photos of several pages are joined when they share a name, like <code>21CS081_p1.jpg</code> and <code>21CS081_p2.jpg</code>.`
    : `One or more PDF or Word files, each holding several students' sheets one after another (for example one scan per section). Upload them all together; each student is found from the name or roll number at the top of their sheet.`;
  drawChips($('[data-slot="sheets"]'));
}

const formError = (msg) => { $("#formError").textContent = msg; };
const clearError = () => formError("");

function drawNotice() {
  const n = $("#notice");
  $("#settingsDot").hidden = !!(settings.api_key || settings.mock);
  if (settings.mock) n.innerHTML = `<div class="notice warn">Demo mode is on, so marks are fake. Turn it off in <button type="button" class="linklike" data-open-settings>Settings</button> to grade for real.</div>`;
  else if (!settings.api_key) n.innerHTML = `<div class="notice">You can upload and preview files now; typed PDFs, Word and text files are read in your browser for free. To grade, add your OpenRouter API key in <button type="button" class="linklike" data-open-settings>Settings</button>.</div>`;
  else n.innerHTML = "";
}

// ------------------------------------------------------------------ the job
let job = null;          // current grading run
let examCache = null;    // { key, exam, warnings } so a second batch doesn't re-read the same test
let selected = null;     // student whose report is open
const busy = () => job?.status === "reading" || job?.status === "grading";
const testKey = () => ["qp", "rubric", "model"].map((k) => files[k].map((f) => `${f.name}:${f.size}:${f.lastModified}`).join("|")).join("#");

$("#form").addEventListener("submit", (e) => {
  e.preventDefault();
  if (busy()) return;
  if (!settings.mock && !settings.api_key) { formError("Add your OpenRouter API key in Settings first."); openSettings(); return; }
  if (!files.qp.length) return formError("Add the question paper.");
  if (!files.rubric.length) return formError("Add the rubric.");
  if (!files.sheets.length) return formError("Add at least one answer sheet.");
  clearError();
  start();
});

async function start() {
  job = { status: "reading", step: "", mode, sheetFiles: [...files.sheets], exam: null, warnings: [], checks: [], checksAccepted: false, students: [], split: false, filesSplit: 0,
          usage: new Usage(settings.budget_usd), message: "", startedAt: Date.now() };
  selected = null; $("#report").hidden = true;
  lockForm(true);
  $("#run").hidden = false; draw();
  $("#run").scrollIntoView({ behavior: "smooth", block: "start" });
  await go();
}

async function go() {
  const ctl = new AbortController();
  job.ctl = ctl; job.message = "";
  job.usage.budget = settings.budget_usd;
  let llm;
  try {
    llm = new LLM(engineSettings(), { usage: job.usage, signal: ctl.signal });
    const onPage = (what) => (i, n, how) => { job.step = `${how === "transcribing" ? "Reading the handwriting in" : "Reading"} ${what}, page ${i} of ${n}`; draw(); };

    // 1. the test
    if (!job.exam) {
      job.status = "reading";
      const key = testKey();
      if (examCache?.key === key) { job.exam = examCache.exam; job.warnings = examCache.warnings; job.checks = examCache.checks; }
      else {
        job.step = "Reading the question paper and rubric"; draw();
        const qp = await readFilesText(llm, files.qp, "question paper", onPage("the question paper"));
        const rb = await readFilesText(llm, files.rubric, "rubric", onPage("the rubric"));
        const ma = files.model.length ? await readFilesText(llm, files.model, "model answers", onPage("the model answers")) : "";
        job.step = "Turning the rubric into marking criteria"; draw();
        const raw = await buildExam(llm, qp, rb, ma);
        if (!raw.questions.length) throw new FatalApiError("No questions were found in the question paper. Check that the right file was uploaded.");
        job.warnings = validateExam(raw).filter((i) => i.level === "warn").map((i) => i.msg.replace(/, but the question.*/, ". The criteria were scaled to fit."));
        job.checks = raw.checks || [];
        job.exam = normaliseExam(raw);
        examCache = { key, exam: job.exam, warnings: job.warnings, checks: job.checks };
      }
    }

    // the documents may not belong together: stop before spending money on grading
    if (job.checks.some((c) => c.level === "error") && !job.checksAccepted) {
      job.status = "review";
      return;
    }

    // 2. who are the students
    if (!job.split) {
      if (job.mode === "individual") {
        job.students = groupFiles(job.sheetFiles, true).map((g) => ({ label: g.label, files: g.files, source: g.files.map((f) => f.name).join(", "), status: "waiting" }));
      } else {
        // whole class: one or many files, each holding one or more students' sheets; each file is split on its own
        const n = job.sheetFiles.length;
        for (; job.filesSplit < n; job.filesSplit++) {
          const f = job.sheetFiles[job.filesSplit];
          const of = n > 1 ? ` (file ${job.filesSplit + 1} of ${n})` : "";
          const pages = await readPages(llm, f, "class answer sheets", (i, t, how) => {
            job.step = `${how === "transcribing" ? "Reading the handwriting in" : "Reading"} ${f.name}, page ${i} of ${t}${of}`; draw(); });
          const paged = ext(f.name) === "pdf" || IMAGE_EXT.includes(ext(f.name));
          const units = paged ? pages : textUnits(pages.join("\n\n"));
          if (!units.join("").trim()) continue;
          job.step = `Finding each student in ${f.name}${of}`; draw();
          const stem = f.name.replace(/\.[^.]+$/, "");
          const parts = await detectStudents(llm, units, stem);
          const unitName = paged ? (units.length === 1 ? "page" : "pages") : "parts";
          job.students.push(...parts.map((p) => ({ label: tidyName(p.label), pages: p.units, status: "waiting",
            source: units.length === 1 ? f.name : `${f.name}, ${unitName} ${p.range[0]}${p.range[1] > p.range[0] ? "–" + p.range[1] : ""}` })));
          draw();
        }
        if (!job.students.length) throw new FatalApiError("No answer sheets with any text were found in the uploaded files.");
      }
      job.split = true;
    }

    // 3. grade
    job.status = "grading"; job.step = ""; draw();
    job.students.forEach((s) => { if (s.status === "working") s.status = "waiting"; });
    const queue = job.students.filter((s) => s.status === "waiting");
    let stop = null;
    const worker = async () => {
      while (queue.length && !stop) {
        const st = queue.shift();
        try { await gradeStudent(llm, st); st.status = "done"; }
        catch (e) {
          if (stopError(e)) { stop ||= e; st.status = "waiting"; ctl.abort(); }
          else { st.status = "error"; st.error = e.message || String(e); console.error(e); }
        }
        st.step = ""; draw();
      }
    };
    await Promise.all(Array.from({ length: STUDENTS_AT_ONCE }, worker));
    if (stop) throw stop;
    job.status = "done";
  } catch (e) {
    job.status = "stopped";
    job.students.forEach((s) => { if (s.status === "working") { s.status = "waiting"; s.step = ""; } });
    job.message = e.name === "AbortError" ? "Stopped. Press Continue to carry on where it left off."
      : e instanceof BudgetExceeded ? e.message.replace("Raise it in Settings and press Resume.", "Raise the spending limit in Settings, then press Continue.")
      : e.message || String(e);
    if (!(e instanceof BudgetExceeded) && e.name !== "AbortError" && !(e instanceof FatalApiError)) console.error(e);
  } finally {
    job.step = "";
    lockForm(false);
    draw();
  }
}

async function gradeStudent(llm, st) {
  const exam = job.exam;
  // grading calls already in flight keep finishing after Stop; they must not mark the sheet as busy again
  const set = (step) => { if (llm.signal?.aborted) return; st.status = "working"; st.step = step; draw(); };
  if (!st.answers) {
    if (st.sheetText == null) {
      set("Reading the sheet");
      st.sheetText = st.files
        ? await readFilesText(llm, st.files, "answer sheet", (i, n, how) => set(`${how === "transcribing" ? "Reading handwriting" : "Reading"}, page ${i} of ${n}`))
        : st.pages.join("\n\n");
    }
    set("Matching answers to questions");
    const al = await splitSheet(llm, exam, st.sheetText);
    st.answers = al.answers; st.warnings = al.warnings; st.detectedId = al.student_id;
    const words = (st.sheetText.match(/\S+/g) || []).length;
    if (al.different_test || (words > 25 && Object.values(st.answers).every((a) => !a.trim()))) {
      for (const k of Object.keys(st.answers)) st.answers[k] = "";
      st.notThisTest = true;
      st.warnings = [...(st.warnings || []), "No answers to this question paper were found on this sheet. Check that it belongs to this test."];
    }
  }
  st.partial ||= {};
  let done = Object.keys(st.partial).length;
  set(`Grading question ${Math.min(done + 1, exam.questions.length)} of ${exam.questions.length}`);
  await Promise.all(exam.questions.filter((q) => !st.partial[q.id]).map(async (q) => {
    st.partial[q.id] = await gradeQuestion(llm, exam, q, st.answers[q.id] || "");
    done++; set(done < exam.questions.length ? `Grading question ${done + 1} of ${exam.questions.length}` : "Writing overall feedback");
  }));
  const results = exam.questions.map((q) => st.partial[q.id]);
  let overall = null;
  try { overall = await overallFeedback(llm, exam, results); } catch (e) { if (stopError(e)) throw e; }
  const name = st.detectedId && !/^(student|unknown|n\/?a|none)?$/i.test(st.detectedId) ? tidyName(st.detectedId) : st.label;
  st.report = buildReport(exam, name, results, overall, {
    models: { grader: settings.grader_model, reader: settings.reading_model, samples: settings.samples, mock: !!settings.mock } });
  delete st.partial;
}

function lockForm(lock) {
  $("#form").classList.toggle("locked", lock);
  $("#form").querySelectorAll("input, button").forEach((el) => { el.disabled = lock; });
}

// ------------------------------------------------------------------ drawing
let drawQueued = false;
function draw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => { drawQueued = false; drawRun(); });
}

function drawRun() {
  const el = $("#run");
  if (!job) { el.hidden = true; return; }
  const exam = job.exam, qs = exam?.questions || [];
  const done = job.students.filter((s) => s.report);
  const failed = job.students.filter((s) => s.status === "error");
  const total = job.students.length;
  const running = busy();

  let status;
  if (job.status === "reading") status = job.step || "Getting ready";
  else if (job.status === "review") status = "Grading has not started: please check the documents.";
  else if (job.status === "grading") status = `Grading… ${done.length} of ${total} sheet${total === 1 ? "" : "s"} done.`;
  else if (job.status === "done") status = `Done. ${done.length} of ${total} sheet${total === 1 ? "" : "s"} graded${failed.length ? `, ${failed.length} could not be graded` : ""}.`;
  else status = `${done.length} of ${total || "?"} sheets graded.`;

  const actions = [];
  if (running) actions.push(`<button class="btn" data-a="stop">Stop</button>`);
  else {
    if (job.status === "stopped") actions.push(`<button class="btn primary" data-a="continue">Continue</button>`);
    if (job.status === "review") actions.push(`<button class="btn" data-a="anyway">Grade anyway</button>`);
    if (failed.length) actions.push(`<button class="btn primary" data-a="retry">Try failed sheets again</button>`);
    if (done.length) actions.push(`<button class="btn" data-a="csv">Download marksheet</button><button class="btn" data-a="zip">Download all reports</button>`);
    actions.push(`<button class="btn ghost" data-a="new">Grade another batch</button>`);
  }

  const pct = total ? Math.round(100 * done.length / total) : 0;
  let html = `
    <div class="run-head">
      <div><h2>Results</h2>
        <p class="status">${running ? `<span class="spinner" aria-hidden="true"></span>` : ""}${esc(status)}
        <span class="muted">Cost ${money(job.usage.cost_usd)}${settings.mock ? " (demo mode)" : ""}</span></p></div>
      <div class="row">${actions.join("")}</div>
    </div>
    ${running && total ? `<div class="progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><div style="width:${pct}%"></div></div>` : ""}
    ${job.message ? `<div class="notice ${job.status === "stopped" ? "warn" : ""}">${esc(job.message)}</div>` : ""}`;

  const errs = (job.checks || []).filter((c) => c.level === "error"), warns = (job.checks || []).filter((c) => c.level === "warning");
  const about = { question_paper: "Question paper", rubric: "Rubric", model_answers: "Model answers" };
  const checkItem = (c) => `<li><strong>${esc(about[c.about] || "Documents")}${c.question_id ? `, Q${esc(c.question_id)}` : ""}:</strong> ${esc(c.message)}</li>`;
  if (errs.length && job.status === "review") html += `<div class="check-panel error">
      <h3>These documents don't seem to belong together</h3>
      <ul>${errs.map(checkItem).join("")}</ul>
      <p>Replace the wrong file above and press <strong>Grade answer sheets</strong> again. Nothing has been graded, so no grading cost was spent.
      If the files are right, press <strong>Grade anyway</strong>.</p></div>`;
  else if (errs.length || warns.length) html += `<div class="check-panel">
      <h3>Things to check in the test documents</h3>
      <ul>${[...errs, ...warns].map(checkItem).join("")}</ul>
      <p class="small muted">${errs.length ? "You chose to grade anyway. " : ""}Where a model answer looks wrong, the grader follows the rubric and correct subject knowledge instead.</p></div>`;

  if (exam) {
    const maxTotal = qs.reduce((a, q) => a + q.max_marks, 0);
    html += `<details class="testinfo"><summary>Questions and rubric read from your documents: ${qs.length} question${qs.length === 1 ? "" : "s"}, ${fmt(maxTotal)} marks</summary>
      ${job.warnings.length ? `<ul class="warnings">${job.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}
      <ol class="qlist">${qs.map((q) => `<li><p><strong>Q${esc(q.id)}</strong> <span class="muted">(${fmt(q.max_marks)} marks)</span> ${esc(q.text)}</p>
        <ul>${q.rubric.map((c) => `<li>${esc(c.description)} <span class="muted">— ${fmt(c.marks)}</span></li>`).join("")}</ul></li>`).join("")}</ol></details>`;
  }

  if (total) {
    const rows = job.students.map((s, i) => {
      if (!s.report) {
        const st = s.status === "working" ? `<span class="badge working">${esc(s.step || "Working")}</span>`
          : s.status === "error" ? `<span class="badge error">Could not grade</span> <span class="small">${esc(s.error)}</span>`
          : `<span class="badge">Waiting</span>`;
        return `<tr><th scope="row">${esc(s.label)}<div class="src">${esc(s.source || "")}</div></th><td colspan="${qs.length + 1}">${st}</td></tr>`;
      }
      const r = s.report;
      const cells = r.questions.map((qr) => {
        const f = qr.marks_awarded / qr.max_marks;
        return `<td class="num"><span class="${f < 0.4 ? "lo" : f < 0.7 ? "mid" : "hi"}">${fmt(qr.marks_awarded)}</span>${qr.confidence !== "high" ? `<span class="flag" title="Worth checking: the grading passes disagreed or a check failed">⚑</span>` : ""}</td>`;
      }).join("");
      return `<tr class="click ${selected === s ? "sel" : ""}" data-i="${i}" tabindex="0"><th scope="row"><a href="#report" data-i="${i}">${esc(r.student_id)}</a>${s.notThisTest ? ` <span class="conf" title="No answers to this question paper were found on this sheet">Not this test?</span>` : ""}<div class="src">${esc(s.source || "")}</div></th>${cells}<td class="num total"><strong>${fmt(r.total_awarded)}</strong>/${fmt(r.total_marks)}</td></tr>`;
    }).join("");
    let avg = "";
    if (done.length > 1) {
      const qavg = qs.map((q, k) => done.reduce((a, s) => a + s.report.questions[k].marks_awarded, 0) / done.length);
      const tavg = done.reduce((a, s) => a + s.report.total_awarded, 0) / done.length;
      avg = `<tfoot><tr><th scope="row">Class average</th>${qavg.map((v) => `<td class="num">${fmt(v.toFixed(1))}</td>`).join("")}<td class="num total">${fmt(tavg.toFixed(1))}</td></tr></tfoot>`;
    }
    html += `<div class="table-wrap"><table class="marksheet">
      <thead><tr><th scope="col">Student</th>${qs.map((q) => `<th scope="col" class="num">Q${esc(q.id)}<span class="muted">/${fmt(q.max_marks)}</span></th>`).join("")}<th scope="col" class="num">Total</th></tr></thead>
      <tbody>${rows}</tbody>${avg}</table></div>
      ${done.length ? `<p class="small muted">Click a student to see their feedback. ⚑ marks an answer worth checking.</p>` : ""}`;
  }
  el.innerHTML = html;
  if (selected) drawReport();
}

$("#run").addEventListener("click", async (e) => {
  const a = e.target.closest("button[data-a]")?.dataset.a;
  if (a === "stop") job.ctl?.abort();
  if (a === "anyway") { job.checksAccepted = true; lockForm(true); job.status = "reading"; draw(); await go(); return; }
  if (a === "continue") { lockForm(true); job.status = job.exam ? "grading" : "reading"; draw(); await go(); }
  if (a === "retry") {
    job.students.filter((s) => s.status === "error").forEach((s) => { s.status = "waiting"; s.error = ""; if (!s.answers) delete s.sheetText; });
    lockForm(true); job.status = "grading"; draw(); await go();
  }
  if (a === "csv") download(`${safeName(job.exam.questions.length ? "marksheet" : "results")}.csv`, classCSV(csvRun()), "text/csv");
  if (a === "zip") zipAll();
  if (a === "new") {
    files.sheets = []; drawChips($('[data-slot="sheets"]'));
    job = null; selected = null; $("#run").hidden = true; $("#report").hidden = true;
    window.scrollTo({ top: 0, behavior: "smooth" });
    toast("The test files are kept. Add the next answer sheets.", "ok");
  }
  const row = e.target.closest("tr.click");
  if (row && !a) { e.preventDefault(); openReport(job.students[+row.dataset.i]); }
});
$("#run").addEventListener("keydown", (e) => {
  const row = e.target.closest("tr.click");
  if (row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openReport(job.students[+row.dataset.i]); }
});

const csvRun = () => ({ exam: job.exam, students: job.students.map((s) => ({ label: s.label, sourceLabel: s.source, status: s.status, error: s.error, report: s.report })) });

function openReport(st) {
  if (!st?.report) return;
  selected = st;
  drawRun();
  $("#report").scrollIntoView({ behavior: "smooth", block: "start" });
}

function drawReport() {
  const el = $("#report"), st = selected, r = st.report, exam = job.exam;
  const graded = job.students.filter((s) => s.report), i = graded.indexOf(st);
  el.hidden = false;
  el.innerHTML = `
    <div class="report-head">
      <div><h2>${esc(r.student_id)}</h2><p class="muted small">${esc(st.source || "")}</p></div>
      <div class="report-score"><span class="total-big">${fmt(r.total_awarded)}<span class="of"> / ${fmt(r.total_marks)}</span></span>
        <span class="pct">${fmt(r.percentage)}%</span><span class="bar" aria-hidden="true"><span style="width:${Math.min(100, r.percentage)}%"></span></span></div>
      <div class="row">
        ${graded[i - 1] ? `<button class="btn" data-nav="${job.students.indexOf(graded[i - 1])}">Previous</button>` : ""}
        ${graded[i + 1] ? `<button class="btn" data-nav="${job.students.indexOf(graded[i + 1])}">Next student</button>` : ""}
        <button class="btn" data-dl>Download report</button>
      </div>
    </div>
    ${r.models?.mock ? `<div class="notice warn">Demo mode: these marks are fake.</div>` : ""}
    ${st.warnings?.length ? `<div class="notice warn">${st.warnings.map(esc).join("<br>")}</div>` : ""}
    ${overallBlock(r.overall)}
    ${r.questions.map((q) => questionBlock(q, exam, { answer: st.answers?.[q.question_id] ?? "" })).join("")}
    ${st.sheetText ? `<details class="sheettext"><summary>Full text read from the sheet</summary><pre>${esc(st.sheetText)}</pre></details>` : ""}`;
}

$("#report").addEventListener("click", (e) => {
  const nav = e.target.closest("[data-nav]");
  if (nav) return openReport(job.students[+nav.dataset.nav]);
  if (e.target.closest("[data-dl]")) download(`${safeName(selected.report.student_id)}_feedback.html`, standaloneHTML(selected.report, job.exam, selected.answers), "text/html");
});

async function zipAll() {
  if (!window.JSZip) { toast("Still loading. Try again in a moment.", "error"); return; }
  const zip = new window.JSZip(), used = new Set();
  zip.file("marksheet.csv", classCSV(csvRun()));
  for (const s of job.students.filter((x) => x.report)) {
    let base = safeName(s.report.student_id); while (used.has(base)) base += "_"; used.add(base);
    zip.file(`${base}.html`, standaloneHTML(s.report, job.exam, s.answers));
  }
  download("feedback_reports.zip", await zip.generateAsync({ type: "blob" }));
}

// ------------------------------------------------------------------ settings dialog
const dlg = $("#settings");
function openSettings() {
  $("#apiKey").value = settings.api_key; $("#apiKey").type = "password"; $("#showKey").textContent = "Show";
  $("#graderModel").value = settings.grader_model; $("#readingModel").value = settings.reading_model;
  $("#samples").value = settings.samples; $("#budget").value = settings.budget_usd; $("#mock").checked = settings.mock;
  $("#keyMsg").textContent = "";
  dlg.showModal();
  if (!settings.api_key) $("#apiKey").focus();
}
function readDialog() {
  return {
    api_key: $("#apiKey").value.trim(),
    grader_model: $("#graderModel").value.trim() || DEFAULTS.grader_model,
    reading_model: $("#readingModel").value.trim() || DEFAULTS.reading_model,
    samples: Math.min(5, Math.max(1, Math.round(+$("#samples").value || DEFAULTS.samples))),
    budget_usd: Math.max(0.1, +$("#budget").value || DEFAULTS.budget_usd),
    mock: $("#mock").checked,
  };
}
$("#openSettings").addEventListener("click", openSettings);
document.addEventListener("click", (e) => { if (e.target.closest("[data-open-settings]")) openSettings(); });
$("#showKey").addEventListener("click", () => {
  const i = $("#apiKey"); i.type = i.type === "password" ? "text" : "password";
  $("#showKey").textContent = i.type === "password" ? "Show" : "Hide";
});
$("#checkKey").addEventListener("click", async () => {
  const k = $("#apiKey").value.trim(), msg = $("#keyMsg");
  if (!k) { msg.textContent = "Paste a key first."; return; }
  msg.textContent = "Checking…";
  try {
    const d = await checkKey(k);
    const used = Number(d.usage || 0), limit = d.limit == null ? null : Number(d.limit);
    msg.textContent = `The key works. ${limit != null ? `${money(d.limit_remaining ?? limit - used)} of ${money(limit)} left.` : `Used ${money(used)} so far.`}`;
  } catch (e) { msg.textContent = `This key didn't work: ${e.message}`; }
});
dlg.addEventListener("close", () => {
  if (dlg.returnValue !== "save") return;
  saveSettings(readDialog());
  drawNotice(); clearError();
  toast("Settings saved.", "ok", 2000);
});

// ------------------------------------------------------------------ start
document.querySelectorAll(".slot").forEach(buildSlot);
document.querySelector(".seg").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-mode]"); if (!b || busy()) return;
  mode = b.dataset.mode; drawMode();
});
window.addEventListener("beforeunload", (e) => { if (busy()) { e.preventDefault(); e.returnValue = ""; } });
drawMode();
drawNotice();
