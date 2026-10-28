/**
 * @file The grading agent: runs a whole batch from uploaded files to finished reports.
 *
 *   test documents ──► 1. read + structure + check the test   (exam.js)
 *                         └─ stop here if the documents don't belong together
 *   answer sheets  ──► 2. find the students                    (sheets.js)
 *                      3. for each student, in parallel:
 *                         read sheet ► split into answers ► grade every question ► overall feedback
 *                                                                  (sheets.js, grader.js)
 *
 * The class holds all state of a run, so a run can be stopped and continued without repeating
 * finished work. It does not touch the page: it emits a "change" event and the UI redraws.
 * File reading is injected (`DocumentReader`), so the same pipeline runs in the browser and in Node.
 */
import { LLM, Usage, FatalApiError, isStopError } from "./llm.js";
import { buildExam, normaliseExam, structureWarnings } from "./exam.js";
import { splitSheet, groupFiles, detectStudents, textUnits, tidyName } from "./sheets.js";
import { gradeQuestion, overallFeedback, buildReport } from "./grader.js";

/** How many students are graded at the same time (each also grades its questions in parallel). */
const STUDENTS_AT_ONCE = 3;

/** Fixed grading parameters; user-facing settings are merged on top. */
export const PIPELINE_DEFAULTS = {
  grader_model: "anthropic/claude-sonnet-5.5",
  reading_model: "anthropic/claude-haiku-5.5",
  samples: 3,                    // independent grading passes per answer
  temperature: 0.4,              // for the passes, so they are genuinely independent
  disagreement_threshold: 0.2,   // passes differing by > 20% of the marks -> audit + lower confidence
  mark_step: 0.5,
  max_parallel: 4,               // concurrent API requests
  budget_usd: 3,
  feedback_language: "auto",
  mock: false,
};

/**
 * @typedef {object} DocumentReader  How to get text out of files (browser or Node implementation).
 * @property {(llm: LLM, files: any[], label: string, onPage?: Function) => Promise<string>} readFilesText
 * @property {(llm: LLM, file: any, label: string, onPage?: Function) => Promise<string[]>} readPages
 * @property {(file: any) => boolean} isPaged  True if the file's pages are natural units (PDF, image).
 *
 * @typedef {object} Student
 * @property {string} label           Name shown until the sheet's own name is known.
 * @property {string} source          Where the sheet came from, e.g. "section_A.pdf, pages 3–4".
 * @property {any[]} [files]          Files of this student (one-file-per-student mode).
 * @property {string[]} [pages]       Page texts (several-students-per-file mode).
 * @property {"waiting"|"working"|"done"|"error"} status
 * @property {string} [step]          What is happening now, for the progress display.
 * @property {string} [error]
 * @property {string} [sheetText]
 * @property {Record<string,string>} [answers]
 * @property {string[]} [warnings]
 * @property {boolean} [notThisTest]  The sheet answers a different question paper.
 * @property {import("./grader.js").StudentReport} [report]
 */

export class GradingRun extends EventTarget {
  /**
   * @param {object} options
   * @param {object} options.settings      User settings (merged over PIPELINE_DEFAULTS).
   * @param {{ qp: any[], rubric: any[], model: any[] }} options.testFiles
   * @param {any[]} options.sheetFiles
   * @param {"individual" | "class"} options.mode  One file per student, or several students per file.
   * @param {DocumentReader} options.reader
   * @param {{ exam: object, warnings: string[], checks: object[] }} [options.cachedTest]  Reuse a test read earlier.
   */
  constructor({ settings, testFiles, sheetFiles, mode, reader, cachedTest }) {
    super();
    this.settings = { ...PIPELINE_DEFAULTS, ...settings };
    this.testFiles = testFiles;
    this.sheetFiles = [...sheetFiles];
    this.mode = mode;
    this.reader = reader;

    /** @type {"idle"|"reading"|"review"|"grading"|"done"|"stopped"} */
    this.status = "idle";
    this.step = "";          // current activity, shown while reading
    this.message = "";       // why the run stopped
    this.exam = cachedTest?.exam || null;
    this.warnings = cachedTest?.warnings || [];
    this.checks = cachedTest?.checks || [];
    this.checksAccepted = false;
    /** @type {Student[]} */
    this.students = [];
    this.studentsFound = false;
    this.filesSplit = 0;     // progress through files in "class" mode, so Continue can resume
    this.usage = new Usage(this.settings.budget_usd);
    this.controller = null;
  }

