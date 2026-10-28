/**
 * @file Step 3 of the pipeline: grade one answer, then write overall feedback for a student.
 *
 * How one answer is graded (`gradeQuestion`):
 * 1. The grading model judges every rubric criterion, several times independently.
 * 2. The marks for each criterion are combined by taking the median.
 * 3. Code checks the result: every awarded mark needs a quote that really appears in the answer,
 *    every lost mark needs improvement advice, and the advice must not be vague.
 * 4. If a check fails, or the independent passes disagree, an audit prompt repairs the result.
 * 5. A confidence level records how much the teacher should trust the mark.
 */
import * as P from "./prompts.js";
import { quoteInText } from "./textmatch.js";
import { isStopError } from "./llm.js";
import { feedbackLanguageInstruction } from "./languages.js";
import { examTotal } from "./exam.js";

/**
 * @typedef {object} CriterionResult
 * @property {string} criterion_id
 * @property {"met" | "partially_met" | "not_met"} status
 * @property {number} marks_awarded
 * @property {number} marks_available
 * @property {string[]} evidence             Quotes from the student's answer.
 * @property {string} justification
 * @property {boolean | null} evidence_verified  Set by `checkResult`: were the quotes found in the answer?
 *
 * @typedef {{ criterion_id: string, issue: string, how_to_fix: string, example: string }} Improvement
 *
 * @typedef {object} QuestionResult
 * @property {string} question_id
 * @property {number} marks_awarded
 * @property {number} max_marks
 * @property {CriterionResult[]} criteria
 * @property {string[]} strengths
 * @property {Improvement[]} improvements
 * @property {string[]} misconceptions
 * @property {string} summary
 * @property {"high" | "medium" | "low"} confidence
 * @property {number[]} sample_totals        Total from each independent pass.
 * @property {string[]} flags                Notes from the checks and the audit.
 *
 * @typedef {{ summary: string, top_priorities: string[], study_plan: string[] }} OverallFeedback
 */

