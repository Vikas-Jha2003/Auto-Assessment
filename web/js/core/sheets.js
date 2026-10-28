/**
 * @file Step 2 of the pipeline: work out who the students are and what each one answered.
 *
 * - `groupFiles` decides which uploaded files belong to the same student ("one file per student" mode).
 * - `detectStudents` finds where each student's sheet starts inside a file holding several students.
 * - `splitSheet` maps the text of one sheet onto the test's questions.
 */
import * as P from "./prompts.js";
import { quoteInText } from "./textmatch.js";

/**
 * @typedef {object} SplitSheet
 * @property {string} student_id                Name / roll number written on the sheet ("" if none).
 * @property {Record<string, string>} answers   Question id -> the student's verbatim answer ("" if not attempted).
 * @property {string[]} warnings
 * @property {boolean} different_test           The sheet seems to answer another question paper.
 */

// ------------------------------------------------------------------ one sheet

/**
 * Ask the model to split one student's sheet into answers per question.
 * @param {import("./llm.js").LLM} llm
 * @param {import("./exam.js").Exam} exam
 * @param {string} sheetText
 * @returns {Promise<SplitSheet>}
 */
export async function splitSheet(llm, exam, sheetText) {
  const questionList = exam.questions.map((q) => `- id "${q.id}": ${q.text.slice(0, 200)}`).join("\n");
  const reply = await llm.chatJSON(llm.s.fast_model, P.SPLIT_SYSTEM,
    `QUESTIONS:\n${questionList}\n\nANSWER SHEET:\n<<<\n${sheetText}\n>>>`, { task: "split_answers", maxTokens: 12000 });
  return alignSheet(exam, reply, sheetText);
}

/**
 * Align a model reply with the test's question ids, and warn if the extracted answers don't
 * appear word for word in the sheet (the model must copy, not rewrite).
 * @param {import("./exam.js").Exam} exam
 * @param {any} raw
 * @param {string} [sourceText]
 * @returns {SplitSheet}
 */
export function alignSheet(exam, raw, sourceText) {
  const byId = {};
  for (const a of raw?.answers || []) {
    if (a?.question_id != null) byId[String(a.question_id).trim().replace(/^Q\.?\s*/i, "").toLowerCase()] = String(a.answer || "");
  }
  const warnings = [];
  const answers = {};
  for (const q of exam.questions) {
    const answer = byId[q.id.toLowerCase()] || "";
    if (sourceText && answer) {
      const lines = answer.split("\n").filter((l) => l.trim().length > 15);
      const missing = lines.filter((l) => !quoteInText(l, sourceText, 0.85));
      if (lines.length && missing.length / lines.length > 0.3) {
        warnings.push(`Q${q.id}: the extracted answer may not match the sheet word for word (${missing.length}/${lines.length} lines not found).`);
      }
    }
    answers[q.id] = answer;
  }
  return {
    student_id: String(raw?.student_id || "").replace(/\s+/g, " ").trim(),
    answers, warnings, different_test: raw?.different_test === true,
  };
}

// ------------------------------------------------------------------ batches

const PAGE_SUFFIX = /^(.*?)[\s_\-.]*(?:p|pg|page)[\s_\-.]?(\d{1,3})$/i;

/**
 * Group uploaded files into students. Files whose names differ only by a page suffix
 * ("21CS042_p1.jpg", "21CS042_p2.jpg") become one student, with pages in order.
 * @template {{ name: string }} F
 * @param {F[]} files
 * @returns {{ label: string, files: F[] }[]}
 */
export function groupFiles(files) {
  const groups = new Map();
  for (const file of files) {
    const stem = file.name.replace(/\.[^.]+$/, "");
    const m = stem.match(PAGE_SUFFIX);
    const key = m && m[1] ? m[1] : stem;
    const page = m && m[1] ? Number(m[2]) : 0;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ file, page });
  }
  return [...groups].map(([label, items]) => ({
    label,
    files: items.sort((a, b) => a.page - b.page || a.file.name.localeCompare(b.file.name)).map((x) => x.file),
  }));
}

/**
 * Find where each student's sheet starts inside a file that holds several students.
 * @param {import("./llm.js").LLM} llm
 * @param {string[]} units Text of each page (or paragraph block, for Word/text files), in order.
 * @param {string} [fallbackLabel] Name to use when a sheet has no name on it.
 * @returns {Promise<{ label: string, units: string[], range: [number, number] }[]>}
 */
export async function detectStudents(llm, units, fallbackLabel = "Unlabelled pages") {
  if (units.length === 1) return [{ label: fallbackLabel, units, range: [1, 1] }];
  const text = units.map((u, i) => `=== UNIT ${i + 1} ===\n${u.slice(0, 1500)}`).join("\n\n");
  const reply = await llm.chatJSON(llm.s.fast_model, P.DETECT_STUDENTS_SYSTEM, text, { task: "detect_students", maxTokens: 3000 });

  const found = reply.students || [];
  const generic = (id) => !id || /^student\s*\d*$/i.test(String(id).trim());
  const starts = found
    .map((s, i) => ({
      label: generic(s.student_id) ? (found.length > 1 ? `${fallbackLabel} ${i + 1}` : fallbackLabel) : String(s.student_id),
      start: Math.min(Math.max(1, parseInt(s.start_unit, 10) || 1), units.length),
    }))
    .sort((a, b) => a.start - b.start)
    .filter((s, i, arr) => i === 0 || s.start !== arr[i - 1].start);
  if (!starts.length || starts[0].start !== 1) starts.unshift({ label: fallbackLabel, start: 1 });

  return starts.map((s, i) => {
    const end = (starts[i + 1]?.start ?? units.length + 1) - 1;
    return { label: s.label, units: units.slice(s.start - 1, end), range: [s.start, end] };
  });
}

/**
 * Break a Word or text document into paragraph blocks, so it can be split between students
 * the same way as PDF pages.
 * @param {string} text
 * @returns {string[]}
 */
export function textUnits(text) {
  const units = [];
  for (const para of text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)) {
    const startsSheet = /^(name|student|roll|नाम|பெயர்)\b/i.test(para);
    if (units.length && units[units.length - 1].length < 200 && !startsSheet) units[units.length - 1] += "\n\n" + para;
    else units.push(para);
  }
  return units;
}

/**
 * Tidy a name as written on a sheet: "Name: Ananya Rao   Roll No: 21CS042" -> "Ananya Rao (21CS042)".
 * Understands English, Hindi and Tamil labels.
 * @param {string} s
 * @returns {string}
 */
export function tidyName(s) {
  const t = String(s || "").replace(/\s+/g, " ")
    .replace(/^(name|student|नाम|பெயர்)\s*[:：-]\s*/iu, "").trim();
  const m = t.match(/^(.*?)[\s,;|-]*\(?\s*(?:roll(?:\s*no)?\.?|अनुक्रमांक|रोल\s*नं\.?|பதிவு\s*எண்|ரோல்\s*எண்)\s*[:#-]?\s*([\p{L}\p{N}/-]+)\)?$/iu);
  return m && m[1] ? `${m[1].trim()} (${m[2]})` : t;
}
