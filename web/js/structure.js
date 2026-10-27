// Build the structured exam and per-question answers from raw text; group / split class batches.
import * as P from "./prompts.js";
import { quoteInText } from "./textmatch.js";

const fmt = (n) => String(+(+n).toFixed(2));

// ------------------------------------------------------------------ exam
export function cleanExam(raw) {
  const qs = (raw?.questions || []).map((q, i) => ({
    id: String(q.id ?? i + 1).trim(),
    text: String(q.text || ""),
    max_marks: Number(q.max_marks) || 0,
    rubric: (q.rubric || []).map((c, j) => ({ id: String(c.id ?? `${q.id}.${j + 1}`), description: String(c.description || ""), marks: Number(c.marks) || 0 })),
    model_answer: String(q.model_answer || ""),
  }));
  const checks = (Array.isArray(raw?.checks) ? raw.checks : [])
    .filter((c) => c && String(c.message || "").trim())
    .map((c) => ({ level: c.level === "error" ? "error" : "warning", about: String(c.about || ""),
                   question_id: c.question_id == null || c.question_id === "" ? null : String(c.question_id).replace(/^Q/i, ""),
                   message: String(c.message).trim() }));
  for (const c of checks) {
    const q = c.question_id && qs.find((x) => x.id.toLowerCase() === c.question_id.toLowerCase());
    if (q && c.about === "model_answers") q.model_answer_note = (q.model_answer_note ? q.model_answer_note + " " : "") + c.message;
  }
  return { title: String(raw?.title || "Untitled test"), instructions: String(raw?.instructions || ""), questions: qs, checks };
}

/** Problems a teacher should see in the test editor. */
export function validateExam(exam) {
  const issues = [];
  if (!exam.questions.length) issues.push({ level: "error", msg: "The test has no questions." });
  const seen = new Set();
  for (const q of exam.questions) {
    if (!q.id) issues.push({ level: "error", msg: "A question has no number." });
    if (seen.has(q.id.toLowerCase())) issues.push({ level: "error", q: q.id, msg: `Question number ${q.id} is used twice.` });
    seen.add(q.id.toLowerCase());
    if (!(q.max_marks > 0)) issues.push({ level: "error", q: q.id, msg: `Q${q.id} needs maximum marks above 0.` });
    if (!q.rubric.length) issues.push({ level: "warn", q: q.id, msg: `Q${q.id} has no rubric criteria; one criterion will be made from the model answer.` });
    const sum = +q.rubric.reduce((a, c) => a + c.marks, 0).toFixed(2);
    if (q.rubric.length && Math.abs(sum - q.max_marks) > 1e-6)
      issues.push({ level: "warn", q: q.id, msg: `Q${q.id}: criteria add up to ${fmt(sum)}, but the question is worth ${fmt(q.max_marks)}.`, fix: "rescale" });
    if (!q.model_answer.trim()) issues.push({ level: "info", q: q.id, msg: `Q${q.id} has no model answer. Grading still works but is less reliable.` });
  }
  return issues;
}

export function rescaleQuestion(q) {
  const sum = q.rubric.reduce((a, c) => a + c.marks, 0);
  if (!sum) return;
  let acc = 0;
  q.rubric.forEach((c, i) => {
    if (i === q.rubric.length - 1) c.marks = +(q.max_marks - acc).toFixed(2);
    else { c.marks = +(c.marks * q.max_marks / sum).toFixed(2); acc += c.marks; }
  });
}

/** Make the exam safe to grade: rubric present and adding up to max marks. */
export function normaliseExam(exam) {
  const e = structuredClone(exam);
  for (const q of e.questions) {
    if (!q.rubric.length) q.rubric = [{ id: `${q.id}.1`, description: "Answer matches the key points of the model answer", marks: q.max_marks }];
    const sum = q.rubric.reduce((a, c) => a + c.marks, 0);
    if (Math.abs(sum - q.max_marks) > 1e-6) rescaleQuestion(q);
  }
  return e;
}

export async function buildExam(llm, qp, rubric, modelAnswers) {
  const user = `QUESTION PAPER:\n${qp.trim()}\n\nRUBRIC / MARKING SCHEME:\n${rubric.trim() || "(none provided)"}\n\nMODEL ANSWERS:\n${modelAnswers.trim() || "(none provided)"}`;
  const d = await llm.chatJSON(llm.s.fast_model, P.STRUCTURE_SYSTEM, user, { task: "structure_exam", maxTokens: 12000 });
  return cleanExam(d);
}

