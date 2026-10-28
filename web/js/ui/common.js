/**
 * @file UI pieces shared by the grading page and the evaluation page.
 */
import { $ } from "./dom.js";
import { LANGUAGES } from "../core/languages.js";
import { getSettings, updateSettings } from "./settings.js";

/** Fill the feedback-language picker and keep the setting in sync with it. */
export function initLanguagePicker() {
  const select = $("#language");
  select.innerHTML = LANGUAGES.map((l) =>
    `<option value="${l.code}">${l.native && l.native !== l.name ? `${l.name} · ${l.native}` : l.name}</option>`).join("");
  select.value = getSettings().feedback_language;
  select.addEventListener("change", () => updateSettings({ feedback_language: select.value }));
}

/** The notice under the page title: demo mode, or a reminder to add the API key. */
export function drawNotice() {
  const s = getSettings();
  $("#settingsDot").hidden = !!(s.api_key || s.mock);
  const link = `<button type="button" class="linklike" data-open-settings>Settings</button>`;
  $("#notice").innerHTML =
    s.mock ? `<div class="notice warn">Demo mode is on, so marks are not real. Turn it off in ${link} to grade for real.</div>` :
    !s.api_key ? `<div class="notice">You can upload and preview files now; typed PDFs, Word and text files are read in your browser for free. To grade, add your OpenRouter API key in ${link}.</div>` :
    "";
}

/** Disable a form's inputs while work is running. */
export function lockForm(form, locked) {
  form.classList.toggle("locked", locked);
  form.querySelectorAll("input, button, select").forEach((el) => { el.disabled = locked; });
}

/** Check the form before starting. @returns {string} An error message, or "" if ready. */
export function formProblem(files) {
  const s = getSettings();
  if (!s.mock && !s.api_key) return "Add your OpenRouter API key in Settings first.";
  if (!files.qp.length) return "Add the question paper.";
  if (!files.rubric.length) return "Add the rubric.";
  if (!files.sheets.length) return "Add at least one answer sheet.";
  return "";
}
