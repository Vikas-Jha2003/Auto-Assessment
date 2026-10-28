"""Generate the Indian-language demo files.

    python scripts/indic_demo.py          (also run by make_demo_files.py)

Pages are written as HTML and rendered by Chromium (via Playwright), which shapes Devanagari and
Tamil correctly and keeps a real text layer in the PDFs. The handwritten sheet is a screenshot in a
handwriting font with a little rotation and blur, like a phone photo.

Creates:
  demo-files/3_hindi_science_test/   a test written in Hindi, with four students:
                                      Hindi (typed), Hinglish (code-mixed), Hindi (handwritten), English
  demo-files/1_genai_midterm/other_languages/   the English GenAI test answered in Hindi and in Tamil
"""
from __future__ import annotations

import html
from pathlib import Path

from PIL import Image, ImageFilter
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "demo-files"
FONTS = ROOT / "web" / "fonts"
ASSETS = ROOT / "scripts" / "assets"

# ---------------------------------------------------------------- content: Hindi science test

HINDI_TITLE = "कक्षा 10 विज्ञान — इकाई परीक्षा"

HINDI_PAPER = [
    "समय: 40 मिनट      पूर्णांक: 12",
    "सभी प्रश्न अनिवार्य हैं।",
    "",
    "प्रश्न 1. (3 अंक) प्रकाश संश्लेषण क्या है? इसका संतुलित रासायनिक समीकरण लिखिए।",
    "प्रश्न 2. (4 अंक) ओम का नियम लिखिए। यदि किसी प्रतिरोधक के सिरों पर 12 V विभवांतर लगाने पर 3 A धारा बहती है, तो उसका प्रतिरोध ज्ञात कीजिए।",
    "प्रश्न 3. (5 अंक) अम्ल और क्षार में दो अंतर लिखिए तथा उदासीनीकरण अभिक्रिया को एक उदाहरण सहित समझाइए।",
]

HINDI_RUBRIC = [
    "अंक योजना — कक्षा 10 विज्ञान",
    "सामान्य निर्देश: सही उत्तर किसी भी भाषा (हिन्दी, अंग्रेज़ी या मिश्रित) में स्वीकार करें। वर्तनी की गलतियों के लिए अंक न काटें।",
    "",
    "प्रश्न 1 [3 अंक]",
    "  • परिभाषा: हरे पौधे सूर्य के प्रकाश व क्लोरोफिल की उपस्थिति में कार्बन डाइऑक्साइड और जल से ग्लूकोज़ बनाते हैं और ऑक्सीजन मुक्त करते हैं — 1.5 अंक",
    "  • संतुलित समीकरण: 6CO₂ + 6H₂O → C₆H₁₂O₆ + 6O₂ (असंतुलित समीकरण पर 0.5 अंक) — 1.5 अंक",
    "प्रश्न 2 [4 अंक]",
    "  • नियम का सही कथन: स्थिर ताप पर धारा विभवांतर के समानुपाती होती है, V = IR — 2 अंक",
    "  • गणना: R = V/I = 12/3 = 4 Ω, सही मात्रक सहित — 2 अंक",
    "प्रश्न 3 [5 अंक]",
    "  • अम्ल और क्षार में पहला सही अंतर (जैसे लिटमस, pH, H⁺/OH⁻ आयन, स्वाद) — 1 अंक",
    "  • दूसरा, भिन्न सही अंतर — 1 अंक",
    "  • उदासीनीकरण की परिभाषा: अम्ल + क्षार → लवण + जल — 1.5 अंक",
    "  • उदाहरण का संतुलित समीकरण, जैसे HCl + NaOH → NaCl + H₂O — 1.5 अंक",
]

