// Offline tests for the browser grading engine:  node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { LLM } from "../web/js/llm.js";
import { cleanExam, normaliseExam, validateExam, splitSheet, groupFiles, splitEveryN, detectStudents, textUnits } from "../web/js/structure.js";
import { gradeQuestion, coerceSample, check } from "../web/js/grader.js";
import { quoteInText } from "../web/js/textmatch.js";

const root = new URL("../", import.meta.url).pathname;
const yamlToJSON = (p) => JSON.parse(execFileSync("python3", ["-c", "import json,sys,yaml;print(json.dumps(yaml.safe_load(open(sys.argv[1]))))", root + p]));
const exam = normaliseExam(cleanExam(yamlToJSON("samples/exam.yaml")));
const settings = { mock: true, samples: 3, temperature: 0.4, disagreement_threshold: 0.2, mark_step: 0.5, max_parallel: 4, budget_usd: 1,
                   grader_model: "g", fast_model: "f", vision_model: "v", overall_feedback: true };

test("example rubrics are valid and add up", () => {
  assert.equal(validateExam(exam).filter((i) => i.level !== "info").length, 0);
  for (const q of exam.questions) assert.equal(q.rubric.reduce((a, c) => a + c.marks, 0), q.max_marks);
});

test("quote check tolerates small spelling noise", () => {
  const t = "Overfitting means the model memorises the training data, including the noise.";
  assert.ok(quoteInText("the model memorizes the training data", t));
  assert.ok(!quoteInText("dropout randomly switches off neurons", t));
});

test("marks are clamped and missing criteria are filled", () => {
  const s = coerceSample({ criteria: [{ criterion_id: "1.1", marks_awarded: 9, evidence: ["x"] }] }, exam.questions[0], 0.5);
  assert.equal(s.criteria[0].marks_awarded, 2);
  assert.deepEqual(s.missing, ["1.2", "1.3"]);
});

test("invented evidence is caught", () => {
  const q = exam.questions[0];
  const s = coerceSample({ criteria: q.rubric.map((c) => ({ criterion_id: c.id, marks_awarded: c.marks, evidence: ["never written"] })) }, q, 0.5);
  assert.ok(check(s, "Overfitting is bad.").some((p) => p.includes("none of its evidence")));
});

test("out-of-order sheet is split and graded end to end", async () => {
  const llm = new LLM(settings);
  const sp = await splitSheet(llm, exam, fs.readFileSync(root + "samples/answer_sheets/student_C.txt", "utf8"));
  assert.match(sp.answers["3"], /precision/);
  const r = await gradeQuestion(llm, exam, exam.questions[2], sp.answers["3"]);
  assert.equal(r.sample_totals.length, 3);
  assert.ok(r.marks_awarded <= r.max_marks);
});

test("blank answer gets zero with one pass", async () => {
  const r = await gradeQuestion(new LLM(settings), exam, exam.questions[4], "");
  assert.equal(r.marks_awarded, 0); assert.equal(r.sample_totals.length, 1);
});

test("batch helpers", async () => {
  const g = groupFiles([{ name: "21CS042_p2.jpg" }, { name: "21CS042_p1.jpg" }, { name: "student_1.pdf" }], true);
  assert.deepEqual(g.map((x) => [x.label, x.files.map((f) => f.name)]), [["21CS042", ["21CS042_p1.jpg", "21CS042_p2.jpg"]], ["student_1", ["student_1.pdf"]]]);
  assert.equal(splitEveryN([1, 2, 3, 4, 5], 2).length, 3);
  const units = textUnits("Name: A\n\nQ1. x\n\nName: B\n\nQ1. y");
  assert.equal((await detectStudents(new LLM(settings), units)).length, 2);
});
