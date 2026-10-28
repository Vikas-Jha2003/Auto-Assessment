/**
 * @file Step 1 of the pipeline: turn the test documents into a structured test.
 *
 * The question paper, rubric and model answers arrive as plain text. A language model converts them
 * into questions with independent marking criteria, and at the same time checks that the
 * documents belong together. The code here validates and normalises what the model returns,
 * because grading relies on the criteria adding up to each question's marks.
 */
import * as P from "./prompts.js";

/**
 * @typedef {object} Criterion
 * @property {string} id           e.g. "2.1"
 * @property {string} description  What the student must show.
 * @property {number} marks
 *
 * @typedef {object} Question
 * @property {string} id
 * @property {string} text
 * @property {number} max_marks
 * @property {Criterion[]} rubric
 * @property {string} model_answer
 * @property {string} [model_answer_note]  Set when the document check found a problem with the model answer.
 *
 * @typedef {object} DocumentCheck
 * @property {"error" | "warning"} level  "error" stops grading until the teacher confirms.
 * @property {string} about               "question_paper" | "rubric" | "model_answers"
 * @property {string | null} question_id
 * @property {string} message             Written for the teacher.
 *
 * @typedef {object} Exam
 * @property {string} title
 * @property {string} instructions        General marking instructions.
 * @property {Question[]} questions
 * @property {DocumentCheck[]} checks
 */

const fmt = (n) => String(+(+n).toFixed(2));

/**
 * Ask the model to structure and check the test documents.
 * @param {import("./llm.js").LLM} llm
 * @param {string} questionPaper
 * @param {string} rubric
 * @param {string} modelAnswers
 * @returns {Promise<Exam>}
 */
export async function buildExam(llm, questionPaper, rubric, modelAnswers) {
  const user =
    `QUESTION PAPER:\n${questionPaper.trim()}\n\n` +
    `RUBRIC / MARKING SCHEME:\n${rubric.trim() || "(none provided)"}\n\n` +
    `MODEL ANSWERS:\n${modelAnswers.trim() || "(none provided)"}`;
  const reply = await llm.chatJSON(llm.s.fast_model, P.STRUCTURE_SYSTEM, user, { task: "structure_exam", maxTokens: 12000 });
  return cleanExam(reply);
}

/**
 * Coerce a model reply into a well-typed `Exam`, and attach model-answer problems to their
 * question so the grader is warned about them.
 * @param {any} raw
 * @returns {Exam}
 */
export function cleanExam(raw) {
  const questions = (raw?.questions || []).map((q, i) => ({
    id: String(q.id ?? i + 1).trim().replace(/^Q\.?\s*/i, ""),
    text: String(q.text || ""),
    max_marks: Number(q.max_marks) || 0,
    rubric: (q.rubric || []).map((c, j) => ({
      id: String(c.id ?? `${q.id}.${j + 1}`), description: String(c.description || ""), marks: Number(c.marks) || 0,
    })),
    model_answer: String(q.model_answer || ""),
  }));

  const checks = (Array.isArray(raw?.checks) ? raw.checks : [])
    .filter((c) => c && String(c.message || "").trim())
    .map((c) => ({
      level: c.level === "error" ? "error" : "warning",
      about: String(c.about || ""),
      question_id: c.question_id == null || c.question_id === "" ? null : String(c.question_id).replace(/^Q\.?\s*/i, ""),
      message: String(c.message).trim(),
    }));

  for (const c of checks) {
    const q = c.question_id && questions.find((x) => x.id.toLowerCase() === c.question_id.toLowerCase());
    if (q && c.about === "model_answers") q.model_answer_note = [q.model_answer_note, c.message].filter(Boolean).join(" ");
  }
  return { title: String(raw?.title || "Untitled test"), instructions: String(raw?.instructions || ""), questions, checks };
}

/**
 * Problems in the structure itself (as opposed to the content checks the model reports).
 * @param {Exam} exam
 * @returns {string[]} Messages for the teacher.
 */
export function structureWarnings(exam) {
  const warnings = [];
  for (const q of exam.questions) {
    if (!q.rubric.length) warnings.push(`Q${q.id} has no rubric points; it is graded against the model answer as a whole.`);
    const sum = q.rubric.reduce((a, c) => a + c.marks, 0);
    if (q.rubric.length && Math.abs(sum - q.max_marks) > 1e-6) {
      warnings.push(`Q${q.id}: the rubric points add up to ${fmt(sum)}, but the question is worth ${fmt(q.max_marks)}. The points were scaled to fit.`);
    }
  }
  return warnings;
}

/**
 * Make a test safe to grade: every question has criteria, and they add up to its marks.
 * Returns a copy; the input is not changed.
 * @param {Exam} exam
 * @returns {Exam}
 */
export function normaliseExam(exam) {
  const copy = structuredClone(exam);
  for (const q of copy.questions) {
    if (!q.rubric.length) {
      q.rubric = [{ id: `${q.id}.1`, description: "The answer covers the key points of the model answer", marks: q.max_marks }];
    }
    const sum = q.rubric.reduce((a, c) => a + c.marks, 0);
    if (sum > 0 && Math.abs(sum - q.max_marks) > 1e-6) {
      // scale proportionally; the last criterion absorbs rounding so the total is exact
      let used = 0;
      q.rubric.forEach((c, i) => {
        c.marks = i === q.rubric.length - 1 ? +(q.max_marks - used).toFixed(2) : +(c.marks * q.max_marks / sum).toFixed(2);
        used += c.marks;
      });
    }
  }
  return copy;
}

/** Total marks of a test. */
export const examTotal = (exam) => +exam.questions.reduce((a, q) => a + Number(q.max_marks), 0).toFixed(2);