HINDI_MODEL = [
    "आदर्श उत्तर",
    "",
    "उत्तर 1. प्रकाश संश्लेषण वह प्रक्रिया है जिसमें हरे पौधे सूर्य के प्रकाश और क्लोरोफिल की सहायता से कार्बन डाइऑक्साइड और जल से ग्लूकोज़ बनाते हैं तथा ऑक्सीजन मुक्त करते हैं।",
    "6CO₂ + 6H₂O → C₆H₁₂O₆ + 6O₂ (सूर्य का प्रकाश, क्लोरोफिल)",
    "उत्तर 2. स्थिर ताप पर किसी चालक में प्रवाहित धारा उसके सिरों के बीच के विभवांतर के समानुपाती होती है: V = IR।",
    "R = V/I = 12 V / 3 A = 4 Ω",
    "उत्तर 3. (i) अम्ल नीले लिटमस को लाल करते हैं, क्षार लाल लिटमस को नीला। (ii) अम्ल जल में H⁺ आयन देते हैं, क्षार OH⁻ आयन; अम्ल का pH 7 से कम, क्षार का 7 से अधिक।",
    "उदासीनीकरण: अम्ल और क्षार की अभिक्रिया से लवण और जल बनते हैं। उदाहरण: HCl + NaOH → NaCl + H₂O",
]

HINDI_SHEETS = {
    "10A01_aarav_hindi.pdf": [
        "नाम: आरव शर्मा      अनुक्रमांक: 10A01",
        "",
        "प्रश्न 1. प्रकाश संश्लेषण वह प्रक्रिया है जिसमें हरे पौधे सूर्य के प्रकाश और क्लोरोफिल की उपस्थिति में कार्बन डाइऑक्साइड और जल से ग्लूकोज़ बनाते हैं तथा ऑक्सीजन मुक्त करते हैं।",
        "समीकरण: 6CO₂ + 6H₂O → C₆H₁₂O₆ + 6O₂",
        "",
        "प्रश्न 2. ओम का नियम: स्थिर ताप पर किसी चालक में बहने वाली धारा उसके सिरों के बीच विभवांतर के समानुपाती होती है, अर्थात V = IR।",
        "R = V/I = 12/3 = 4 ओम (Ω)",
        "",
        "प्रश्न 3. अंतर: (1) अम्ल नीले लिटमस को लाल करते हैं, क्षार लाल लिटमस को नीला करते हैं। (2) अम्ल जल में H⁺ आयन देते हैं, क्षार OH⁻ आयन देते हैं।",
        "उदासीनीकरण: जब अम्ल और क्षार अभिक्रिया करते हैं तो लवण और जल बनते हैं। उदाहरण: HCl + NaOH → NaCl + H₂O",
    ],
    "10A02_sunita_hinglish.pdf": [
        "Name: Sunita Yadav      Roll No: 10A02",
        "",
        "Q1. Photosynthesis woh process hai jisme green plants sunlight ki madad se CO2 aur paani se glucose banate hain aur oxygen release karte hain.",
        "Equation: CO2 + H2O → glucose + O2",
        "",
        "Q2. Ohm ka law kehta hai ki current voltage ke proportional hota hai, V = IR.",
        "R = V/I = 12/3 = 4 ohm",
        "",
        "Q3. Acid khatta hota hai aur base kadwa hota hai. Acid aur base milkar salt aur water banate hain, isko neutralisation kehte hain.",
    ],
    "10A04_meera_english.pdf": [
        "Name: Meera Nair      Roll No: 10A04",
        "",
        "Q1. Photosynthesis is the process by which green plants use sunlight, absorbed by chlorophyll, to make glucose from carbon dioxide and water, releasing oxygen.",
        "6CO₂ + 6H₂O → C₆H₁₂O₆ + 6O₂",
        "",
        "Q2. Ohm's law: at constant temperature, the current through a conductor is directly proportional to the potential difference across it, V = IR.",
        "R = 12 V / 3 A = 4 Ω",
        "",
        "Q3. Acids turn blue litmus red and have a pH below 7; bases turn red litmus blue and have a pH above 7.",
        "Neutralisation is the reaction of an acid with a base to form a salt and water, for example HCl + NaOH → NaCl + H₂O.",
    ],
}

