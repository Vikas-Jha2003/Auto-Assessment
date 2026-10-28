/**
 * @file Measures how closely the grader agrees with a teacher. Used by evaluate.html.
 *
 * Inputs: the teacher's marks (CSV: student, Q1, Q2, ...) and one or more grading runs of the
 * same sheets. Outputs standard agreement metrics, plus checks on the feedback itself.
 */

/** Parse CSV text (handles quotes, commas and newlines inside quotes, and a byte-order mark). */
export function parseCSV(text) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  const src = text.replace(/^\ufeff/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows;
}

/** Lower-case letters and digits only, in any script. */
const key = (s) => String(s || "").toLowerCase().normalize("NFC").replace(/[^\p{L}\p{M}\p{N}]/gu, "");
/** Roll-number-like tokens: contain both letters and digits, or are long numbers. */
const rollNumbers = (s) => (String(s).match(/[\p{L}\p{N}]+/gu) || []).filter((t) => /\d/.test(t) && (/\p{L}/u.test(t) || t.length >= 4));

/**
 * Read the teacher's marks.
 * @param {string} csvText First column: student (name and/or roll number). Other columns: Q1, Q2 ... or 1, 2 ...
 * @param {import("./exam.js").Exam} exam
 * @returns {{ student: string, marks: Record<string, number> }[]}
 */
export function readTeacherMarks(csvText, exam) {
  const rows = parseCSV(csvText);
  if (rows.length < 2) throw new Error("The CSV needs a header row and at least one student row.");
  const qkey = (h) => key(h).replace(/^(q|question|प्रश्न)/u, "");
  const columns = rows[0].slice(1).map((h) => exam.questions.find((q) => qkey(q.id) === qkey(h))?.id ?? null);
  if (!columns.some(Boolean)) {
    throw new Error(`No CSV columns match the question numbers (${exam.questions.map((q) => `Q${q.id}`).join(", ")}).`);
  }
  return rows.slice(1).map((r) => {
    const marks = {};
    columns.forEach((qid, i) => {
      const v = r[i + 1];
      if (qid && v != null && v.trim() !== "" && Number.isFinite(+v)) marks[qid] = +v;
    });
    return { student: r[0].trim(), marks };
  });
}

/**
 * Find the graded student a teacher's row refers to: by roll number first, then by name.
 * @template {{ label: string, report?: { student_id: string } }} S
 * @param {S[]} students
 * @param {string} name
 * @returns {S | undefined}
 */
export function matchStudent(students, name) {
  const rolls = rollNumbers(name).map(key);
  const ids = (s) => `${s.report?.student_id || ""} ${s.label} ${s.source || ""}`;
  if (rolls.length) {
    const byRoll = students.find((s) => rollNumbers(ids(s)).map(key).some((r) => rolls.includes(r)));
    if (byRoll) return byRoll;
  }
  const n = key(name.replace(/\(.*\)/, ""));
  return students.find((s) => key(s.report?.student_id) === n || key(s.label) === n)
    || students.find((s) => n && key(ids(s)).includes(n));
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

/** Pearson correlation coefficient. */
export function pearson(x, y) {
  if (x.length < 2) return NaN;
  const mx = mean(x), my = mean(y);
  let sxy = 0, sx = 0, sy = 0;
  x.forEach((v, i) => { sxy += (v - mx) * (y[i] - my); sx += (v - mx) ** 2; sy += (y[i] - my) ** 2; });
  return sx && sy ? sxy / Math.sqrt(sx * sy) : NaN;
}

/**
 * Quadratic weighted kappa: the standard agreement measure for automated essay scoring.
 * 1 = perfect agreement, 0 = chance, negative = worse than chance. Marks are put on a `step` grid.
 */
export function quadraticKappa(a, b, step = 0.5) {
  const x = a.map((v) => Math.round(v / step)), y = b.map((v) => Math.round(v / step));
  const lo = Math.min(...x, ...y), n = Math.max(...x, ...y) - lo + 1;
  if (n === 1) return 1;
  const observed = Array.from({ length: n }, () => new Array(n).fill(0));
  x.forEach((v, i) => observed[v - lo][y[i] - lo]++);
  const rowSum = observed.map((r) => r.reduce((s, v) => s + v, 0));
  const colSum = observed[0].map((_, j) => observed.reduce((s, r) => s + r[j], 0));
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const w = (i - j) ** 2 / (n - 1) ** 2;
      num += w * observed[i][j];
      den += w * rowSum[i] * colSum[j] / x.length;
    }
  }
  return den === 0 ? 1 : 1 - num / den;
}

