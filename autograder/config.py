"""Runtime settings, read from environment variables / a .env file."""
from __future__ import annotations

import os
from dataclasses import dataclass, field

from dotenv import load_dotenv

load_dotenv()


def _f(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, default))
    except ValueError:
        return default


@dataclass
class Settings:
    api_key: str = field(default_factory=lambda: os.getenv("OPENROUTER_API_KEY", ""))
    base_url: str = field(default_factory=lambda: os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"))

    # Strong model: does the actual grading + feedback.
    grader_model: str = field(default_factory=lambda: os.getenv("GRADER_MODEL", "anthropic/claude-sonnet-5.5"))
    # Cheap model: structuring documents, splitting the answer sheet, overall summary.
    fast_model: str = field(default_factory=lambda: os.getenv("FAST_MODEL", "anthropic/claude-haiku-5.5"))
    # Vision model: transcribes scanned / handwritten pages.
    vision_model: str = field(default_factory=lambda: os.getenv("VISION_MODEL", "anthropic/claude-haiku-5.5"))

    # Self-consistency: grade each question N times and take the median.
    samples: int = field(default_factory=lambda: int(os.getenv("GRADING_SAMPLES", "3")))
    temperature: float = field(default_factory=lambda: _f("GRADING_TEMPERATURE", 0.4))
    # Spread (max-min of sample totals) above this fraction of max marks -> low confidence.
    disagreement_threshold: float = field(default_factory=lambda: _f("DISAGREEMENT_THRESHOLD", 0.2))
    # Smallest unit of marks that can be awarded.
    mark_step: float = field(default_factory=lambda: _f("MARK_STEP", 0.5))
    # Hard stop on spend for a single run (USD).
    budget_usd: float = field(default_factory=lambda: _f("BUDGET_USD", 2.0))
    max_workers: int = field(default_factory=lambda: int(os.getenv("MAX_WORKERS", "4")))

    mock: bool = field(default_factory=lambda: os.getenv("AUTOGRADER_MOCK", "0") == "1")
