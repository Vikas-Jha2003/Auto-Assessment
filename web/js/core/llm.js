/**
 * @file OpenRouter client used by every step of the pipeline.
 *
 * Responsibilities:
 * - send chat requests (text, or text + images) to OpenRouter's OpenAI-compatible API;
 * - parse JSON replies, asking the model once to repair invalid JSON;
 * - retry transient failures with back-off, and fail fast on errors that retrying can't fix;
 * - limit how many requests run at once;
 * - track tokens and cost, and stop when the run's spending limit is reached.
 *
 * Works in the browser and in Node 18+ (both provide `fetch`).
 */
import { MockBackend } from "./mock.js";

export const OPENROUTER_URL = "https://openrouter.ai/api/v1";

/** Thrown when a run reaches its spending limit. */
export class BudgetExceeded extends Error {}

/** Thrown for errors that retrying cannot fix (bad key, no credit, unknown model). */
export class FatalApiError extends Error {}

/**
 * Running total of API usage for one grading run.
 */
export class Usage {
  /** @param {number} budgetUsd Spending limit in US dollars (0 = no limit). */
  constructor(budgetUsd = 0) {
    this.budget = budgetUsd;
    this.calls = 0;
    this.promptTokens = 0;
    this.completionTokens = 0;
    this.costUsd = 0;
  }

  /** @throws {BudgetExceeded} when the limit has been reached. */
  check() {
    if (this.budget && this.costUsd >= this.budget) {
      throw new BudgetExceeded(
        `Spent $${this.costUsd.toFixed(4)}, which reached this run's spending limit of $${this.budget.toFixed(2)}. ` +
        "Raise the spending limit in Settings, then press Continue.");
    }
  }

  /** Record one completed call. */
  add(promptTokens, completionTokens, costUsd) {
    this.calls += 1;
    this.promptTokens += promptTokens;
    this.completionTokens += completionTokens;
    this.costUsd += costUsd;
  }
}

/** Counting semaphore: at most `n` holders at a time. */
class Semaphore {
  constructor(n) { this.free = Math.max(1, n); this.waiting = []; }
  async acquire() {
    if (this.free > 0) { this.free -= 1; return; }
    await new Promise((resolve) => this.waiting.push(resolve));
  }
  release() {
    const next = this.waiting.shift();
    if (next) next(); else this.free += 1;
  }
}

/**
 * Parse a JSON object from a model reply, tolerating ```json fences and text around the object.
 * @param {string} text
 * @returns {any}
 */
export function extractJSON(text) {
  let t = String(text || "").trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  try { return JSON.parse(t); } catch { /* fall through to the outermost {...} */ }
  const start = t.indexOf("{"), end = t.lastIndexOf("}");
  if (start !== -1 && end > start) return JSON.parse(t.slice(start, end + 1));
  throw new Error("No JSON object found in the model's reply");
}

/** Promise-based sleep that rejects early if the signal aborts. */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const id = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(id); reject(new DOMException("Cancelled", "AbortError")); }, { once: true });
  });
}

/**
 * @typedef {object} LLMSettings
 * @property {string} api_key        OpenRouter API key.
 * @property {boolean} [mock]        Use the offline stand-in instead of a real model.
 * @property {number} [max_parallel] Maximum concurrent requests (default 4).
 * @property {number} [budget_usd]   Spending limit for the run.
 */

/** A rate-limited, cost-tracking OpenRouter client. */
export class LLM {
  /**
   * @param {LLMSettings & Record<string, any>} settings Pipeline settings (models, samples, ...).
   * @param {{ usage?: Usage, signal?: AbortSignal }} [options]
   */
  constructor(settings, { usage, signal } = {}) {
    this.s = settings;
    this.usage = usage || new Usage(settings.budget_usd);
    this.signal = signal;
    this.limiter = new Semaphore(settings.max_parallel || 4);
    this.mock = settings.mock ? new MockBackend() : null;
    if (!this.mock && !settings.api_key) {
      throw new FatalApiError("No OpenRouter API key. Add it in Settings, or turn on Demo mode to try the app without one.");
    }
  }