/**
 * Compare grading runs with the teacher's marks.
 * @param {import("./exam.js").Exam} exam
 * @param {{ students: any[] }[]} runs  The same sheets graded one or more times (repeats measure consistency).
 * @param {{ student: string, marks: Record<string, number> }[]} teacher
 */
export function evaluate(exam, runs, teacher) {
  const rows = [], unmatched = [];
  let awarded = 0, verified = 0, lost = 0, advised = 0;
  for (const t of teacher) {
    const perRun = runs.map((r) => matchStudent(r.students.filter((s) => s.report), t.student));
    if (!perRun[0]) { unmatched.push(t.student); continue; }
    for (const q of exam.questions) {
      if (!(q.id in t.marks)) continue;
      const marks = perRun.filter(Boolean).map((s) => s.report.questions.find((x) => x.question_id === q.id)?.marks_awarded ?? 0);
      rows.push({ student: perRun[0].report.student_id, question: q.id, max: q.max_marks, teacher: t.marks[q.id], ai: mean(marks), runs: marks });
      const result = perRun[0].report.questions.find((x) => x.question_id === q.id);
      for (const c of result?.criteria || []) {
        if (c.marks_awarded > 0) { awarded++; if (c.evidence_verified) verified++; }
        if (c.marks_awarded < c.marks_available) {
          lost++;
          if (result.improvements.some((i) => i.criterion_id.toLowerCase() === c.criterion_id.toLowerCase())) advised++;
        }
      }
    }
  }
  const t = rows.map((r) => r.teacher), a = rows.map((r) => r.ai), err = rows.map((r) => Math.abs(r.teacher - r.ai));
  const totals = {};
  for (const r of rows) { totals[r.student] ||= { teacher: 0, ai: 0 }; totals[r.student].teacher += r.teacher; totals[r.student].ai += r.ai; }
  const spread = rows.filter((r) => r.runs.length > 1).map((r) => Math.max(...r.runs) - Math.min(...r.runs));
  const round = (x, d = 3) => (Number.isFinite(x) ? +x.toFixed(d) : null);

  const metrics = rows.length ? [
    ["Answers compared", rows.length, "Question answers with a teacher mark"],
    ["Mean absolute error", round(mean(err), 2), "Average difference from the teacher, in marks"],
    ["Mean absolute error (% of question)", round(100 * mean(rows.map((r) => Math.abs(r.teacher - r.ai) / r.max)), 1), "The same, as a share of each question's marks"],
    ["Agreement within ±0.5 marks", round(mean(err.map((e) => +(e <= 0.5 + 1e-9)))), "Share of answers"],
    ["Agreement within ±1 mark", round(mean(err.map((e) => +(e <= 1 + 1e-9)))), "Share of answers"],
    ["Pearson correlation", round(pearson(t, a)), "Do the grader and teacher rank answers the same way? (1 = perfectly)"],
    ["Quadratic weighted kappa", round(quadraticKappa(t, a)), "Agreement beyond chance; above 0.7 is usually considered strong"],
    ["Mean absolute error on totals", round(mean(Object.values(totals).map((x) => Math.abs(x.teacher - x.ai))), 2), "Per student, in marks"],
    ["Consistency between repeats", spread.length ? round(mean(spread), 2) : null, "Average spread of an answer's marks across repeated runs (0 = identical)"],
    ["Awarded marks with verified evidence", awarded ? round(verified / awarded) : null, "Share of awarded criteria whose quote was found in the answer"],
    ["Lost marks with improvement advice", lost ? round(advised / lost) : null, "Share of criteria that lost marks and got a concrete fix"],
  ] : [];
  return { metrics, rows, totals, unmatched };
}