HINDI_HANDWRITTEN = ("10A03_rohit_handwritten.jpg", [
    "नाम: रोहित कुमार    अनुक्रमांक: 10A03",
    "",
    "प्रश्न 1. प्रकाश संश्लेषण में पौधे अपना भोजन बनाते हैं।",
    "",
    "प्रश्न 2. V = IR",
    "R = V × I = 12 × 3 = 36 ओम",
    "",
    "प्रश्न 3. अम्ल खट्टे होते हैं। क्षार कड़वे होते हैं।",
])

HINDI_TEACHER_MARKS = [  # student, Q1, Q2, Q3
    ("आरव शर्मा (10A01)", 3, 4, 5),
    ("Sunita Yadav (10A02)", 2, 4, 2.5),
    ("रोहित कुमार (10A03)", 0.5, 1, 1),
    ("Meera Nair (10A04)", 3, 4, 5),
]

# ---------------------------------------------------------------- content: GenAI test in Hindi / Tamil

GENAI_HINDI = ("21CS091_ishaan_hindi.pdf", [
    "नाम: ईशान वर्मा      अनुक्रमांक: 21CS091",
    "",
    "Q1. ओवरफिटिंग तब होती है जब मॉडल प्रशिक्षण डेटा को, उसके शोर (noise) सहित, रट लेता है। इससे training data पर accuracy बहुत अधिक होती है पर नए test data पर प्रदर्शन खराब होता है।",
    "उपाय: (1) Dropout — प्रशिक्षण के दौरान कुछ न्यूरॉन्स को यादृच्छिक रूप से बंद कर दिया जाता है, जिससे नेटवर्क किसी एक न्यूरॉन पर निर्भर नहीं रहता। (2) Early stopping — जब validation loss बढ़ने लगे तब प्रशिक्षण रोक देते हैं।",
    "",
    "Q2. हर token के embedding को तीन सीखे गए matrices Wq, Wk, Wv से गुणा करके query, key और value vectors बनाए जाते हैं। query और सभी keys का dot product (QK^T) attention scores देता है। इन scores को sqrt(dk) से भाग देकर softmax लगाया जाता है ताकि weights का योग 1 हो। अंत में values का weighted sum output होता है।",
    "Scaling इसलिए ज़रूरी है क्योंकि बड़े dk पर dot products बहुत बड़े हो जाते हैं, softmax saturate हो जाता है और gradients लगभग शून्य हो जाते हैं।",
    "",
    "Q3. Precision = TP/(TP+FP) = 40/50 = 0.8;  Recall = TP/(TP+FN) = 40/60 = 0.67;  F1 = 2PR/(P+R) = 0.73;  Accuracy = (40+30)/100 = 0.7",
    "",
    "Q4. GAN में generator और discriminator एक-दूसरे से प्रतिस्पर्धा (minimax game) करते हैं। Diffusion model में डेटा में धीरे-धीरे Gaussian noise जोड़ा जाता है और network उस noise को हटाना (denoise) सीखता है।",
    "GAN का प्रशिक्षण अस्थिर होता है और mode collapse की समस्या होती है; diffusion का प्रशिक्षण स्थिर है और samples अधिक विविध होते हैं। GAN एक ही forward pass में तेज़ी से image बनाता है, जबकि diffusion को कई steps लगते हैं इसलिए यह धीमा है।",
    "",
    "Q5. RAG में documents को chunks में बाँटकर उनके embeddings एक vector database में रखे जाते हैं। प्रश्न का embedding बनाकर सबसे मिलते-जुलते top-k chunks निकाले जाते हैं और उन्हें prompt में जोड़कर LLM उत्तर देता है।",
    "विफलता 1: गलत या अप्रासंगिक chunks मिलना — hybrid search (BM25 + embeddings) और re-ranker से सुधारें। विफलता 2: LLM फिर भी hallucinate करे — उसे केवल दिए गए context से उत्तर देने और स्रोत बताने का निर्देश दें।",
])

