// Offline stand-in for the LLM, so every screen can be tried without a key or credits.
// Marks come from crude keyword overlap and are NOT meaningful.

const STOP = new Set(`a an the and or of to in on for with is are be by as that this it its from at which what how why
explain describe state give one two three marks mark answer student correct mentions shows uses`.split(/\s+/));

const words = (s) => new Set((String(s).toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => !STOP.has(w) && w.length > 2));
const textOf = (u) => (typeof u === "string" ? u : u.map((p) => p.text || "").join("\n"));
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export class MockBackend {
  respond(task, system, user) {
    const t = textOf(user);
    const base = task.split(":")[0];
    if (base === "grade" || base === "audit" || base === "regrade") return JSON.stringify(this.grade(t));
    if (base === "split_answers") return JSON.stringify(this.split(t));
    if (base === "structure_exam") return JSON.stringify(this.structure(t));
    if (base === "detect_students") return JSON.stringify(this.detect(t));
    if (base === "overall") return JSON.stringify({ summary: "Mock overall summary — turn off Mock mode for real feedback.",
      top_priorities: ["Mock priority 1", "Mock priority 2", "Mock priority 3"],
      study_plan: ["Mock study step 1", "Mock study step 2", "Mock study step 3"] });
    if (base === "judge") return JSON.stringify({ specificity: 3, actionability: 3, rubric_alignment: 3, accuracy: 3, comment: "mock" });
    if (base === "transcribe") return "[Demo mode can't read handwriting or scans. Add an API key in Settings to read this page.]\nQ1. Overfitting is when the model memorises the training data.\nQ2. Attention uses query key and value vectors.";
    return "{}";
  }

  grade(t) {
    const crits = [...t.matchAll(/- \[([^\]]+)\] \(([\d.]+) marks\) (.+)/g)];
    const m = t.match(/<<<STUDENT_ANSWER\n([\s\S]*?)\nSTUDENT_ANSWER>>>/);
    const answer = m ? m[1] : "";
    const sentences = answer.split(/(?<=[.!?])\s+|\n/).map((s) => s.trim()).filter((s) => s.length > 3);
    const aw = words(answer);
    const criteria = [], improvements = [];
    for (const [, cid, mk, desc] of crits) {
      const marks = Number(mk), dw = words(desc);
      let ratio = [...dw].filter((w) => aw.has(w)).length / Math.max(1, dw.size);
      if (answer.includes("NO ANSWER")) ratio = 0;
      const frac = ratio >= 0.5 ? 1 : ratio >= 0.25 ? 0.5 : 0;
      const awarded = Math.round(marks * frac * 2) / 2;
      const best = sentences.reduce((b, s) => {
        const sc = [...words(s)].filter((w) => dw.has(w)).length;
        return sc > b[1] ? [s, sc] : b;
      }, ["", -1])[0];
      criteria.push({ criterion_id: cid, marks_awarded: awarded, marks_available: marks,
        status: frac === 1 ? "met" : frac ? "partially_met" : "not_met",
        evidence: awarded && best ? [best] : [], justification: `Keyword overlap with the criterion was ${Math.round(ratio * 100)}%.` });
      if (awarded < marks) improvements.push({ criterion_id: cid, issue: `Your answer does not fully address: ${desc}`,
        how_to_fix: `Add an explicit explanation covering: ${desc}`, example: "(mock example sentence)" });
    }
    return { criteria, strengths: ["(mock) You attempted the question."], improvements, misconceptions: [],
             summary: "(mock) Keyword-based grade." };
  }

  split(t) {
    const ids = [...t.matchAll(/- id "([^"]+)"/g)].map((x) => x[1]);
    const sheet = (t.split("ANSWER SHEET:\n<<<\n")[1] || "").replace(/\n>>>\s*$/, "");
    const name = sheet.match(/(?:Name|Student|Roll)[^:\n]*:\s*(.+)/i);
    const any = ids.map(esc).join("|");
    const label = "(?:Q(?:uestion)?\\.?\\s*|Ans(?:wer)?\\.?\\s*)?";
    const answers = ids.map((qid) => {
      const re = new RegExp(`^\\s*${label}${esc(qid)}\\s*[).:-]?\\s*([\\s\\S]*?)(?=^\\s*${label}(?:${any})\\s*[).:-]|$(?![\\s\\S]))`, "im");
      const mm = sheet.match(re);
      return { question_id: qid, answer: mm ? mm[1].trim() : "" };
    });
    const qw = words(t.split("ANSWER SHEET:")[0]), sw = words(sheet);
    const different = sw.size > 20 && [...sw].filter((w) => qw.has(w)).length / sw.size < 0.03;
    return { student_id: name ? name[1].trim() : "", different_test: different, answers: different ? answers.map((a) => ({ ...a, answer: "" })) : answers };
  }

  structure(t) {
    const qs = [...t.matchAll(/^Q(\w+)[.)]?\s*\((\d+(?:\.\d+)?) marks?\)\s*(.+)$/gim)];
    const part = (a, b) => (t.split(a)[1] || "").split(b)[0];
    const qp = words(part("QUESTION PAPER:", "RUBRIC / MARKING SCHEME:"));
    // share of the question paper's topic words that also appear in the document
    const overlap = (w) => (w.size && qp.size ? [...qp].filter((x) => w.has(x)).length / qp.size : 1);
    const checks = [];
    if (!qs.length) checks.push({ level: "error", about: "question_paper", question_id: null, message: "No numbered questions with marks were found in the question paper." });
    if (overlap(words(part("RUBRIC / MARKING SCHEME:", "MODEL ANSWERS:"))) < 0.1)
      checks.push({ level: "error", about: "rubric", question_id: null, message: "The rubric doesn't seem to belong to this question paper: its points don't mention the topics of these questions." });
    if (!t.includes("MODEL ANSWERS:\n(none provided)") && overlap(words(part("MODEL ANSWERS:", "\u0000"))) < 0.1)
      checks.push({ level: "error", about: "model_answers", question_id: null, message: "The model answers don't seem to answer these questions." });
    return { title: "Mock-structured exam", instructions: "", checks,
      questions: qs.map(([, id, mk, text]) => ({ id, text, max_marks: Number(mk),
        rubric: [{ id: `${id}.1`, description: text, marks: Number(mk) }], model_answer: "" })) };
  }

  detect(t) {
    const units = t.split(/=== UNIT (\d+) ===/).slice(1);
    const students = [];
    for (let i = 0; i < units.length; i += 2) {
      const n = Number(units[i]); const body = units[i + 1] || "";
      const m = body.match(/(?:Name|Student)\s*:\s*([^\n]+)/i);
      if (m) students.push({ student_id: m[1].trim(), start_unit: n });
    }
    if (!students.length) students.push({ student_id: "Student 1", start_unit: 1 });
    return { students };
  }
}