  /**
   * A new run that grades the same answers again, skipping reading and splitting.
   * Used by the evaluation page to measure how consistent the grader is.
   * @param {GradingRun} previous A finished run.
   * @returns {GradingRun}
   */
  static regrade(previous) {
    const next = new GradingRun({
      settings: previous.settings, testFiles: previous.testFiles, sheetFiles: previous.sheetFiles,
      mode: previous.mode, reader: previous.reader,
      cachedTest: { exam: previous.exam, warnings: previous.warnings, checks: previous.checks },
    });
    next.checksAccepted = true;
    next.studentsFound = true;
    next.students = previous.students.filter((s) => s.answers).map((s) => ({
      label: s.label, source: s.source, status: "waiting", sheetText: s.sheetText, answers: s.answers,
      warnings: [...(s.warnings || [])], detectedId: s.detectedId, notThisTest: s.notThisTest,
    }));
    return next;
  }

  /** True while the run is working. */
  get busy() { return this.status === "reading" || this.status === "grading"; }

  /** Start the run, or continue it after Stop, an error, or the spending limit. */
  async start() {
    if (this.busy) return;
    this.controller = new AbortController();
    this.message = "";
    this.status = this.exam ? "grading" : "reading";
    this.#changed();
    const settings = { ...this.settings, fast_model: this.settings.reading_model, vision_model: this.settings.reading_model };
    try {
      const llm = new LLM(settings, { usage: this.usage, signal: this.controller.signal });
      if (!this.exam) await this.#readTest(llm);
      if (this.checks.some((c) => c.level === "error") && !this.checksAccepted) {
        this.status = "review";                         // don't spend money grading against the wrong documents
        return;
      }
      if (!this.studentsFound) await this.#findStudents(llm);
      await this.#gradeAll(llm);
      this.status = "done";
    } catch (e) {
      this.status = "stopped";
      this.message = e.name === "AbortError" ? "Stopped. Press Continue to carry on where it left off." : e.message || String(e);
      if (!isStopError(e)) console.error(e);
    } finally {
      for (const st of this.students) if (st.status === "working") { st.status = "waiting"; st.step = ""; }
      this.step = "";
      this.#changed();
    }
  }

  /** Stop after the requests already in flight. Finished work is kept. */
  stop() { this.controller?.abort(); }

  /** The teacher confirmed the documents are right despite the document check. */
  gradeAnyway() { this.checksAccepted = true; return this.start(); }

  /** Put sheets that failed back in the queue and continue. */
  retryFailed() {
    for (const st of this.students.filter((s) => s.status === "error")) {
      st.status = "waiting"; st.error = "";
      if (!st.answers) delete st.sheetText;
    }
    return this.start();
  }

  /** Change the spending limit (e.g. after it was reached). */
  setBudget(usd) { this.settings.budget_usd = usd; this.usage.budget = usd; }

  // ---------------------------------------------------------------- steps

