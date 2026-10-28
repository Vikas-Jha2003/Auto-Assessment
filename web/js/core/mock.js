/**
 * @file Demo mode: an offline stand-in for the language model.
 *
 * It lets every screen be tried without an API key or credit. It recognises which pipeline step
 * is calling it (`task`) and returns a reply in the same JSON shape a real model would, using
 * simple keyword overlap. Its marks are NOT meaningful, and it cannot read images.
 */

const STOP_WORDS = new Set(`a an the and or of to in on for with is are be by as that this it its from at which what how why
explain describe state give one two three marks mark answer student correct mentions shows uses
का के की है में और से को एक यह कि पर भी लिए`.split(/\s+/));

/** Content words of a text, in any script. */
const words = (s) => new Set((String(s).toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) || [])
  .filter((w) => !STOP_WORDS.has(w) && [...w].length > 2));
/** Text of a user message (a string, or content parts with images). */
const textOf = (u) => (typeof u === "string" ? u : u.map((p) => p.text || "").join("\n"));
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const overlap = (a, b) => (a.size ? [...a].filter((w) => b.has(w)).length / a.size : 0);

/** Question labels in English and Hindi, e.g. "Q1.", "Ans 2)", "प्रश्न 3", "उत्तर 3". */
const LABEL = "(?:Q(?:uestion)?\\.?\\s*|Ans(?:wer)?\\.?\\s*|प्रश्न\\s*|उत्तर\\s*)?";
const NAME = /(?:Name|Student|नाम)[^:\n]*:\s*(.+)/i;

export class MockBackend {
  /**
   * @param {string} task Pipeline step, e.g. "grade" or "split_answers".
   * @param {string} system
   * @param {string | object[]} user
   * @returns {string} A reply in the format that step expects.
   */
  respond(task, system, user) {
    const text = textOf(user);
    switch (task.split(":")[0]) {
      case "grade": case "audit": return JSON.stringify(this.grade(text));
      case "split_answers": return JSON.stringify(this.split(text));
      case "structure_exam": return JSON.stringify(this.structure(text));
      case "detect_students": return JSON.stringify(this.detect(text));
      case "overall": return JSON.stringify({
        summary: "Demo mode: this summary is a placeholder. Add an API key in Settings for real feedback.",
        top_priorities: ["Placeholder priority 1", "Placeholder priority 2", "Placeholder priority 3"],
        study_plan: ["Placeholder study step 1", "Placeholder study step 2", "Placeholder study step 3"],
      });
      case "judge": return JSON.stringify({ specificity: 3, actionability: 3, rubric_alignment: 3, accuracy: 3, comment: "demo" });
      case "transcribe": // a stand-in page, so photographed sheets still flow through the pipeline
        return "[Demo mode can't read handwriting or scans. Add an API key in Settings to read this page.]\n" +
          "Q1. (placeholder answer)\nQ2. (placeholder answer)\nQ3. (placeholder answer)";
      default: return "{}";
    }
  }

