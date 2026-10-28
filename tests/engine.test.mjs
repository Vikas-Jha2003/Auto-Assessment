// Offline tests for the grading engine (web/js/core). No API key needed:  npm test
import test from "node:test";
import assert from "node:assert/strict";

import { quoteInText, textLayerLooksBroken } from "../web/js/core/textmatch.js";
import { cleanExam, normaliseExam, structureWarnings } from "../web/js/core/exam.js";
import { alignSheet, groupFiles, textUnits, tidyName } from "../web/js/core/sheets.js";
import { coerceResult, combinePasses, checkResult } from "../web/js/core/grader.js";
import { extractJSON } from "../web/js/core/llm.js";
import { GradingRun } from "../web/js/core/pipeline.js";
import { parseCSV, readTeacherMarks, quadraticKappa, matchStudent, evaluate } from "../web/js/core/evaluation.js";

/** A small two-question test used throughout. */
const exam = normaliseExam(cleanExam({
  title: "Sample",
  questions: [
    { id: "1", text: "Define overfitting and give two remedies.", max_marks: 4, model_answer: "Learns noise; regularisation; early stopping.",
      rubric: [{ id: "1.1", description: "Defines overfitting", marks: 2 }, { id: "1.2", description: "First remedy", marks: 1 }, { id: "1.3", description: "Second remedy", marks: 1 }] },
    { id: "2", text: "प्रकाश संश्लेषण क्या है?", max_marks: 3, model_answer: "पौधे भोजन बनाते हैं।",
      rubric: [{ id: "2.1", description: "परिभाषा", marks: 2 }] },          // adds up to 2, not 3
  ],
}));

// ------------------------------------------------------------------ evidence matching

test("evidence quotes are matched despite small spelling differences", () => {
  const answer = "Overfitting means the model memorises the training data, including the noise in it.";
  assert.ok(quoteInText("the model memorises the training data", answer));
  assert.ok(quoteInText("The model memorizes the training data", answer));
  assert.ok(!quoteInText("dropout randomly switches off neurons", answer));
});

test("evidence matching works for Hindi, Tamil and code-mixed text", () => {
  assert.ok(quoteInText("मॉडल प्रशिक्षण डेटा को रट लेता है", "ओवरफिटिंग तब होती है जब मॉडल प्रशिक्षण डेटा को रट लेता है।"));
  assert.ok(quoteInText("மாதிரி பயிற்சி தரவை மனப்பாடம் செய்கிறது", "Overfitting என்பது மாதிரி பயிற்சி தரவை மனப்பாடம் செய்கிறது."));
  assert.ok(quoteInText("Ohm ka law kehta hai", "Q2. Ohm ka law kehta hai ki current voltage ke proportional hota hai."));
  assert.ok(!quoteInText("अम्ल खट्टे होते हैं", "प्रकाश संश्लेषण में पौधे भोजन बनाते हैं।"));
});

test("broken PDF text layers in Indian scripts are detected", () => {
  // what pdf.js typically extracts from a Hindi PDF: vowel signs before consonants, NUL glyphs
  assert.ok(textLayerLooksBroken("प\u0000 श्   न   1. (3   अं क )   िव ा न   िल िख ए।   इस का   सं तु िल त"));
  assert.ok(!textLayerLooksBroken("प्रश्न 1. प्रकाश संश्लेषण वह प्रक्रिया है जिसमें हरे पौधे भोजन बनाते हैं।"));
  assert.ok(!textLayerLooksBroken("Q1. Overfitting is when a model learns the noise in the training data."));
});

// ------------------------------------------------------------------ the test documents

test("criteria are scaled to add up to the question's marks, with a warning", () => {
  const raw = cleanExam({ questions: [{ id: "Q2", text: "x", max_marks: 3, rubric: [{ id: "2.1", description: "a", marks: 2 }] }] });
  assert.equal(raw.questions[0].id, "2");                               // "Q2" -> "2"
  assert.match(structureWarnings(raw)[0], /add up to 2/);
  assert.equal(exam.questions[1].rubric.reduce((a, c) => a + c.marks, 0), 3);
});

test("model-answer problems from the document check reach the grader", () => {
  const e = cleanExam({ questions: [{ id: "3", text: "x", max_marks: 5, rubric: [] }],
    checks: [{ level: "warning", about: "model_answers", question_id: "Q3", message: "Recall should be 40/60." }] });
  assert.equal(e.questions[0].model_answer_note, "Recall should be 40/60.");
  assert.equal(e.checks[0].level, "warning");
});

// ------------------------------------------------------------------ answer sheets

test("page photos of the same student are grouped in page order", () => {
  const groups = groupFiles([{ name: "21CS042_p2.jpg" }, { name: "21CS042_p1.jpg" }, { name: "rahul.pdf" }]);
  assert.deepEqual(groups.map((g) => [g.label, g.files.map((f) => f.name)]),
    [["21CS042", ["21CS042_p1.jpg", "21CS042_p2.jpg"]], ["rahul", ["rahul.pdf"]]]);
});

test("names in English, Hindi and Tamil are tidied", () => {
  assert.equal(tidyName("Name: Ananya Rao    Roll No: 21CS042"), "Ananya Rao (21CS042)");
  assert.equal(tidyName("नाम: आरव शर्मा   अनुक्रमांक: 10A01"), "आरव शर्मा (10A01)");
  assert.equal(tidyName("பெயர்: கவின் குமார்   பதிவு எண்: 21CS092"), "கவின் குமார் (21CS092)");
});

test("split answers are aligned to the test's question ids", () => {
  const split = alignSheet(exam, { student_id: " Ananya ", answers: [{ question_id: "Q1", answer: "learns noise" }] });
  assert.deepEqual(split.answers, { 1: "learns noise", 2: "" });
  assert.equal(split.student_id, "Ananya");
});