GENAI_TAMIL = ("21CS092_kavin_tamil.pdf", [
    "பெயர்: கவின் குமார்      பதிவு எண்: 21CS092",
    "",
    "Q1. Overfitting என்பது மாதிரி (model) பயிற்சி தரவை (training data) அதன் இரைச்சலுடன் சேர்த்து மனப்பாடம் செய்வதாகும். இதனால் பயிற்சி தரவில் துல்லியம் அதிகமாகவும், புதிய தரவில் குறைவாகவும் இருக்கும்.",
    "தடுக்கும் வழிகள்: regularization மற்றும் அதிக தரவு சேர்த்தல்.",
    "",
    "Q2. ஒவ்வொரு token-இலிருந்தும் query, key, value vectors உருவாக்கப்படுகின்றன. Query மற்றும் key-இன் dot product மூலம் scores கணக்கிடப்பட்டு, softmax மூலம் weights ஆக மாற்றப்படுகின்றன. இந்த weights கொண்டு values-இன் கூட்டுத்தொகை output ஆகும்.",
    "",
    "Q3. Precision = 40/50 = 0.8,  Recall = 40/60 = 0.67,  F1 = 0.73,  Accuracy = 0.7",
    "",
    "Q4. GAN-இல் generator மற்றும் discriminator ஒன்றுக்கொன்று போட்டியிடுகின்றன. Diffusion மாதிரி noise-ஐ படிப்படியாக நீக்கக் கற்றுக்கொள்கிறது. GAN வேகமானது, ஆனால் அதன் பயிற்சி நிலையற்றது. Diffusion மெதுவானது, ஆனால் நிலையானது.",
    "",
    "Q5. RAG-இல் ஆவணங்கள் embeddings ஆக vector database-இல் சேமிக்கப்படுகின்றன. கேள்விக்கு பொருத்தமான பகுதிகள் தேடி எடுக்கப்பட்டு LLM-க்கு கொடுக்கப்படுகின்றன.",
    "ஒரு பிரச்சனை: hallucination — context-இல் உள்ளதை மட்டும் வைத்து பதில் அளிக்கச் சொல்லலாம்.",
])

# ---------------------------------------------------------------- rendering

FONT_CSS = f"""
@font-face {{ font-family: "Noto Sans Devanagari"; src: url("{(FONTS / 'noto-sans-devanagari-devanagari-400-normal.woff2').as_uri()}"); }}
@font-face {{ font-family: "Noto Sans Devanagari"; font-weight: 600; src: url("{(FONTS / 'noto-sans-devanagari-devanagari-600-normal.woff2').as_uri()}"); }}
@font-face {{ font-family: "Noto Sans Tamil"; src: url("{(FONTS / 'noto-sans-tamil-tamil-400-normal.woff2').as_uri()}"); }}
@font-face {{ font-family: "Noto Sans Tamil"; font-weight: 600; src: url("{(FONTS / 'noto-sans-tamil-tamil-600-normal.woff2').as_uri()}"); }}
@font-face {{ font-family: "Plex"; src: url("{(FONTS / 'ibm-plex-sans-latin-400-normal.woff2').as_uri()}"); }}
@font-face {{ font-family: "Plex"; font-weight: 600; src: url("{(FONTS / 'ibm-plex-sans-latin-600-normal.woff2').as_uri()}"); }}
@font-face {{ font-family: "Kalam"; src: url("{(ASSETS / 'kalam-devanagari-400-normal.woff2').as_uri()}"); }}
@font-face {{ font-family: "Kalam"; src: url("{(ASSETS / 'kalam-latin-400-normal.woff2').as_uri()}"); unicode-range: U+0000-00FF, U+2000-206F; }}
"""

