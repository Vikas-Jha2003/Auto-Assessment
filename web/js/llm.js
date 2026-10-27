// OpenRouter client that runs in the browser: JSON parsing/repair, retries, concurrency limit,
// cost tracking and a per-run budget. Uses the user's own key (kept in their browser only).
import { MockBackend } from "./mock.js";

export const OPENROUTER = "https://openrouter.ai/api/v1";

export class BudgetExceeded extends Error {}
export class FatalApiError extends Error {}

export class Usage {
  constructor(budget) {
    this.budget = budget || 0;
    this.calls = 0; this.prompt_tokens = 0; this.completion_tokens = 0; this.cost_usd = 0;
    this.by_task = {};
  }
  check() {
    if (this.budget && this.cost_usd >= this.budget)
      throw new BudgetExceeded(`Spent $${this.cost_usd.toFixed(4)}, the budget limit for this run is $${this.budget.toFixed(2)}. Raise it in Settings and press Resume.`);
  }
  add(task, p, c, cost) {
    this.calls++; this.prompt_tokens += p; this.completion_tokens += c; this.cost_usd += cost;
    const t = (this.by_task[task] ||= { calls: 0, cost_usd: 0 });
    t.calls++; t.cost_usd += cost;
  }
  toJSON() {
    return { calls: this.calls, prompt_tokens: this.prompt_tokens, completion_tokens: this.completion_tokens,
             cost_usd: +this.cost_usd.toFixed(5), by_task: this.by_task };
  }
  static from(obj, budget) {
    const u = new Usage(budget);
    if (obj) Object.assign(u, { calls: obj.calls || 0, prompt_tokens: obj.prompt_tokens || 0,
      completion_tokens: obj.completion_tokens || 0, cost_usd: obj.cost_usd || 0, by_task: obj.by_task || {} });
    return u;
  }
}

class Semaphore {
  constructor(n) { this.n = Math.max(1, n); this.q = []; }
  async acquire() {
    if (this.n > 0) { this.n--; return; }
    await new Promise((r) => this.q.push(r));
  }
  release() { const r = this.q.shift(); r ? r() : this.n++; }
}

export function extractJSON(text) {
  let t = String(text || "").trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  try { return JSON.parse(t); } catch { /* fall through */ }
  const s = t.indexOf("{"), e = t.lastIndexOf("}");
  if (s !== -1 && e > s) return JSON.parse(t.slice(s, e + 1));
  throw new Error("No JSON object found in the model's reply");
}

const sleep = (ms, signal) => new Promise((res, rej) => {
  const id = setTimeout(res, ms);
  signal?.addEventListener("abort", () => { clearTimeout(id); rej(new DOMException("Cancelled", "AbortError")); }, { once: true });
});

export class LLM {
  constructor(settings, { usage, signal } = {}) {
    this.s = settings;
    this.usage = usage || new Usage(settings.budget_usd);
    this.signal = signal;
    this.sem = new Semaphore(settings.max_parallel || 4);
    this.mock = settings.mock ? new MockBackend() : null;
    if (!this.mock && !settings.api_key)
      throw new FatalApiError("No OpenRouter API key. Add it in Settings, or turn on Mock mode to try the app without one.");
  }

  async chat(model, system, user, { task, temperature = 0, json = true, maxTokens = 4000 } = {}) {
    this.usage.check();
    if (this.signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    await this.sem.acquire();
    try {
      if (this.mock) {
        await sleep(30 + Math.random() * 60, this.signal);
        const out = this.mock.respond(task, system, user);
        this.usage.add(task, 0, 0, 0);
        return out;
      }
      const body = { model, messages: [{ role: "system", content: system }, { role: "user", content: user }],
                     temperature, max_tokens: maxTokens, usage: { include: true } };
      if (json) body.response_format = { type: "json_object" };
      let lastErr;
      for (let attempt = 0; attempt < 5; attempt++) {
        let resp;
        try {
          resp = await fetch(`${OPENROUTER}/chat/completions`, {
            method: "POST", signal: this.signal,
            headers: { "Authorization": `Bearer ${this.s.api_key}`, "Content-Type": "application/json",
                       "HTTP-Referer": location.origin, "X-Title": "Auto-Assessment" },
            body: JSON.stringify(body),
          });
        } catch (e) {
          if (e.name === "AbortError") throw e;
          lastErr = e; await sleep(1500 * 2 ** attempt, this.signal); continue;
        }
        const text = await resp.text();
        let data; try { data = JSON.parse(text); } catch { data = null; }
        if (resp.ok && data && !data.error) {
          const u = data.usage || {};
          this.usage.add(task, u.prompt_tokens || 0, u.completion_tokens || 0, Number(u.cost || 0));
          const content = data.choices?.[0]?.message?.content;
          if (content == null) { lastErr = new Error(`Empty reply from ${model}`); continue; }
          return Array.isArray(content) ? content.map((c) => c.text || "").join("") : content;
        }
        const msg = data?.error?.message || text.slice(0, 300) || resp.statusText;
        const code = resp.status || data?.error?.code;
        if (json && body.response_format && /response_format|json/i.test(msg) && code === 400) {
          delete body.response_format; continue;
        }
        if (code === 401) throw new FatalApiError("OpenRouter rejected the API key (401). Check it in Settings.");
        if (code === 402) throw new FatalApiError("Your OpenRouter key is out of credits (402).");
        if (code === 400 || code === 404) throw new FatalApiError(`OpenRouter error for model "${model}": ${msg}`);
        lastErr = new Error(`HTTP ${code}: ${msg}`);
        const wait = code === 429 ? 4000 * (attempt + 1) : 1500 * 2 ** attempt;
        await sleep(wait, this.signal);
      }
      throw new Error(`OpenRouter call failed after retries (${model}): ${lastErr?.message}`);
    } finally {
      this.sem.release();
    }
  }

  async chatJSON(model, system, user, opts = {}) {
    const raw = await this.chat(model, system, user, opts);
    try { return extractJSON(raw); } catch (e) {
      const fix = `Your previous reply was not valid JSON (${e.message}). Reply again with ONLY the corrected JSON object.\n\nPrevious reply:\n${raw.slice(0, 6000)}`;
      const raw2 = await this.chat(model, system, fix, { ...opts, task: opts.task + ":repair", temperature: 0 });
      return extractJSON(raw2);
    }
  }
}

// ---- account helpers (Settings page) ----
export async function checkKey(apiKey) {
  const r = await fetch(`${OPENROUTER}/key`, { headers: { Authorization: `Bearer ${apiKey}` } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error?.message || `HTTP ${r.status}`);
  return d.data || d;
}

export async function listModels() {
  const r = await fetch(`${OPENROUTER}/models`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = await r.json();
  return (d.data || []).map((m) => ({
    id: m.id, name: m.name,
    prompt: Number(m.pricing?.prompt || 0) * 1e6, completion: Number(m.pricing?.completion || 0) * 1e6,
    image: (m.architecture?.input_modalities || []).includes("image"),
    context: m.context_length,
  })).sort((a, b) => a.id.localeCompare(b.id));
}