  /** Step 1: read the test documents, structure them, and check that they belong together. */
  async #readTest(llm) {
    const { qp, rubric, model } = this.testFiles;
    const onPage = (what) => (i, n, how) => this.#setStep(`${how === "transcribing" ? "Reading the handwriting in" : "Reading"} ${what}, page ${i} of ${n}`);
    this.#setStep("Reading the question paper and rubric");
    const qpText = await this.reader.readFilesText(llm, qp, "question paper", onPage("the question paper"));
    const rubricText = await this.reader.readFilesText(llm, rubric, "rubric", onPage("the rubric"));
    const modelText = model.length ? await this.reader.readFilesText(llm, model, "model answers", onPage("the model answers")) : "";
    this.#setStep("Turning the rubric into marking criteria");
    const exam = await buildExam(llm, qpText, rubricText, modelText);
    if (!exam.questions.length) {
      throw new FatalApiError("No questions were found in the question paper. Check that the right file was uploaded.");
    }
    this.warnings = structureWarnings(exam);
    this.checks = exam.checks;
    this.exam = normaliseExam(exam);
  }

  /** Step 2: decide which pages belong to which student. */
  async #findStudents(llm) {
    if (this.mode === "individual") {
      this.students = groupFiles(this.sheetFiles).map((g) => ({
        label: g.label, files: g.files, source: g.files.map((f) => f.name).join(", "), status: "waiting",
      }));
    } else {
      // Several students per file. Each file is split on its own, so a sheet never spans two files.
      const n = this.sheetFiles.length;
      for (; this.filesSplit < n; this.filesSplit++) {
        const file = this.sheetFiles[this.filesSplit];
        const of = n > 1 ? ` (file ${this.filesSplit + 1} of ${n})` : "";
        const pages = await this.reader.readPages(llm, file, "class answer sheets", (i, t, how) =>
          this.#setStep(`${how === "transcribing" ? "Reading the handwriting in" : "Reading"} ${file.name}, page ${i} of ${t}${of}`));
        const paged = this.reader.isPaged(file);
        const units = paged ? pages : textUnits(pages.join("\n\n"));
        if (!units.join("").trim()) continue;
        this.#setStep(`Finding each student in ${file.name}${of}`);
        const parts = await detectStudents(llm, units, file.name.replace(/\.[^.]+$/, ""));
        const unit = paged ? "pages" : "parts";
        this.students.push(...parts.map((p) => ({
          label: tidyName(p.label), pages: p.units, status: "waiting",
          source: units.length === 1 ? file.name : `${file.name}, ${unit} ${p.range[0]}${p.range[1] > p.range[0] ? `–${p.range[1]}` : ""}`,
        })));
        this.#changed();
      }
      if (!this.students.length) throw new FatalApiError("No answer sheets with any text were found in the uploaded files.");
    }
    this.studentsFound = true;
  }

  /** Step 3: grade every waiting student, a few at a time. */
  async #gradeAll(llm) {
    this.status = "grading";
    this.step = "";
    this.#changed();
    const queue = this.students.filter((s) => s.status === "waiting");
    let stopReason = null;
    const worker = async () => {
      while (queue.length && !stopReason) {
        const st = queue.shift();
        try {
          await this.#gradeStudent(llm, st);
          st.status = "done";
        } catch (e) {
          if (isStopError(e)) { stopReason ||= e; st.status = "waiting"; this.controller.abort(); }
          else { st.status = "error"; st.error = e.message || String(e); console.error(e); }
        }
        st.step = "";
        this.#changed();
      }
    };
    await Promise.all(Array.from({ length: STUDENTS_AT_ONCE }, worker));
    if (stopReason) throw stopReason;
  }

  /** Read, split and grade one student's sheet. Questions already graded are kept on Continue. */
  async #gradeStudent(llm, st) {
    const exam = this.exam;
    // requests already in flight keep finishing after Stop; they must not mark the sheet busy again
    const show = (step) => { if (!llm.signal?.aborted) { st.status = "working"; st.step = step; this.#changed(); } };

    if (!st.answers) {
      if (st.sheetText == null) {
        show("Reading the sheet");
        st.sheetText = st.files
          ? await this.reader.readFilesText(llm, st.files, "answer sheet",
              (i, n, how) => show(`${how === "transcribing" ? "Reading handwriting" : "Reading"}, page ${i} of ${n}`))
          : st.pages.join("\n\n");
      }
      show("Matching answers to questions");
      const split = await splitSheet(llm, exam, st.sheetText);
      st.answers = split.answers;
      st.warnings = split.warnings;
      st.detectedId = split.student_id;
      const words = (st.sheetText.match(/\S+/g) || []).length;
      if (split.different_test || (words > 25 && Object.values(st.answers).every((a) => !a.trim()))) {
        for (const id of Object.keys(st.answers)) st.answers[id] = "";
        st.notThisTest = true;
        st.warnings.push("No answers to this question paper were found on this sheet. Check that it belongs to this test.");
      }
    }

    st.partial ||= {};
    const total = exam.questions.length;
    let done = Object.keys(st.partial).length;
    show(`Grading question ${Math.min(done + 1, total)} of ${total}`);
    await Promise.all(exam.questions.filter((q) => !st.partial[q.id]).map(async (q) => {
      st.partial[q.id] = await gradeQuestion(llm, exam, q, st.answers[q.id] || "");
      done += 1;
      show(done < total ? `Grading question ${done + 1} of ${total}` : "Writing overall feedback");
    }));

    const results = exam.questions.map((q) => st.partial[q.id]);
    let overall = null;
    try { overall = await overallFeedback(llm, exam, results); }
    catch (e) { if (isStopError(e)) throw e; }          // overall feedback is optional; marks are not

    const named = st.detectedId && !/^(student|unknown|n\/?a|none)?$/i.test(st.detectedId);
    st.report = buildReport(exam, named ? tidyName(st.detectedId) : st.label, results, overall, {
      models: { grader: this.settings.grader_model, reader: this.settings.reading_model,
                samples: this.settings.samples, language: this.settings.feedback_language, mock: !!this.settings.mock },
    });
    delete st.partial;
  }

  #setStep(step) { this.step = step; this.#changed(); }
  #changed() { this.dispatchEvent(new Event("change")); }
}
