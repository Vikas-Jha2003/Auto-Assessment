"""Check that an evidence quote really appears in the student's answer (tolerant to small OCR noise)."""
from __future__ import annotations

import re
from difflib import SequenceMatcher

_ws = re.compile(r"\s+")
_punct = re.compile(r"[^\w\s]")


def normalise(s: str) -> str:
    s = s.lower().replace("’", "'").replace("“", '"').replace("”", '"')
    s = _punct.sub(" ", s)
    return _ws.sub(" ", s).strip()


def best_match_ratio(quote: str, text: str) -> float:
    q, t = normalise(quote), normalise(text)
    if not q:
        return 0.0
    if q in t:
        return 1.0
    qw, tw = q.split(), t.split()
    n = len(qw)
    if n == 0 or not tw:
        return 0.0
    best = 0.0
    for size in {n, max(1, n - 1), n + 1}:
        for i in range(0, max(1, len(tw) - size + 1)):
            r = SequenceMatcher(None, qw, tw[i : i + size]).ratio()
            if r > best:
                best = r
                if best >= 0.999:
                    return best
    return best


def quote_in_text(quote: str, text: str, threshold: float = 0.8) -> bool:
    return best_match_ratio(quote, text) >= threshold
