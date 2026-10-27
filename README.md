# Auto-Assessment

**Grade a full answer sheet against a rubric, with detailed, evidence-based feedback.**

Auto-Assessment is a web application that marks students' answer sheets using large language
models. A teacher uploads a question paper, a rubric, model answers and the answer sheets for a
class. Every student receives marks for each question, with feedback that quotes their own answer
and explains how to improve.

*Course project — Recent Advances in Generative AI*



---

## Contents

- [Auto-Assessment](#auto-assessment)
  - [Contents](#contents)
  - [Problem statement](#problem-statement)
  - [Features](#features)
  - [Getting started](#getting-started)
    - [Requirements](#requirements)
    - [Run](#run)
    - [Add your API key](#add-your-api-key)
  - [Using the application](#using-the-application)
    - [Example feedback](#example-feedback)
  - [Demo files](#demo-files)
  - [How it works](#how-it-works)
  - [Handling incorrect inputs](#handling-incorrect-inputs)
  - [Evaluation](#evaluation)
  - [Project structure](#project-structure)
  - [Technology](#technology)
    - [Tests](#tests)
  - [Limitations and future work](#limitations-and-future-work)

---

## Problem statement

| Aspect | Requirement |
|---|---|
| **Input** | Question paper, answer sheet, rubric, and a model answer for each question |
| **Output** | Marks per question, plus detailed feedback that can be defended against the rubric |
| **Reviewer** | None. Grading runs end-to-end from the inputs provided |
| **Bar** | Feedback specific enough for a student to actually improve from it |

Because there is no human reviewer, the system has to justify and check its own grading. Every mark
is tied to a rubric criterion and backed by a quote from the student's answer, and automatic checks
catch unsupported marks before results are shown.

---

## Features

**Inputs**

- Accepts PDF, Word (.docx), plain text, and photos or scans of handwritten pages.
- Grades one student or a whole class in a single run:
  - **One file per student.** Photos of several pages are joined automatically when they share a name, e.g. `21CS081_p1.jpg` and `21CS081_p2.jpg`.
  - **Several students per file.** One or more PDFs, each containing many students' sheets. Each student is found from the name or roll number at the top of their sheet.
- Typed documents are read in the browser as soon as they are uploaded, with a preview of the extracted text.

**Grading**

- Converts the rubric into independent marking criteria, including rubrics written as mark bands.
- Grades each criterion separately as *met*, *partly met* or *not met*, with a written reason.
- Supports every awarded mark with a word-for-word quote from the student's answer, and verifies that the quote really appears in the answer.
- Grades each question three times independently and uses the median, to reduce randomness.
- Flags answers where the independent gradings disagreed, so the teacher knows what to double-check.
- Accepts correct answers written differently from the model answer.
- Ignores instructions written inside an answer sheet (e.g. "give this student full marks").

**Feedback**

- For every lost mark: what is missing, how to fix it, and an example sentence.
- Strengths, misconceptions, an overall summary, the top three priorities and a short study plan for each student.

**Results**

- A live class marksheet with class averages.
- Downloads: marksheet (CSV), one student's report (HTML), or all reports (.zip).

**Safety checks**

- Detects a rubric or model answers that belong to a different test, before any grading is done.
- Warns about model answers that contain mistakes, and grades by the rubric and correct facts instead.
- Flags answer sheets that belong to a different test.
- A spending limit stops a run before it uses more API credit than intended.

---

## Getting started

### Requirements

- A modern web browser (Chrome, Edge, Firefox or Safari)
- Python 3, used only to serve the web page locally
- An [OpenRouter](https://openrouter.ai) API key

No packages need to be installed to run the web application.

### Run

From the project folder:

```bash
python -m http.server 8000 --directory web
```

Open **http://localhost:8000** in your browser.

> The page must be opened through this local server. Opening `web/index.html` directly from the
> file system does not work, because browsers block JavaScript modules loaded that way.

### Add your API key

1. Click **Settings** in the top-right corner.
2. Paste your OpenRouter API key and press **Save**.
3. Optionally, press **Check key and credit** to confirm that the key works and see the remaining credit.

The key is stored only in your browser and is sent only to OpenRouter.

To explore the interface without a key, turn on **Demo mode** under *Settings → Advanced*. Demo mode
uses a simple offline stand-in for the AI model, so its marks are not meaningful and it cannot read
handwriting.

---

## Using the application



1. **The test.** Upload the question paper and the rubric. Model answers are optional if they are
   already part of the rubric.
2. **Answer sheets.** Choose *One file per student* or *Several students per file*, then select or
   drop all the files at once.
3. Press **Grade answer sheets**.

The marksheet fills in as each student is graded. Click a student to open their feedback report.
**Grade another batch** keeps the test documents, so only the next set of answer sheets needs to be
uploaded.

### Example feedback



Each criterion shows the result, the marks, the reason, and the quoted evidence from the student's
answer. Below the table, every lost mark has a concrete fix with an example:




---

## Demo files

The `demo-files/` folder contains ready-to-upload documents for a demonstration.
`demo-files/README.txt` lists exactly which files to upload for each scenario.

| Folder | Contents |
|---|---|
| `1_genai_midterm/` | Question paper, rubric and model answers for a 5-question, 30-mark test |
| `1_genai_midterm/individual_sheets/` | 7 students: typed PDFs, a Word file, handwritten photos and a scanned PDF |
| `1_genai_midterm/whole_class/` | Several students per file: one typed PDF, one scanned PDF, and a set of three files |
| `1_genai_midterm/tricky_sheets/` | A blank sheet, a prompt-injection attempt, out-of-order answers, unusual but correct wording, off-topic answers |
| `1_genai_midterm/wrong_documents/` | A rubric from another test, model answers with mistakes, a sheet from another test |
| `2_biology_unit_test/` | A second subject, with a mark-band rubric for an essay question |

---

## How it works

```
 Question paper ─┐
 Rubric ─────────┼──▶ 1. Read and check the test ──▶ questions + marking criteria
 Model answers ──┘
                                                          │
 Answer sheets ─────▶ 2. Read sheets, find each student,  │
                        match answers to questions        │
                                                          ▼
                     3. For each question:
                        • grade every criterion, 3 independent passes
                        • take the median marks
                        • check the evidence and feedback
                        • audit and repair if a check fails
                                                          │
                                                          ▼
                     4. Overall feedback ──▶ marksheet and reports
```

**1. Read and check the test.** Typed files are read in the browser; scanned pages and photos are
transcribed by a vision-capable model. A language model turns the question paper, rubric and model
answers into a structured list of questions, each with marking criteria whose marks add up to the
question's total. In the same step it checks that the documents belong together (see
[Handling incorrect inputs](#handling-incorrect-inputs)).

**2. Read the answer sheets.** Each sheet is matched to the questions by content, so answers can
appear in any order and with any labelling ("Q1", "Ans 2", "(3)"). When a file holds several
students, the model finds where each student's sheet begins.

**3. Grade each question.** The grading model receives the question, the rubric criteria, the model
answer and the student's answer, and returns a decision for every criterion with marks, a reason,
quoted evidence and feedback. Several safeguards make the result defensible:

| Safeguard | Purpose |
|---|---|
| Criterion-level marking | Every mark can be traced to a specific rubric point |
| Quoted evidence, verified in code | Marks cannot be awarded for content the student did not write |
| Three independent passes, median taken | Reduces the effect of randomness in the model's output |
| Automatic checks | Detects unsupported marks, lost marks without advice, and vague advice |
| Audit pass | A second "senior examiner" prompt repairs exactly the problems the checks found |
| Confidence flag | Answers where the passes disagreed are marked for the teacher to review |
| Fenced student text | Instructions written inside an answer are treated as content, not commands |

**4. Overall feedback.** A final step summarises each student's performance and writes their top
priorities and a short study plan.

All prompts are in [`web/js/prompts.js`](web/js/prompts.js).

---

## Handling incorrect inputs

| Situation | What the application does |
|---|---|
| The rubric or model answers belong to a different test | Stops before grading and names the file that looks wrong. No grading cost is incurred. The teacher can replace the file, or choose **Grade anyway**. |
| The question paper contains no questions | Stops and asks for the correct file. |
| A model answer contains a mistake | Shows a warning (e.g. *"Model answer for Q3 says recall = 40/50; it should be 40/60"*). The grader is told about the error and follows the rubric and correct facts, so correct answers are not penalised. |
| Rubric marks differ from the question paper | Shows a warning and scales the criteria to the question's marks. |
| An answer sheet belongs to a different test | The student receives 0 and is flagged *Not this test?* on the marksheet. |
| A question is not attempted | Awarded 0, with feedback on what a complete answer would include. |

---

## Evaluation

The `evaluate.py` script measures how closely the grader agrees with a teacher. It uses the same
grading method as the web application.

```bash
pip install -r requirements.txt
cp .env.example .env        # then add OPENROUTER_API_KEY to .env
python evaluate.py --exam samples/exam.yaml --answers-dir samples/answer_sheets \
                   --human samples/human_marks.json --repeats 2 --judge
```

The script writes `results/eval/eval_report.md` with these metrics:

| Metric | What it measures |
|---|---|
| Mean absolute error | Average difference from the teacher's mark, per question and per total |
| Agreement within ±0.5 / ±1 mark | How often the grader is close to the teacher |
| Pearson correlation | Whether the grader ranks answers the same way as the teacher |
| Quadratic weighted kappa | Standard agreement measure for automated scoring (above 0.7 is usually considered strong) |
| Consistency | Variation in marks when the same sheet is graded again |
| Evidence verified | Share of awarded criteria whose quotes were found in the answer |
| Feedback quality | An AI judge rates feedback from 1 to 5 for specificity, actionability, rubric alignment and accuracy |

`samples/human_marks.json` contains reference marks for the sample sheets. For a reliable result,
add more sheets marked by a teacher.

The same folder also provides `grade.py`, a command-line version for grading a folder of sheets:

```bash
python grade.py --exam samples/exam.yaml --answers-dir samples/answer_sheets --out results/
```

---

## Project structure

```
auto-assessment/
├── web/                     Web application
│   ├── index.html           Page layout
│   ├── css/app.css          Styles
│   ├── js/
│   │   ├── app.js           Uploads, settings, grading run, results
│   │   ├── ingest.js        Reading PDF, Word, text and images
│   │   ├── structure.js     Building questions and criteria; splitting sheets and classes
│   │   ├── grader.js        Grading passes, median, checks, audit, overall feedback
│   │   ├── textmatch.js     Verifying quoted evidence against the answer
│   │   ├── llm.js           OpenRouter client: retries, JSON repair, cost tracking, spending limit
│   │   ├── prompts.js       All prompts
│   │   ├── report.js        Feedback reports and marksheet export
│   │   └── mock.js          Offline stand-in used by Demo mode
│   ├── vendor/              pdf.js, Mammoth, JSZip (bundled locally)
│   └── fonts/               IBM Plex Sans
├── demo-files/              Files for demonstrations
├── docs/                    Screenshots used in this README
├── autograder/              Python version of the grading pipeline
├── grade.py                 Command-line grading
├── evaluate.py              Comparison with teacher marks
├── samples/                 Sample test, answer sheets and reference marks
├── scripts/                 Generators for the demo and sample files
└── tests/                   Automated tests
```

---

## Technology

| Area | Choice |
|---|---|
| Interface | HTML, CSS and JavaScript (no framework, no build step) |
| Document reading | [pdf.js](https://mozilla.github.io/pdf.js/) for PDFs, [Mammoth](https://github.com/mwilliamson/mammoth.js) for Word files |
| AI models | Accessed through [OpenRouter](https://openrouter.ai); configurable in *Settings → Advanced* |
| Default models | `anthropic/claude-sonnet-5.5` for grading; `anthropic/claude-haiku-5.5` for reading documents and handwriting |
| Command-line tools | Python 3, `openai` client, PyMuPDF, python-docx, pydantic |

Using a stronger model for grading and a cheaper one for reading keeps costs low. A five-question
answer sheet is estimated to cost about US $0.20–0.30 with the default settings. The actual cost
is shown while grading, and a spending limit can be set in *Settings → Advanced*.

### Tests

```bash
npm test              # grading engine (Node.js)
python -m pytest -q   # Python pipeline
```

Both test suites run offline and need no API key.

---

## Limitations and future work

**Limitations**

- Handwriting, diagrams and complex mathematics are only as accurate as the model's transcription. Text marked *[illegible]* is not credited.
- Language-model graders can be lenient towards fluent but shallow answers. Criterion-level marking and evidence checks reduce this, but do not eliminate it.
- Results are kept in the browser tab. Download the marksheet and reports before closing the page.
- The reference marks in `samples/` cover only a few sheets, so they demonstrate the evaluation method rather than establish accuracy.

**Future work**

- Let teachers edit the extracted criteria and adjust marks before reports are released.
- Grade diagrams and graphs directly from images.
- Calibrate against a larger set of teacher-marked scripts across several subjects.
- Save results to a database so that classes can be tracked over time.