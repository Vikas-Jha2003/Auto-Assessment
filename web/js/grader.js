// Per-question grading: rubric-by-criterion marks with verbatim evidence, self-consistency across
// several samples, automatic checks, and an audit pass that repairs whatever fails.
import * as P from "./prompts.js";
import { quoteInText } from "./textmatch.js";
import { BudgetExceeded, FatalApiError } from "./llm.js";

export const roundStep = (x, step) => (step > 0 ? +(Math.round(x / step) * step).toFixed(2) : +x.toFixed(2));
const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const statusFor = (m, max) => (m >= max - 1e-9 ? "met" : m <= 1e-9 ? "not_met" : "partially_met");
const fmt = (n) => String(+(+n).toFixed(2));

export const rubricText = (q) => q.rubric.map((c) => `- [${c.id}] (${fmt(c.marks)} marks) ${c.description}`).join("\n");

export function graderUserPrompt(exam, q, answer) {
  return P.graderUser({
    instructions: (exam.instructions || "").trim(), qid: q.id, maxMarks: fmt(q.max_marks), question: q.text,
    rubric: rubricText(q),
    modelAnswer: (q.model_answer || "(not provided)") + (q.model_answer_note
      ? `\n[Note from the document check: ${q.model_answer_note} Where the model answer is wrong, grade by the rubric and correct subject knowledge.]` : ""),
    answer: answer?.trim() ? answer.trim() : "[NO ANSWER - question not attempted]",
  });
}

export function coerceSample(raw, q, step) {
  const byId = {};
  for (const c of raw?.criteria || []) if (c && c.criterion_id != null) byId[String(c.criterion_id).trim().toLowerCase()] = c;
  const missing = [];
  const criteria = q.rubric.map((crit) => {
    const c = byId[crit.id.toLowerCase()];
    if (!c) {
      missing.push(crit.id);
      return { criterion_id: crit.id, status: "not_met", marks_awarded: 0, marks_available: crit.marks, evidence: [],
               justification: "Grader did not return a decision for this criterion.", evidence_verified: null };
    }
    let m = Number(c.marks_awarded); if (!isFinite(m)) m = 0;
    m = Math.min(Math.max(roundStep(m, step), 0), crit.marks);
    let ev = c.evidence || []; if (typeof ev === "string") ev = [ev];
    return { criterion_id: crit.id, status: statusFor(m, crit.marks), marks_awarded: m, marks_available: crit.marks,
             evidence: ev.map((e) => String(e).trim().replace(/^"|"$/g, "")).filter(Boolean),
             justification: String(c.justification || "").trim(), evidence_verified: null };
  });
  const improvements = (raw?.improvements || []).filter((i) => i && typeof i === "object").map((i) => ({
    criterion_id: String(i.criterion_id || ""), issue: String(i.issue || ""), how_to_fix: String(i.how_to_fix || ""),
    example: String(i.example || "") }));
  const strs = (a) => (Array.isArray(a) ? a.map(String) : []);
  return { criteria, strengths: strs(raw?.strengths), improvements, misconceptions: strs(raw?.misconceptions),
           summary: String(raw?.summary || ""), missing };
}

export const sampleTotal = (s) => +s.criteria.reduce((a, c) => a + c.marks_awarded, 0).toFixed(2);

export function aggregate(samples, q, step) {
  if (samples.length === 1) return samples[0];
  const criteria = q.rubric.map((crit, i) => {
    const med = roundStep(median(samples.map((s) => s.criteria[i].marks_awarded)), step);
    const best = samples.reduce((b, s) => (Math.abs(s.criteria[i].marks_awarded - med) < Math.abs(b.criteria[i].marks_awarded - med) ? s : b)).criteria[i];
    const c = structuredClone(best);
    if (Math.abs(c.marks_awarded - med) > 1e-9) { c.marks_awarded = med; c.status = statusFor(med, crit.marks); }
    return c;
  });
  const aggTotal = criteria.reduce((a, c) => a + c.marks_awarded, 0);
  const rep = samples.reduce((b, s) => (Math.abs(sampleTotal(s) - aggTotal) < Math.abs(sampleTotal(b) - aggTotal) ? s : b));
  return { ...rep, criteria, missing: [...new Set(samples.flatMap((s) => s.missing))].sort() };
}

export function check(sample, answer) {
  const problems = [];
  if (sample.missing?.length) problems.push(`No decision returned for criteria ${JSON.stringify(sample.missing)}.`);
  for (const c of sample.criteria) {
    const verified = c.evidence.filter((e) => quoteInText(e, answer));
    c.evidence_verified = c.evidence.length ? verified.length > 0 : null;
    if (c.marks_awarded > 0 && !verified.length)
      problems.push(`Criterion ${c.criterion_id} awards ${fmt(c.marks_awarded)} marks but none of its evidence quotes appear verbatim in the student answer: ${JSON.stringify(c.evidence)}`);
    else if (c.evidence.length && verified.length < c.evidence.length)
      problems.push(`Criterion ${c.criterion_id} has quotes not found in the answer: ${JSON.stringify(c.evidence.filter((e) => !verified.includes(e)))}`);
  }
  const covered = new Set(sample.improvements.map((i) => i.criterion_id.toLowerCase()));
  for (const c of sample.criteria)
    if (c.marks_awarded < c.marks_available - 1e-9 && !covered.has(c.criterion_id.toLowerCase()))
      problems.push(`Criterion ${c.criterion_id} lost marks but has no improvement item (issue / how_to_fix / example).`);
  for (const i of sample.improvements)
    if (i.how_to_fix.split(/\s+/).filter(Boolean).length < 5) problems.push(`Improvement for ${i.criterion_id} is too vague: '${i.how_to_fix}'.`);
  return problems;
}