DOC_CSS = FONT_CSS + """
@page { size: A4; margin: 22mm 20mm; }
body { font-family: "Plex", "Noto Sans Devanagari", "Noto Sans Tamil", sans-serif; font-size: 11.5pt; line-height: 1.75; color: #111; }
h1 { font-size: 15pt; margin: 0 0 14px; font-weight: 600; }
p { margin: 0 0 6px; }
p.gap { height: 8px; }
"""


def doc_html(lines: list[str], title: str | None = None) -> str:
    body = "".join("<p class=\"gap\"></p>" if not ln else f"<p>{html.escape(ln)}</p>" for ln in lines)
    head = f"<h1>{html.escape(title)}</h1>" if title else ""
    return f'<!doctype html><html><head><meta charset="utf-8"><style>{DOC_CSS}</style></head><body>{head}{body}</body></html>'


def handwritten_html(lines: list[str]) -> str:
    rows = "".join(f'<div class="ln">{html.escape(ln) or "&nbsp;"}</div>' for ln in lines)
    return f"""<!doctype html><html><head><meta charset="utf-8"><style>{FONT_CSS}
    body {{ margin: 0; width: 1240px; height: 1754px; background: #fafaf6;
            background-image: linear-gradient(#c4d2e8 2px, transparent 2px); background-size: 100% 64px; background-position: 0 58px; }}
    .margin {{ position: absolute; left: 140px; top: 0; bottom: 0; width: 2px; background: #e8aaaa; }}
    .page {{ position: absolute; left: 165px; right: 70px; top: 76px; font-family: "Kalam"; font-size: 34px; color: #1c286e; }}
    .ln {{ height: 64px; line-height: 60px; white-space: nowrap; }}
    </style></head><body><div class="margin"></div><div class="page">{rows}</div></body></html>"""


def build() -> None:
    hindi = OUT / "3_hindi_science_test"
    (hindi / "answer_sheets").mkdir(parents=True, exist_ok=True)
    other = OUT / "1_genai_midterm" / "other_languages"
    other.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()

        def pdf(lines, path, title=None):
            page.set_content(doc_html(lines, title), wait_until="load")
            page.evaluate("document.fonts.ready")
            page.pdf(path=str(path), format="A4", print_background=True)

        pdf(HINDI_PAPER, hindi / "question_paper.pdf", HINDI_TITLE)
        pdf(HINDI_RUBRIC, hindi / "rubric.pdf")
        pdf(HINDI_MODEL, hindi / "model_answers.pdf")
        for name, lines in HINDI_SHEETS.items():
            pdf(lines, hindi / "answer_sheets" / name)
        for name, lines in (GENAI_HINDI, GENAI_TAMIL):
            pdf(lines, other / name)

        # handwritten sheet: screenshot, then make it look photographed
        name, lines = HINDI_HANDWRITTEN
        page.set_viewport_size({"width": 1240, "height": 1754})
        page.set_content(handwritten_html(lines), wait_until="load")
        page.evaluate("document.fonts.ready")
        shot = hindi / "answer_sheets" / "_tmp.png"
        page.screenshot(path=str(shot))
        browser.close()

    img = Image.open(shot).convert("RGB").rotate(-0.9, resample=Image.BICUBIC, fillcolor=(232, 232, 226))
    img.filter(ImageFilter.GaussianBlur(0.6)).save(hindi / "answer_sheets" / name, quality=82)
    shot.unlink()

    rows = ["student,Q1,Q2,Q3"] + [",".join(str(x) for x in r) for r in HINDI_TEACHER_MARKS]
    (hindi / "teacher_marks.csv").write_text("\ufeff" + "\n".join(rows) + "\n", encoding="utf-8")


if __name__ == "__main__":
    build()
    print("Indian-language demo files written to", OUT)
