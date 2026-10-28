DEMO FILES FOR AUTO-ASSESSMENT
==============================

Upload these on the home page to show the app to an audience.
Before you start: Settings -> paste your OpenRouter API key -> Save.

Suggested three-case demo (diverse scenarios):
  1. Demo A  - a class of typed, Word, handwritten and scanned sheets
  2. Demo E  - a test in Hindi, answered in Hindi, Hinglish, handwriting and English
  3. Demo C or D - adversarial input: a sheet that asks for full marks, or a rubric from another test


1_genai_midterm  (5 questions, 30 marks)
----------------------------------------
Question paper : question_paper.pdf
Rubric         : rubric.pdf
Model answers  : model_answers.pdf

Demo A - individual sheets ("One file per student")
  Upload everything in individual_sheets/ at once (8 files, 7 students):
    21CS042_ananya.pdf          strong typed answers
    21CS057_rahul.pdf           average, with a swapped precision/recall formula
    21CS063_priya.pdf           weak, answers out of order, Q5 not attempted
    21CS071_karan.pdf           good, one weak RAG failure mode
    21CS072_meera.docx          Word file
    21CS081_sneha_p1.jpg + _p2  handwritten photos; the _p1/_p2 names make them one student
    21CS090_rohan_scanned.pdf   scanned handwriting, no text layer

Demo B - several students per file ("Several students per file")
    whole_class/class_of_6_typed.pdf             12 pages, 6 students found by name/roll no.
    whole_class/class_of_3_handwritten_scan.pdf  6 scanned handwritten pages, 3 students
    whole_class/several_files/  upload all 3 files together: 6 students in total
        section_A.pdf                3 students
        section_B.pdf                2 students
        late_submission_scanned.pdf  1 handwritten student (scanned)

Demo C - tricky sheets ("One file per student")
    tricky_sheets/asks_ai_for_full_marks.pdf      tells the AI to give full marks; it should not
    tricky_sheets/blank_sheet.pdf                 should get 0 with advice on what to write
    tricky_sheets/answers_out_of_order.pdf        "Ans-5)", "2)", "Q.1", "(3)" labels
    tricky_sheets/correct_but_unusual_wording.pdf correct ideas in different words; should score well
    tricky_sheets/off_topic_answers.pdf           fluent but irrelevant; should score low


Demo D - wrong documents (the app checks the documents before grading)
    wrong_documents/rubric_from_biology_test.pdf
        Use it as the Rubric with the GenAI question paper. Grading stops before it starts
        and says the rubric doesn't belong to this question paper. Nothing is spent on grading.
    wrong_documents/model_answers_with_mistakes.pdf
        Use it as the Model answers. Q1 defines underfitting instead of overfitting and Q3 has the
        wrong recall. The app warns about both and grades by the rubric and correct facts, so
        students with the right answer are not marked down.
    wrong_documents/answer_sheet_from_biology_test.pdf
        Add it with the individual sheets. It gets 0 and is flagged "Not this test?".


Demo F - the English test answered in Indian languages ("One file per student")
    other_languages/21CS091_ishaan_hindi.pdf   a strong answer written in Hindi
    other_languages/21CS092_kavin_tamil.pdf    a middling answer written in Tamil
        Set "Feedback language" to "Same as the student's answer": each student gets feedback
        in their own language, and the report headings follow it.

teacher_marks.csv - reference marks for every student above, for the evaluation page
                    (evaluate.html). Assigned by hand using the rubric.


2_biology_unit_test  (3 questions, 15 marks)
--------------------------------------------
Question paper : question_paper.pdf
Rubric         : rubric.pdf   (Q3 is marked in bands like "7-8 marks: ..."; the app turns
                               the bands into criteria that add up to 8)
Model answers  : model_answers.pdf
Answer sheets  : individual_sheets/  (typed PDF, handwritten photo, Word file)


3_hindi_science_test  (3 questions, 12 marks, written in Hindi)
------------------------------------------------------------------
Demo E
Question paper : question_paper.pdf     (Hindi)
Rubric         : rubric.pdf             (Hindi)
Model answers  : model_answers.pdf      (Hindi)
Answer sheets  : answer_sheets/  upload all four
    10A01_aarav_hindi.pdf          strong, in Hindi
    10A02_sunita_hinglish.pdf      Hindi in Latin script mixed with English (Hinglish)
    10A03_rohit_handwritten.jpg    handwritten Hindi photo; R = V x I mistake
    10A04_meera_english.pdf        answered in English
teacher_marks.csv                  reference marks for the evaluation page

These PDFs have the broken text layer that is common in Indian-language PDFs. The app
detects this ("read from the page image when grading") and reads them with the vision model.


Things worth pointing out to the audience
-----------------------------------------
* "Questions and rubric read from your documents" shows how the rubric was understood.
* Every mark has a quote from the student's own answer next to it.
* Every lost mark has "how to fix it" plus an example sentence.
* A "Check this" flag appears when the grader's independent passes disagreed.
* Download the class marksheet (CSV) or every student's report (.zip).

* Feedback can be in the student's own language (Feedback language next to the Grade button).

Handwritten, scanned and Indian-language PDF files need a real API key: demo mode cannot read images.
A 7-student batch with the default settings costs roughly $1-2 of OpenRouter credit.
