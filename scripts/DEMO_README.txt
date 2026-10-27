DEMO FILES FOR AUTO-ASSESSMENT
==============================

Upload these on the home page to show the app to an audience.
Before you start: Settings -> paste your OpenRouter API key -> Save.


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


2_biology_unit_test  (3 questions, 15 marks)
--------------------------------------------
Question paper : question_paper.pdf
Rubric         : rubric.pdf   (Q3 is marked in bands like "7-8 marks: ..."; the app turns
                               the bands into criteria that add up to 8)
Model answers  : model_answers.pdf
Answer sheets  : individual_sheets/  (typed PDF, handwritten photo, Word file)


Things worth pointing out to the audience
-----------------------------------------
* "Questions and rubric read from your documents" shows how the rubric was understood.
* Every mark has a quote from the student's own answer next to it.
* Every lost mark has "how to fix it" plus an example sentence.
* A "Check this" flag appears when the grader's independent passes disagreed.
* Download the class marksheet (CSV) or every student's report (.zip).

Handwritten and scanned files need a real API key: demo mode cannot read images.
A 7-student batch with the default settings costs roughly $1-2 of OpenRouter credit.