  /**
   * Send one chat request and return the reply text.
   * @param {string} model OpenRouter model id.
   * @param {string} system System prompt.
   * @param {string | object[]} user User message: text, or OpenAI-style content parts (for images).
   * @param {{ task?: string, temperature?: number, json?: boolean, maxTokens?: number }} [options]
   *   `task` names the pipeline step (used by Demo mode); `json` requests a JSON object reply.
   * @returns {Promise<string>}
   */
  async chat(model, system, user, { task = "", temperature = 0, json = true, maxTokens = 4000 } = {}) {
    this.usage.check();
    if (this.signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    await this.limiter.acquire();
    try {
      if (this.mock) {
        await sleep(30 + Math.random() * 60, this.signal);
        this.usage.add(0, 0, 0);
        return this.mock.respond(task, system, user);
      }
      return await this.#request(model, system, user, { temperature, json, maxTokens });
    } finally {
      this.limiter.release();
    }
  }

  /** The HTTP part of `chat`, with retries. */
  async #request(model, system, user, { temperature, json, maxTokens }) {
    const body = {
      model, temperature, max_tokens: maxTokens, usage: { include: true },
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    };
    if (json) body.response_format = { type: "json_object" };
    const headers = { Authorization: `Bearer ${this.s.api_key}`, "Content-Type": "application/json", "X-Title": "Auto-Assessment" };
    if (globalThis.location?.origin?.startsWith("http")) headers["HTTP-Referer"] = globalThis.location.origin;

    let lastError;
    for (let attempt = 0; attempt < 5; attempt++) {
      let resp;
      try {
        resp = await fetch(`${OPENROUTER_URL}/chat/completions`, { method: "POST", signal: this.signal, headers, body: JSON.stringify(body) });
      } catch (e) {
        if (e.name === "AbortError") throw e;
        lastError = e;                                  // network error: wait and retry
        await sleep(1500 * 2 ** attempt, this.signal);
        continue;
      }
      const text = await resp.text();
      let data = null;
      try { data = JSON.parse(text); } catch { /* not JSON: handled below */ }

      if (resp.ok && data && !data.error) {
        const u = data.usage || {};
        this.usage.add(u.prompt_tokens || 0, u.completion_tokens || 0, Number(u.cost || 0));
        const content = data.choices?.[0]?.message?.content;
        if (content == null) { lastError = new Error(`Empty reply from ${model}`); continue; }
        return Array.isArray(content) ? content.map((part) => part.text || "").join("") : content;
      }

      const message = data?.error?.message || text.slice(0, 300) || resp.statusText;
      const status = resp.status;
      if (json && body.response_format && status === 400 && /response_format|json/i.test(message)) {
        delete body.response_format;                    // some providers don't support JSON mode
        continue;
      }
      if (status === 401) throw new FatalApiError("OpenRouter rejected the API key (401). Check it in Settings.");
      if (status === 402) throw new FatalApiError("Your OpenRouter key is out of credit (402).");
      if (status === 400 || status === 404) throw new FatalApiError(`OpenRouter error for model "${model}": ${message}`);
      lastError = new Error(`HTTP ${status}: ${message}`);
      await sleep(status === 429 ? 4000 * (attempt + 1) : 1500 * 2 ** attempt, this.signal);
    }
    throw new Error(`OpenRouter call failed after retries (${model}): ${lastError?.message}`);
  }

  /**
   * Like `chat`, but parses the reply as JSON. If the reply isn't valid JSON, the model is asked
   * once to correct it.
   * @returns {Promise<any>}
   */
  async chatJSON(model, system, user, options = {}) {
    const raw = await this.chat(model, system, user, options);
    try {
      return extractJSON(raw);
    } catch (e) {
      const fix = `Your previous reply was not valid JSON (${e.message}). Reply again with ONLY the corrected JSON object.\n\n` +
        `Previous reply:\n${raw.slice(0, 6000)}`;
      return extractJSON(await this.chat(model, system, fix, { ...options, task: `${options.task}:repair`, temperature: 0 }));
    }
  }
}

/** True for errors that should stop the whole run rather than fail one sheet. */
export const isStopError = (e) => e?.name === "AbortError" || e instanceof BudgetExceeded || e instanceof FatalApiError;

/**
 * Check an API key and return its usage and limit, for the Settings dialog.
 * @param {string} apiKey
 * @returns {Promise<{ usage?: number, limit?: number | null, limit_remaining?: number }>}
 */
export async function checkKey(apiKey) {
  const r = await fetch(`${OPENROUTER_URL}/key`, { headers: { Authorization: `Bearer ${apiKey}` } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error?.message || `HTTP ${r.status}`);
  return d.data || d;
}