// --------------------------------------------------------- answer sheet
export async function splitSheet(llm, exam, sheetText) {
  const qlist = exam.questions.map((q) => `- id "${q.id}": ${q.text.slice(0, 200)}`).join("\n");
  const d = await llm.chatJSON(llm.s.fast_model, P.SPLIT_SYSTEM,
    `QUESTIONS:\n${qlist}\n\nANSWER SHEET:\n<<<\n${sheetText}\n>>>`, { task: "split_answers", maxTokens: 12000 });
  return alignSheet(exam, d, sheetText);
}

export function alignSheet(exam, raw, sourceText) {
  const warnings = [];
  const map = {};
  for (const a of raw?.answers || []) if (a?.question_id != null) map[String(a.question_id).trim().toLowerCase()] = String(a.answer || "");
  const answers = {};
  for (const q of exam.questions) {
    const ans = map[q.id.toLowerCase()] || "";
    if (sourceText && ans) {
      const lines = ans.split("\n").filter((l) => l.trim().length > 15);
      const missing = lines.filter((l) => !quoteInText(l, sourceText, 0.85));
      if (lines.length && missing.length / lines.length > 0.3)
        warnings.push(`Q${q.id}: the extracted answer may not match the sheet word for word (${missing.length}/${lines.length} lines not found).`);
    }
    answers[q.id] = ans;
  }
  const known = new Set(exam.questions.map((q) => q.id.toLowerCase()));
  const extra = (raw?.answers || []).filter((a) => !known.has(String(a.question_id).toLowerCase()) && String(a.answer || "").trim()).map((a) => a.question_id);
  if (extra.length) warnings.push(`Answers found for unknown question numbers ${extra.join(", ")}; they were not graded.`);
  return { student_id: String(raw?.student_id || "").replace(/\s+/g, " ").trim(), answers, warnings, different_test: raw?.different_test === true };
}

// ------------------------------------------------------- batch handling
const PAGE_RE = /^(.*?)[\s_\-.]*(?:p|pg|page)[\s_\-.]?(\d{1,3})$/i;

/** Group files into students. With byPrefix, "21CS042_p1.jpg" + "21CS042_p2.jpg" become one student. */
export function groupFiles(files, byPrefix) {
  const groups = new Map();
  for (const f of files) {
    const stem = f.name.replace(/\.[^.]+$/, "");
    let key = stem, page = 0;
    if (byPrefix) { const m = stem.match(PAGE_RE); if (m && m[1]) { key = m[1]; page = Number(m[2]); } }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ file: f, page });
  }
  return [...groups.entries()].map(([key, items]) => ({
    label: key, files: items.sort((a, b) => a.page - b.page || a.file.name.localeCompare(b.file.name)).map((x) => x.file),
  }));
}

/** Ask the model where each student's sheet starts inside one combined document. */
export async function detectStudents(llm, units, fallbackLabel = "Unlabelled pages") {
  if (units.length === 1) return [{ label: fallbackLabel, units, range: [1, 1] }]; // one page can only be one student
  const text = units.map((u, i) => `=== UNIT ${i + 1} ===\n${u.slice(0, 1500)}`).join("\n\n");
  const d = await llm.chatJSON(llm.s.fast_model, P.DETECT_STUDENTS_SYSTEM, text, { task: "detect_students", maxTokens: 3000 });
  const starts = (d.students || [])
    .map((s, i, arr) => ({ id: !s.student_id || /^student\s*\d*$/i.test(String(s.student_id).trim()) ? (arr.length > 1 ? `${fallbackLabel} ${i + 1}` : fallbackLabel) : String(s.student_id), start: Math.min(Math.max(1, parseInt(s.start_unit, 10) || 1), units.length) }))
    .sort((a, b) => a.start - b.start)
    .filter((s, i, arr) => i === 0 || s.start !== arr[i - 1].start);
  if (!starts.length || starts[0].start !== 1) starts.unshift({ id: fallbackLabel, start: 1 });
  return starts.map((s, i) => ({ label: s.id, units: units.slice(s.start - 1, (starts[i + 1]?.start ?? units.length + 1) - 1),
                                 range: [s.start, (starts[i + 1]?.start ?? units.length + 1) - 1] }));
}

export function splitEveryN(units, n) {
  const out = [];
  for (let i = 0; i < units.length; i += n) out.push({ label: `Student ${out.length + 1}`, units: units.slice(i, i + n), range: [i + 1, Math.min(i + n, units.length)] });
  return out;
}

/** Break a text document into paragraph "units" so combined text files can be split too. */
export function textUnits(text) {
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  // merge tiny paragraphs to keep the unit count reasonable
  const units = [];
  for (const p of paras) {
    if (units.length && units[units.length - 1].length < 200 && !/^(name|student|roll)\b/i.test(p)) units[units.length - 1] += "\n\n" + p;
    else units.push(p);
  }
  return units;
}