test("text documents with several students are split into blocks", () => {
  assert.equal(textUnits("Name: A\n\nQ1. x\n\nName: B\n\nQ1. y").length, 2);
});

// ------------------------------------------------------------------ grading safeguards

test("marks are clamped to each criterion and missing criteria are reported", () => {
  const r = coerceResult({ criteria: [{ criterion_id: "1.1", marks_awarded: 9, evidence: ["x"] }] }, exam.questions[0], 0.5);
  assert.equal(r.criteria[0].marks_awarded, 2);
  assert.deepEqual(r.missing, ["1.2", "1.3"]);
});

test("the median of independent passes is used for each criterion", () => {
  const q = exam.questions[0];
  const pass = (m) => coerceResult({ criteria: q.rubric.map((c) => ({ criterion_id: c.id, marks_awarded: m, evidence: ["e"] })) }, q, 0.5);
  const combined = combinePasses([pass(0), pass(1), pass(1)], q, 0.5);
  assert.deepEqual(combined.criteria.map((c) => c.marks_awarded), [1, 1, 1]);
});

test("invented evidence and missing advice are caught", () => {
  const q = exam.questions[0];
  const r = coerceResult({ criteria: q.rubric.map((c, i) => ({ criterion_id: c.id, marks_awarded: i ? 0 : 2, evidence: ["something never written"] })) }, q, 0.5);
  const problems = checkResult(r, "Overfitting is bad.");
  assert.ok(problems.some((p) => p.includes("none of its evidence quotes")));
  assert.equal(problems.filter((p) => p.includes("no improvement item")).length, 2);
});

test("JSON is extracted from fenced or chatty model replies", () => {
  assert.deepEqual(extractJSON('Sure!\n```json\n{"a": 1}\n```'), { a: 1 });
  assert.deepEqual(extractJSON('Here: {"b": [2]} done'), { b: [2] });
});

// ------------------------------------------------------------------ the whole pipeline (Demo mode)

test("a batch runs end to end in demo mode, including a Hindi test", async () => {
  const doc = (name, text) => ({ name, text });
  const reader = {
    readPages: async (_llm, f) => [f.text],
    readFilesText: async (_llm, fs) => fs.map((f) => f.text).join("\n\n"),
    isPaged: () => false,
  };
  const run = new GradingRun({
    settings: { mock: true, samples: 2 }, mode: "individual", reader,
    testFiles: {
      qp: [doc("qp.txt", "प्रश्न 1. (3 अंक) प्रकाश संश्लेषण क्या है?\nप्रश्न 2. (4 अंक) ओम का नियम लिखिए।")],
      rubric: [doc("rubric.txt", "प्रश्न 1: प्रकाश संश्लेषण की परिभाषा। प्रश्न 2: ओम का नियम V = IR")],
      model: [],
    },
    sheetFiles: [doc("10A01.txt", "नाम: आरव   अनुक्रमांक: 10A01\n\nप्रश्न 1. प्रकाश संश्लेषण में पौधे भोजन बनाते हैं।\nप्रश्न 2. ओम का नियम: V = IR")],
  });
  await run.start();
  assert.equal(run.status, "done");
  assert.equal(run.exam.questions.length, 2);
  assert.equal(run.students[0].report.student_id, "आरव (10A01)");
  assert.ok(run.students[0].answers["2"].includes("V = IR"));
});

test("grading stops before it starts when the rubric is for another test", async () => {
  const doc = (name, text) => ({ name, text });
  const reader = { readPages: async (_l, f) => [f.text], readFilesText: async (_l, fs) => fs.map((f) => f.text).join("\n"), isPaged: () => false };
  const run = new GradingRun({
    settings: { mock: true }, mode: "individual", reader,
    testFiles: { qp: [doc("qp.txt", "Q1. (4 marks) Define overfitting in machine learning models.")],
                 rubric: [doc("r.txt", "Mitochondria produce ATP for muscle contraction.")], model: [] },
    sheetFiles: [doc("a.txt", "Q1. Overfitting is memorising noise.")],
  });
  await run.start();
  assert.equal(run.status, "review");
  assert.equal(run.usage.calls, 1);           // only the document check ran; nothing was graded
});

// ------------------------------------------------------------------ evaluation metrics

test("CSV parsing handles quotes and a byte-order mark", () => {
  assert.deepEqual(parseCSV('\ufeffstudent,Q1\n"Rao, Ananya",4'), [["student", "Q1"], ["Rao, Ananya", "4"]]);
});

test("teacher rows match students by roll number, whatever the script of the name", () => {
  const students = [{ label: "x", report: { student_id: "आरव शर्मा (10A01)" } }, { label: "y", report: { student_id: "Meera Nair (10A04)" } }];
  assert.equal(matchStudent(students, "Aarav Sharma (10A01)"), students[0]);
  assert.equal(matchStudent(students, "Meera Nair"), students[1]);
});

test("agreement metrics", () => {
  assert.equal(quadraticKappa([0, 1, 2, 3], [0, 1, 2, 3]), 1);
  assert.ok(quadraticKappa([0, 1, 2, 3], [3, 2, 1, 0]) < 0);
  const result = (m) => ({ question_id: "1", marks_awarded: m, max_marks: 4, criteria: [], improvements: [] });
  const runs = [{ students: [{ label: "a", report: { student_id: "Ananya (21CS042)", questions: [result(3)] } }] }];
  const { metrics, rows } = evaluate(exam, runs, readTeacherMarks("student,Q1\n21CS042,4", exam));
  assert.equal(rows[0].teacher - rows[0].ai, 1);
  assert.equal(metrics.find(([name]) => name === "Mean absolute error")[1], 1);
});
