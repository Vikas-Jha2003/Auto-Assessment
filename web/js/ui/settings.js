/**
 * @file User settings: stored in this browser (localStorage) and edited in the Settings dialog.
 *
 * The API key never leaves the browser except in requests to OpenRouter.
 */
import { $, money, toast } from "./dom.js";
import { checkKey } from "../core/llm.js";
import { PIPELINE_DEFAULTS } from "../core/pipeline.js";

const STORAGE_KEY = "aa.settings";

/**
 * @typedef {object} Settings
 * @property {string} api_key
 * @property {string} grader_model
 * @property {string} reading_model      For documents and handwriting; must accept images.
 * @property {number} samples            Independent grading passes per answer.
 * @property {number} budget_usd         Spending limit per run.
 * @property {string} feedback_language  A `LANGUAGES` code ("auto" = the student's language).
 * @property {boolean} mock              Demo mode: no API calls, fake marks.
 */

/** @type {Settings} */
const DEFAULTS = {
  api_key: "",
  grader_model: PIPELINE_DEFAULTS.grader_model,
  reading_model: PIPELINE_DEFAULTS.reading_model,
  samples: PIPELINE_DEFAULTS.samples,
  budget_usd: PIPELINE_DEFAULTS.budget_usd,
  feedback_language: PIPELINE_DEFAULTS.feedback_language,
  mock: false,
};

let current = load();
const listeners = [];

function load() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") }; }
  catch { return { ...DEFAULTS }; }
}

/** The current settings. @returns {Settings} */
export const getSettings = () => current;

/** Change some settings and save them. */
export function updateSettings(patch) {
  current = { ...current, ...patch };
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(current)); } catch { /* storage blocked: keep for this visit */ }
  listeners.forEach((fn) => fn(current));
}

/** Run `fn` whenever settings change. */
export const onSettingsChange = (fn) => listeners.push(fn);

// ------------------------------------------------------------------ dialog

const dialog = () => $("#settings");

/** Open the Settings dialog with the current values. */
export function openSettings() {
  const s = current;
  $("#apiKey").value = s.api_key;
  $("#apiKey").type = "password";
  $("#showKey").textContent = "Show";
  $("#graderModel").value = s.grader_model;
  $("#readingModel").value = s.reading_model;
  $("#samples").value = s.samples;
  $("#budget").value = s.budget_usd;
  $("#mock").checked = s.mock;
  $("#keyMsg").textContent = "";
  dialog().showModal();
  if (!s.api_key) $("#apiKey").focus();
}

/** The values currently in the dialog, validated. */
function readDialog() {
  return {
    api_key: $("#apiKey").value.trim(),
    grader_model: $("#graderModel").value.trim() || DEFAULTS.grader_model,
    reading_model: $("#readingModel").value.trim() || DEFAULTS.reading_model,
    samples: Math.min(5, Math.max(1, Math.round(+$("#samples").value || DEFAULTS.samples))),
    budget_usd: Math.max(0.1, +$("#budget").value || DEFAULTS.budget_usd),
    mock: $("#mock").checked,
  };
}

/** Wire up the dialog's buttons. Call once at start-up. */
export function initSettingsDialog() {
  $("#openSettings").addEventListener("click", openSettings);
  document.addEventListener("click", (e) => { if (e.target.closest("[data-open-settings]")) openSettings(); });

  $("#showKey").addEventListener("click", () => {
    const input = $("#apiKey");
    input.type = input.type === "password" ? "text" : "password";
    $("#showKey").textContent = input.type === "password" ? "Show" : "Hide";
  });

  $("#checkKey").addEventListener("click", async () => {
    const key = $("#apiKey").value.trim(), msg = $("#keyMsg");
    if (!key) { msg.textContent = "Paste a key first."; return; }
    msg.textContent = "Checking…";
    try {
      const d = await checkKey(key);
      const used = Number(d.usage || 0), limit = d.limit == null ? null : Number(d.limit);
      msg.textContent = limit != null
        ? `The key works. ${money(d.limit_remaining ?? limit - used)} of ${money(limit)} left.`
        : `The key works. Used ${money(used)} so far.`;
    } catch (e) {
      msg.textContent = `This key didn't work: ${e.message}`;
    }
  });

  dialog().addEventListener("close", () => {
    if (dialog().returnValue !== "save") return;
    updateSettings(readDialog());
    toast("Settings saved.", "ok", 2000);
  });
}
