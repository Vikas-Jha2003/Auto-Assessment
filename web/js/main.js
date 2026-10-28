/**
 * @file Entry point of the grading page: connects the upload form, settings and results to the
 * grading pipeline.
 *
 * Module map:
 *   core/     the grading agent, independent of the page (exam, sheets, grader, pipeline, llm, prompts)
 *   browser/  reading uploaded files in the browser
 *   ui/       everything the teacher sees
 */
import { GradingRun } from "./core/pipeline.js";
import { browserReader } from "./browser/ingest.js";
import { $, toast } from "./ui/dom.js";
import { getSettings, onSettingsChange, openSettings, initSettingsDialog } from "./ui/settings.js";
import { files, getMode, initUploads, clearSheets, testKey } from "./ui/uploads.js";
import { showRun, initResults } from "./ui/results.js";
import { initLanguagePicker, drawNotice, lockForm, formProblem } from "./ui/common.js";

/** @type {GradingRun | null} */
let run = null;
/** The last test that was read, so the next batch with the same documents skips that step. */
let testCache = null;

const isBusy = () => !!run?.busy;

$("#form").addEventListener("submit", (e) => {
  e.preventDefault();
  if (isBusy()) return;
  const problem = formProblem(files);
  $("#formError").textContent = problem;
  if (problem) {
    if (problem.includes("API key")) openSettings();
    return;
  }
  startRun();
});

/** Start grading the uploaded sheets. */
function startRun() {
  const key = testKey();
  run = new GradingRun({
    settings: getSettings(),
    testFiles: { qp: files.qp, rubric: files.rubric, model: files.model },
    sheetFiles: files.sheets,
    mode: getMode(),
    reader: browserReader,
    cachedTest: testCache?.key === key ? testCache : null,
  });
  run.addEventListener("change", () => {
    lockForm($("#form"), run.busy);
    if (run.exam && testCache?.key !== key) testCache = { key, exam: run.exam, warnings: run.warnings, checks: run.checks };
  });
  showRun(run);
  $("#run").scrollIntoView({ behavior: "smooth", block: "start" });
  run.start();
}

// ------------------------------------------------------------------ start-up

initSettingsDialog();
onSettingsChange(() => { drawNotice(); $("#formError").textContent = ""; });
initUploads(isBusy);
initLanguagePicker();
initResults({
  onNewBatch: () => {
    clearSheets();
    run = null;
    showRun(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
    toast("The test files are kept. Add the next answer sheets.", "ok");
  },
  beforeResume: (r) => r.setBudget(getSettings().budget_usd),
});
window.addEventListener("beforeunload", (e) => { if (isBusy()) { e.preventDefault(); e.returnValue = ""; } });
drawNotice();
