"""Thin OpenRouter client (OpenAI-compatible API) with JSON parsing, retries and cost tracking."""
from __future__ import annotations

import json
import re
import threading
import time
from typing import Any, Dict, List, Optional, Union

from .config import Settings

Content = Union[str, List[Dict[str, Any]]]


class BudgetExceeded(RuntimeError):
    pass


class UsageTracker:
    """Thread-safe running total of tokens and dollars spent."""

    def __init__(self, budget_usd: float):
        self.budget_usd = budget_usd
        self.calls = 0
        self.prompt_tokens = 0
        self.completion_tokens = 0
        self.cost_usd = 0.0
        self.by_task: Dict[str, Dict[str, float]] = {}
        self._lock = threading.Lock()

    def check(self):
        if self.budget_usd and self.cost_usd >= self.budget_usd:
            raise BudgetExceeded(
                f"Spent ${self.cost_usd:.4f}, which reached the BUDGET_USD limit of ${self.budget_usd:.2f}."
            )

    def add(self, task: str, prompt: int, completion: int, cost: float):
        with self._lock:
            self.calls += 1
            self.prompt_tokens += prompt
            self.completion_tokens += completion
            self.cost_usd += cost
            t = self.by_task.setdefault(task, {"calls": 0, "cost_usd": 0.0})
            t["calls"] += 1
            t["cost_usd"] += cost

    def as_dict(self) -> dict:
        return {
            "calls": self.calls,
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "cost_usd": round(self.cost_usd, 5),
            "by_task": {k: {"calls": v["calls"], "cost_usd": round(v["cost_usd"], 5)} for k, v in self.by_task.items()},
        }


def extract_json(text: str) -> Any:
    """Parse JSON from a model reply, tolerating ```json fences and surrounding prose."""
    text = text.strip()
    fence = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
    if fence:
        text = fence.group(1).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    # fall back to the outermost {...} block
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end > start:
        return json.loads(text[start : end + 1])
    raise ValueError("No JSON object found in model output")


class LLMClient:
    def __init__(self, settings: Settings):
        self.s = settings
        self.usage = UsageTracker(settings.budget_usd)
        if settings.mock:
            from .mock import MockBackend

            self._mock = MockBackend()
            self._client = None
        else:
            if not settings.api_key:
                raise RuntimeError(
                    "OPENROUTER_API_KEY is not set. Put it in a .env file (see .env.example) "
                    "or run with --mock to test without an API key."
                )
            from openai import OpenAI

            self._mock = None
            self._client = OpenAI(
                base_url=settings.base_url,
                api_key=settings.api_key,
                default_headers={"X-Title": "Auto-Assessment Grader"},
            )

    # ------------------------------------------------------------------ core
    def chat(self, model: str, system: str, user: Content, *, task: str, temperature: float = 0.0,
             json_mode: bool = True, max_tokens: int = 4000) -> str:
        self.usage.check()
        if self._mock is not None:
            out = self._mock.respond(task, system, user)
            self.usage.add(task, 0, 0, 0.0)
            return out

        messages = [{"role": "system", "content": system}, {"role": "user", "content": user}]
        kwargs: Dict[str, Any] = dict(model=model, messages=messages, temperature=temperature,
                                      max_tokens=max_tokens, extra_body={"usage": {"include": True}})
        if json_mode:
            kwargs["response_format"] = {"type": "json_object"}

        last_err: Optional[Exception] = None
        for attempt in range(4):
            try:
                resp = self._client.chat.completions.create(**kwargs)
                self._record(task, resp)
                if not resp.choices:
                    raise RuntimeError(f"Empty response from {model}")
                return resp.choices[0].message.content or ""
            except Exception as e:  # noqa: BLE001 - surface provider errors after retries
                last_err = e
                msg = str(e)
                # Some providers reject response_format; retry without it.
                if json_mode and "response_format" in msg.lower() and "response_format" in kwargs:
                    kwargs.pop("response_format")
                    continue
                if any(code in msg for code in ("401", "402", "403")):
                    raise  # bad key / out of credits: retrying won't help
                time.sleep(2 ** attempt)
        raise RuntimeError(f"OpenRouter call failed after retries ({model}): {last_err}")

    def chat_json(self, model: str, system: str, user: Content, *, task: str,
                  temperature: float = 0.0, max_tokens: int = 4000) -> dict:
        """Call the model and return parsed JSON, asking it to fix invalid output once."""
        raw = self.chat(model, system, user, task=task, temperature=temperature, max_tokens=max_tokens)
        try:
            return extract_json(raw)
        except Exception as e:  # noqa: BLE001
            fix_user = (
                f"Your previous reply was not valid JSON ({e}). Reply again with ONLY the corrected JSON object.\n\n"
                f"Previous reply:\n{raw[:6000]}"
            )
            raw2 = self.chat(model, system, fix_user, task=task + ":repair", temperature=0.0, max_tokens=max_tokens)
            return extract_json(raw2)

    def _record(self, task: str, resp: Any):
        u = getattr(resp, "usage", None)
        if not u:
            self.usage.add(task, 0, 0, 0.0)
            return
        cost = getattr(u, "cost", None)
        if cost is None and hasattr(u, "model_extra") and u.model_extra:
            cost = u.model_extra.get("cost")
        self.usage.add(task, getattr(u, "prompt_tokens", 0) or 0,
                       getattr(u, "completion_tokens", 0) or 0, float(cost or 0.0))

    # ------------------------------------------------------------- utilities
    def list_models(self) -> List[dict]:
        if self._client is None:
            return []
        data = self._client.models.list()
        return [m.model_dump() for m in data.data]