  /** Award a criterion when enough of its words appear in the answer. */
  grade(text) {
    const answer = (text.match(/<<<STUDENT_ANSWER\n([\s\S]*?)\nSTUDENT_ANSWER>>>/) || [])[1] || "";
    const blank = answer.includes("NO ANSWER");
    const sentences = answer.split(/(?<=[.!?।])\s+|\n/).map((s) => s.trim()).filter((s) => s.length > 3);
    const answerWords = words(answer);
    const criteria = [], improvements = [];
    for (const [, id, marksText, description] of text.matchAll(/- \[([^\]]+)\] \(([\d.]+) marks\) (.+)/g)) {
      const marks = Number(marksText), criterionWords = words(description);
      const ratio = blank ? 0 : overlap(criterionWords, answerWords);
      const fraction = ratio >= 0.5 ? 1 : ratio >= 0.25 ? 0.5 : 0;
      const awarded = Math.round(marks * fraction * 2) / 2;
      const best = sentences.reduce((b, s) => (overlap(criterionWords, words(s)) > overlap(criterionWords, words(b)) ? s : b), sentences[0] || "");
      criteria.push({ criterion_id: id, marks_awarded: awarded, marks_available: marks,
        evidence: awarded && best ? [best] : [], justification: `Demo mode: ${Math.round(ratio * 100)}% of the criterion's keywords appear in the answer.` });
      if (awarded < marks) improvements.push({ criterion_id: id, issue: `Not fully covered: ${description}`,
        how_to_fix: `Add a clear explanation of this point: ${description}`, example: "(Demo mode has no example sentence.)" });
    }
    return { criteria, strengths: ["Demo mode: placeholder strength."], improvements, misconceptions: [], summary: "Demo mode: keyword-based mark." };
  }

  /** Split a sheet on question labels. */
  split(text) {
    const ids = [...text.matchAll(/- id "([^"]+)"/g)].map((m) => m[1]);
    const sheet = (text.split("ANSWER SHEET:\n<<<\n")[1] || "").replace(/\n>>>\s*$/, "");
    const anyId = ids.map(escapeRe).join("|");
    let answers = ids.map((id) => {
      const re = new RegExp(`^\\s*${LABEL}${escapeRe(id)}\\s*[).:-]?\\s*([\\s\\S]*?)(?=^\\s*${LABEL}(?:${anyId})\\s*[).:-]|$(?![\\s\\S]))`, "imu");
      return { question_id: id, answer: (sheet.match(re) || [])[1]?.trim() || "" };
    });
    const sheetWords = words(sheet);
    const different = sheetWords.size > 20 && overlap(sheetWords, words(text.split("ANSWER SHEET:")[0])) < 0.03;
    if (different) answers = answers.map((a) => ({ ...a, answer: "" }));
    return { student_id: (sheet.match(NAME) || [])[1]?.trim() || "", different_test: different, answers };
  }

  /** Read "Q1. (4 marks) …" or "प्रश्न 1. (4 अंक) …" lines, and flag documents that don't match. */
  structure(text) {
    const qs = [...text.matchAll(/^(?:Q|प्रश्न\s*)(\d+\w*)[.)]?\s*\((\d+(?:\.\d+)?)\s*(?:marks?|अंक)\)\s*(.+)$/gimu)];
    const part = (from, to) => (text.split(from)[1] || "").split(to)[0];
    const paperWords = words(part("QUESTION PAPER:", "RUBRIC / MARKING SCHEME:"));
    const coverage = (doc) => (paperWords.size ? overlap(paperWords, words(doc)) : 1);   // share of the paper's topics in `doc`
    const checks = [];
    if (!qs.length) checks.push({ level: "error", about: "question_paper", question_id: null, message: "No numbered questions with marks were found in the question paper." });
    if (coverage(part("RUBRIC / MARKING SCHEME:", "MODEL ANSWERS:")) < 0.1) {
      checks.push({ level: "error", about: "rubric", question_id: null, message: "The rubric doesn't seem to belong to this question paper: its points don't mention the topics of these questions." });
    }
    const model = part("MODEL ANSWERS:", "\u0000");
    if (!model.includes("(none provided)") && coverage(model) < 0.1) {
      checks.push({ level: "error", about: "model_answers", question_id: null, message: "The model answers don't seem to answer these questions." });
    }
    return {
      title: "Demo-mode test", instructions: "", checks,
      questions: qs.map(([, id, marks, q]) => ({ id, text: q, max_marks: Number(marks),
        rubric: [{ id: `${id}.1`, description: q, marks: Number(marks) }], model_answer: "" })),
    };
  }

  /** A new student starts wherever a "Name:" line appears. */
  detect(text) {
    const parts = text.split(/=== UNIT (\d+) ===/).slice(1);
    const students = [];
    for (let i = 0; i < parts.length; i += 2) {
      const m = (parts[i + 1] || "").match(/(?:Name|Student|नाम)\s*:\s*([^\n]+)/i);
      if (m) students.push({ student_id: m[1].trim(), start_unit: Number(parts[i]) });
    }
    return { students: students.length ? students : [{ student_id: "Student 1", start_unit: 1 }] };
  }
}
