/**
 * @file Checks that an evidence quote really appears in the student's answer.
 *
 * The grader must support every mark with a word-for-word quote. Models sometimes paraphrase or
 * invent quotes, so each quote is matched against the answer here, in code. Matching is tolerant
 * of small differences (punctuation, case, a misspelt word, OCR noise) and works for every script:
 * Unicode letters, combining marks (Indic vowel signs) and digits are kept.
 */

/**
 * Normalise text for comparison: Unicode NFC, lower case, no zero-width characters,
 * punctuation turned into spaces, single spaces.
 * @param {string} s
 * @returns {string}
 */
export function normalise(s) {
  return String(s || "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/[’‘]/g, "'").replace(/[“”]/g, '"')
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Length of the longest common subsequence of two word lists. */
function lcs(a, b) {
  let prev = new Array(b.length + 1).fill(0);
  let cur = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/** Similarity of two word lists from 0 to 1 (like Python's difflib ratio). */
const similarity = (a, b) => (a.length + b.length ? (2 * lcs(a, b)) / (a.length + b.length) : 0);

/** Treat words as equal when they differ by at most two characters ("memorizes" vs "memorises"). */
function nearlySameWord(a, b) {
  if (a === b) return true;
  const x = [...a], y = [...b];
  if (Math.abs(x.length - y.length) > 2 || x.length < 4) return false;
  let diff = 0;
  for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) diff++;
  return diff <= 2;
}

/**
 * How well `quote` matches the best window of `text`, from 0 to 1.
 * @param {string} quote
 * @param {string} text
 * @returns {number}
 */
export function bestMatchRatio(quote, text) {
  const q = normalise(quote), t = normalise(text);
  if (!q) return 0;
  if (t.includes(q)) return 1;
  const qWords = q.split(" "), tWords = t.split(" ");
  if (!tWords[0]) return 0;
  let best = 0;
  for (const size of new Set([qWords.length, Math.max(1, qWords.length - 1), qWords.length + 1])) {
    for (let i = 0; i <= Math.max(0, tWords.length - size); i++) {
      // map near-identical words onto the quote's spelling before comparing
      const window = tWords.slice(i, i + size).map((w, k) => (qWords[k] && nearlySameWord(w, qWords[k]) ? qWords[k] : w));
      best = Math.max(best, similarity(qWords, window));
      if (best >= 0.999) return best;
    }
  }
  return best;
}

/**
 * True if `quote` appears in `text` closely enough to count as verbatim evidence.
 * @param {string} quote
 * @param {string} text
 * @param {number} [threshold=0.8]
 */
export const quoteInText = (quote, text, threshold = 0.8) => bestMatchRatio(quote, text) >= threshold;

/**
 * True if a PDF's text layer is too broken to trust, so the page should be read from its image.
 *
 * PDF text extraction often fails for Indian scripts: characters come out in visual instead of
 * logical order (e.g. the vowel sign "ि" before its consonant), glyphs map to NUL or private-use
 * characters, and legacy fonts produce Latin gibberish. A word can never begin with a combining
 * mark in correctly encoded text, which makes this easy to detect.
 * @param {string} text
 * @returns {boolean}
 */
export function textLayerLooksBroken(text) {
  const chars = [...text];
  if (!chars.length) return false;
  const unmapped = chars.filter((c) => /[\u0000\ufffd\ue000-\uf8ff]/u.test(c)).length;
  if (unmapped / chars.length > 0.005) return true;
  const indicWords = text.split(/\s+/).filter((w) => /[\u0900-\u0dff]/u.test(w));
  if (indicWords.length < 5) return false;
  const startsWithMark = indicWords.filter((w) => /^\p{M}/u.test(w)).length;
  return startsWithMark / indicWords.length > 0.03;
}