const fmt = (n) => String(+(+n).toFixed(2));
const roundTo = (x, step) => (step > 0 ? +(Math.round(x / step) * step).toFixed(2) : +x.toFixed(2));
const median = (values) => {
  const s = [...values].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const statusFor = (marks, max) => (marks >= max - 1e-9 ? "met" : marks <= 1e-9 ? "not_met" : "partially_met");
const totalOf = (result) => +result.criteria.reduce((a, c) => a + c.marks_awarded, 0).toFixed(2);

/** The user message for grading one answer. */
export function graderUserPrompt(exam, q, answer) {
  const note = q.model_answer_note
    ? `\n[Note from the document check: ${q.model_answer_note} Where the model answer is wrong, grade by the rubric and correct subject knowledge.]`
    : "";
  return P.graderUser({
    instructions: (exam.instructions || "").trim(),
    qid: q.id,
    maxMarks: fmt(q.max_marks),
    question: q.text,
    rubric: q.rubric.map((c) => `- [${c.id}] (${fmt(c.marks)} marks) ${c.description}`).join("\n"),
    modelAnswer: (q.model_answer || "(not provided)") + note,
    answer: answer?.trim() ? answer.trim() : "[NO ANSWER - question not attempted]",
  });
}

/**
 * Turn a raw model reply into a result with exactly one entry per rubric criterion, marks
 * clamped to the criterion's range and rounded to the mark step.
 * @param {any} raw
 * @param {import("./exam.js").Question} q
 * @param {number} step
 * @returns {Omit<QuestionResult, "question_id"|"marks_awarded"|"max_marks"|"confidence"|"sample_totals"|"flags"> & { missing: string[] }}
 */
export function coerceResult(raw, q, step) {
  const byId = {};
  for (const c of raw?.criteria || []) if (c && c.criterion_id != null) byId[String(c.criterion_id).trim().toLowerCase()] = c;
  const missing = [];
  const criteria = q.rubric.map((crit) => {
    const c = byId[crit.id.toLowerCase()];
    if (!c) {
      missing.push(crit.id);
      return { criterion_id: crit.id, status: "not_met", marks_awarded: 0, marks_available: crit.marks, evidence: [],
               justification: "The grader did not return a decision for this criterion.", evidence_verified: null };
    }
    const marks = Math.min(Math.max(roundTo(Number(c.marks_awarded) || 0, step), 0), crit.marks);
    const evidence = (typeof c.evidence === "string" ? [c.evidence] : c.evidence || [])
      .map((e) => String(e).trim().replace(/^"|"$/g, "")).filter(Boolean);
    return { criterion_id: crit.id, status: statusFor(marks, crit.marks), marks_awarded: marks, marks_available: crit.marks,
             evidence, justification: String(c.justification || "").trim(), evidence_verified: null };
  });
  const strings = (a) => (Array.isArray(a) ? a.map(String) : []);
  const improvements = (raw?.improvements || []).filter((i) => i && typeof i === "object").map((i) => ({
    criterion_id: String(i.criterion_id || ""), issue: String(i.issue || ""),
    how_to_fix: String(i.how_to_fix || ""), example: String(i.example || ""),
  }));
  return { criteria, strengths: strings(raw?.strengths), improvements, misconceptions: strings(raw?.misconceptions),
           summary: String(raw?.summary || ""), missing };
}

/**
 * Combine independent passes: the median mark for each criterion, with the wording of the pass
 * closest to that median.
 */
export function combinePasses(passes, q, step) {
  if (passes.length === 1) return passes[0];
  const criteria = q.rubric.map((crit, i) => {
    const med = roundTo(median(passes.map((p) => p.criteria[i].marks_awarded)), step);
    const closest = passes.reduce((best, p) =>
      Math.abs(p.criteria[i].marks_awarded - med) < Math.abs(best.criteria[i].marks_awarded - med) ? p : best);
    const c = structuredClone(closest.criteria[i]);
    if (Math.abs(c.marks_awarded - med) > 1e-9) { c.marks_awarded = med; c.status = statusFor(med, crit.marks); }
    return c;
  });
  const target = criteria.reduce((a, c) => a + c.marks_awarded, 0);
  const representative = passes.reduce((best, p) => (Math.abs(totalOf(p) - target) < Math.abs(totalOf(best) - target) ? p : best));
  return { ...representative, criteria, missing: [...new Set(passes.flatMap((p) => p.missing))].sort() };
}

/**
 * The automatic checks that make a mark defensible. Also records, on each criterion, whether its
 * evidence was found in the answer.
 * @returns {string[]} Problems found ([] if none).
 */
export function checkResult(result, answer) {
  const problems = [];
  if (result.missing?.length) problems.push(`No decision returned for criteria ${JSON.stringify(result.missing)}.`);
  for (const c of result.criteria) {
    const found = c.evidence.filter((e) => quoteInText(e, answer));
    c.evidence_verified = c.evidence.length ? found.length > 0 : null;
    if (c.marks_awarded > 0 && !found.length) {
      problems.push(`Criterion ${c.criterion_id} awards ${fmt(c.marks_awarded)} marks but none of its evidence quotes appear verbatim in the student answer: ${JSON.stringify(c.evidence)}`);
    } else if (c.evidence.length && found.length < c.evidence.length) {
      problems.push(`Criterion ${c.criterion_id} has quotes not found in the answer: ${JSON.stringify(c.evidence.filter((e) => !found.includes(e)))}`);
    }
  }
  const advised = new Set(result.improvements.map((i) => i.criterion_id.toLowerCase()));
  for (const c of result.criteria) {
    if (c.marks_awarded < c.marks_available - 1e-9 && !advised.has(c.criterion_id.toLowerCase())) {
      problems.push(`Criterion ${c.criterion_id} lost marks but has no improvement item (issue / how_to_fix / example).`);
    }
  }
  for (const i of result.improvements) {
    // fewer than ~5 words of advice is too vague to act on (characters for scripts without spaces)
    const tooShort = i.how_to_fix.trim().split(/\s+/).length < 5 && [...i.how_to_fix.trim()].length < 25;
    if (tooShort) problems.push(`Improvement for ${i.criterion_id} is too vague: '${i.how_to_fix}'.`);
  }
  return problems;
}

/** The parts of a result the audit prompt needs to see. */
const forAudit = (r) => ({
  criteria: r.criteria.map(({ evidence_verified: _ignored, ...c }) => c),   // the model never sees our check result
  strengths: r.strengths, improvements: r.improvements, misconceptions: r.misconceptions, summary: r.summary,
});

/**
 * Grade one answer.
 * @param {import("./llm.js").LLM} llm  Uses settings `grader_model`, `samples`, `temperature`,
 *   `mark_step`, `disagreement_threshold` and `feedback_language`.
 * @param {import("./exam.js").Exam} exam
 * @param {import("./exam.js").Question} q
 * @param {string} answer The student's answer ("" if not attempted).
 * @returns {Promise<QuestionResult>}
 */
export async function gradeQuestion(llm, exam, q, answer = "") {
  const s = llm.s;
  const user = graderUserPrompt(exam, q, answer);
  const system = P.graderSystem(fmt(s.mark_step), feedbackLanguageInstruction(s.feedback_language));
  const passes = answer.trim() ? s.samples : 1;           // a blank answer needs only one pass

  const replies = await Promise.all(Array.from({ length: passes }, () =>
    llm.chatJSON(s.grader_model, system, user, { task: "grade", temperature: passes > 1 ? s.temperature : 0 })));
  const results = replies.map((r) => coerceResult(r, q, s.mark_step));
  const totals = results.map(totalOf);
  let result = combinePasses(results, q, s.mark_step);
  const disagreement = Math.max(...totals) - Math.min(...totals) > s.disagreement_threshold * q.max_marks;

  let problems = checkResult(result, answer);
  if (disagreement) {
    problems.push(`Independent grading passes disagreed: totals ${JSON.stringify(totals)} out of ${fmt(q.max_marks)}. ` +
      "Re-examine borderline criteria carefully and settle on the defensible mark.");
  }

  const flags = [];
  if (problems.length) {
    const auditUser = `${user}\n\nDRAFT GRADING:\n${JSON.stringify(forAudit(result), null, 1)}\n\n` +
      `PROBLEMS FOUND BY THE CHECKER:\n- ${problems.join("\n- ")}`;
    try {
      const audited = coerceResult(
        await llm.chatJSON(s.grader_model, P.auditSystem(system), auditUser, { task: "audit", temperature: 0 }), q, s.mark_step);
      const remaining = checkResult(audited, answer);
      const before = problems.filter((p) => !p.startsWith("Independent")).length;
      if (remaining.length <= before) { result = audited; problems = remaining; }
      else checkResult(result, answer);                  // keep the original; refresh its evidence flags
      flags.push("audited");
    } catch (e) {
      if (isStopError(e)) throw e;
      flags.push(`audit failed: ${e.message}`);
    }
    flags.push(...problems.map((p) => `check: ${p}`));
  }

  const confidence = disagreement && problems.length ? "low" : disagreement || problems.length ? "medium" : "high";
  return {
    question_id: q.id, marks_awarded: totalOf(result), max_marks: q.max_marks,
    criteria: result.criteria, strengths: result.strengths, improvements: result.improvements,
    misconceptions: result.misconceptions, summary: result.summary,
    confidence, sample_totals: totals, flags,
  };
}

/**
 * Overall feedback for one student: summary, top priorities and a study plan.
 * @param {import("./llm.js").LLM} llm
 * @param {import("./exam.js").Exam} exam
 * @param {QuestionResult[]} results
 * @returns {Promise<OverallFeedback>}
 */
export async function overallFeedback(llm, exam, results) {
  const lines = results.map((r) => {
    const q = exam.questions.find((x) => x.id === r.question_id);
    return `Q${r.question_id} (${fmt(r.marks_awarded)}/${fmt(r.max_marks)}) - ${q.text.slice(0, 150)}\n` +
      `  summary: ${r.summary}\n  gaps: ${JSON.stringify(r.improvements.map((i) => i.issue))}\n` +
      `  misconceptions: ${JSON.stringify(r.misconceptions)}`;
  });
  const total = results.reduce((a, r) => a + r.marks_awarded, 0);
  const language = llm.s.feedback_language && llm.s.feedback_language !== "auto"
    ? llm.s.feedback_language : "the same language as the per-question summaries below";
  const d = await llm.chatJSON(llm.s.grader_model, P.overallSystem(language),
    `EXAM: ${exam.title}\nTOTAL: ${fmt(total)}/${fmt(examTotal(exam))}\n\n${lines.join("\n\n")}`, { task: "overall" });
  return {
    summary: String(d.summary || ""),
    top_priorities: (d.top_priorities || []).map(String),
    study_plan: (d.study_plan || []).map(String),
  };
}

/**
 * @typedef {object} StudentReport
 * @property {string} exam_title
 * @property {string} student_id
 * @property {number} total_awarded
 * @property {number} total_marks
 * @property {number} percentage
 * @property {QuestionResult[]} questions
 * @property {OverallFeedback | null} overall
 * @property {object} [models]  Which models and settings produced the report.
 */

/** Assemble a student's report. @returns {StudentReport} */
export function buildReport(exam, studentId, questions, overall, extra = {}) {
  const total = +questions.reduce((a, r) => a + r.marks_awarded, 0).toFixed(2);
  const max = examTotal(exam);
  return { exam_title: exam.title, student_id: studentId, total_awarded: total, total_marks: max,
           percentage: max ? +(100 * total / max).toFixed(1) : 0, questions, overall, ...extra };
}
