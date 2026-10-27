// Check that an evidence quote really appears in the student's answer (tolerant to small OCR noise).

export function normalise(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[’‘]/g, "'").replace(/[“”]/g, '"')
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function lcs(a, b) {
  const m = a.length, n = b.length;
  let prev = new Array(n + 1).fill(0), cur = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

// word-level similarity of two short word lists, like difflib's ratio
const ratio = (a, b) => (a.length + b.length ? (2 * lcs(a, b)) / (a.length + b.length) : 0);

// fuzzy word match so "memorizes" ~ "memorises"
function wordsClose(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 2 || a.length < 4) return false;
  let diff = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) diff++;
  return diff <= 2;
}

export function bestMatchRatio(quote, text) {
  const q = normalise(quote), t = normalise(text);
  if (!q) return 0;
  if (t.includes(q)) return 1;
  const qw = q.split(" "), tw = t.split(" ");
  if (!tw.length || !tw[0]) return 0;
  let best = 0;
  for (const size of new Set([qw.length, Math.max(1, qw.length - 1), qw.length + 1])) {
    for (let i = 0; i <= Math.max(0, tw.length - size); i++) {
      // map near-identical words onto the quote's spelling before comparing
      const win = tw.slice(i, i + size).map((w, k) => (qw[k] && wordsClose(w, qw[k]) ? qw[k] : w));
      const r = ratio(qw, win);
      if (r > best) { best = r; if (best >= 0.999) return best; }
    }
  }
  return best;
}

export const quoteInText = (quote, text, threshold = 0.8) => bestMatchRatio(quote, text) >= threshold;