const payload = (s) => ({
  criteria: s.criteria.map(({ evidence_verified, ...c }) => c),
  strengths: s.strengths, improvements: s.improvements, misconceptions: s.misconceptions, summary: s.summary,
});

export async function gradeQuestion(llm, exam, q, answer, { samples } = {}) {
  const s = llm.s, step = s.mark_step;
  const user = graderUserPrompt(exam, q, answer || "");
  const system = P.graderSystem(fmt(step));
  const attempted = !!(answer || "").trim();
  const n = attempted ? (samples ?? s.samples) : 1;
  const temp = n > 1 ? s.temperature : 0;

  const runs = await Promise.all(Array.from({ length: n }, () =>
    llm.chatJSON(s.grader_model, system, user, { task: "grade", temperature: temp })));
  const sampled = runs.map((r) => coerceSample(r, q, step));
  const totals = sampled.map(sampleTotal);
  let result = aggregate(sampled, q, step);
  const spread = Math.max(...totals) - Math.min(...totals);
  const disagreement = spread > s.disagreement_threshold * q.max_marks;

  let problems = check(result, answer || "");
  if (disagreement) problems.push(`Independent grading samples disagreed: totals ${JSON.stringify(totals)} out of ${fmt(q.max_marks)}. Re-examine borderline criteria carefully and settle on the defensible mark.`);
  const flags = [];
  if (problems.length) {
    const auditUser = `${user}\n\nDRAFT GRADING:\n${JSON.stringify(payload(result), null, 1)}\n\nPROBLEMS FOUND BY THE CHECKER:\n- ${problems.join("\n- ")}`;
    try {
      const raw = await llm.chatJSON(s.grader_model, P.auditSystem(system), auditUser, { task: "audit", temperature: 0 });
      const audited = coerceSample(raw, q, step);
      const remaining = check(audited, answer || "");
      if (remaining.length <= problems.filter((p) => !p.startsWith("Independent")).length) { result = audited; problems = remaining; }
      else check(result, answer || ""); // restore evidence flags on the kept version
      flags.push("audited");
    } catch (e) {
      if (e.name === "AbortError" || e instanceof BudgetExceeded || e instanceof FatalApiError) throw e;
      flags.push(`audit failed: ${e.message}`);
    }
    flags.push(...problems.map((p) => `check: ${p}`));
  }
  const awarded = +result.criteria.reduce((a, c) => a + c.marks_awarded, 0).toFixed(2);
  const confidence = disagreement && problems.length ? "low" : disagreement || problems.length ? "medium" : "high";
  return { question_id: q.id, marks_awarded: awarded, max_marks: q.max_marks, criteria: result.criteria,
           strengths: result.strengths, improvements: result.improvements, misconceptions: result.misconceptions,
           summary: result.summary, confidence, sample_totals: totals, flags, override: null };
}

export async function overallFeedback(llm, exam, results) {
  const lines = results.map((r) => {
    const q = exam.questions.find((x) => x.id === r.question_id);
    return `Q${r.question_id} (${fmt(effectiveMarks(r))}/${fmt(r.max_marks)}) - ${q.text.slice(0, 150)}\n  summary: ${r.summary}\n  gaps: ${JSON.stringify(r.improvements.map((i) => i.issue))}\n  misconceptions: ${JSON.stringify(r.misconceptions)}`;
  });
  const total = results.reduce((a, r) => a + effectiveMarks(r), 0);
  const d = await llm.chatJSON(llm.s.grader_model, P.OVERALL_SYSTEM,
    `EXAM: ${exam.title}\nTOTAL: ${fmt(total)}/${fmt(examTotal(exam))}\n\n${lines.join("\n\n")}`, { task: "overall" });
  return { summary: String(d.summary || ""), top_priorities: (d.top_priorities || []).map(String), study_plan: (d.study_plan || []).map(String) };
}

export const effectiveMarks = (r) => (r.override ? r.override.marks : r.marks_awarded);
export const examTotal = (exam) => +exam.questions.reduce((a, q) => a + Number(q.max_marks), 0).toFixed(2);

export function buildReport(exam, studentId, questions, overall, extra = {}) {
  const total = +questions.reduce((a, r) => a + effectiveMarks(r), 0).toFixed(2);
  const max = examTotal(exam);
  return { exam_title: exam.title, student_id: studentId, total_awarded: total, total_marks: max,
           percentage: max ? +(100 * total / max).toFixed(1) : 0, questions, overall, ...extra };
}

export function recomputeTotals(report) {
  report.total_awarded = +report.questions.reduce((a, r) => a + effectiveMarks(r), 0).toFixed(2);
  report.percentage = report.total_marks ? +(100 * report.total_awarded / report.total_marks).toFixed(1) : 0;
  return report;
}
