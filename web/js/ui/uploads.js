/**
 * @file The upload area: four file slots (question paper, rubric, model answers, answer sheets),
 * the sheet-layout switch, and the text preview.
 *
 * Every uploaded file is read locally straight away, so the teacher sees its page and word
 * count (and can preview the text) before any AI is involved.
 */
import { $, esc, toast } from "./dom.js";
import { readLocal, ext, ACCEPT, IMAGE_EXT } from "../browser/ingest.js";
import { groupFiles } from "../core/sheets.js";

/** Files in each slot. */
export const files = { qp: [], rubric: [], model: [], sheets: [] };

/** "individual" = one file per student; "class" = several students per file. */
let mode = "individual";
export const getMode = () => mode;

/** Set by `initUploads`: returns true while grading, when files must not change. */
let isLocked = () => false;

const HINTS = {
  qp: "PDF, Word, text or photo",
  rubric: "Marks per point, or mark bands",
  model: "One answer per question",
  sheets: "Select or drop all the files at once",
};

const ICON_UPLOAD = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V4m0 0L7.5 8.5M12 4l4.5 4.5"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>`;
const ICON_FILE = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>`;
const ICON_IMAGE = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M20.5 16l-5-5-8.5 8.5"/></svg>`;

/** What was read from each file: { state: "reading" | "ok" | "error", pages, scanned, words, text, error }. */
const fileInfo = new WeakMap();

/** Read a file locally (no AI) and redraw its slot when done. */
function inspect(file, slot) {
  if (fileInfo.has(file)) return;
  fileInfo.set(file, { state: "reading" });
  readLocal(file)
    .then((r) => fileInfo.set(file, {
      state: "ok", pages: r.pages.length, scanned: r.scanned, words: r.words,
      text: r.pages.map((p, i) => (!p.image ? p.text
        : p.reason === "broken-text" ? `[Page ${i + 1}: this PDF's text can't be extracted reliably, which is common with Indian-language PDFs. The AI reads the page image when grading.]`
        : `[Page ${i + 1}: scanned or photographed. The AI reads it when grading.]`)).join("\n\n"),
    }))
    .catch((e) => fileInfo.set(file, { state: "error", error: e.message }))
    .finally(() => drawSlot(slot));
}

/** One line describing a file: pages, words, or that it's a scan. */
function fileMeta(file) {
  const i = fileInfo.get(file) || { state: "reading" };
  if (i.state === "reading") return `<span class="meta">Reading…</span>`;
  if (i.state === "error") return `<span class="meta err">${esc(i.error)}</span>`;
  const pages = i.pages > 1 ? `${i.pages} pages` : "1 page";
  if (i.scanned === i.pages) return `<span class="meta">${pages} · read from the page image when grading</span>`;
  return `<span class="meta">${pages} · ${i.words.toLocaleString()} words${i.scanned ? ` · ${i.scanned} read from image` : ""}</span>`;
}

/** Build one slot's drop zone and file list. */
function buildSlot(slot) {
  const key = slot.dataset.slot;
  slot.insertAdjacentHTML("beforeend", `
    <div class="dropzone">
      <input type="file" id="file-${key}" multiple accept="${ACCEPT}" class="visually-hidden">
      <label for="file-${key}">${ICON_UPLOAD}<span class="dz-label">${key === "sheets" ? "Upload answer sheets" : "Upload file"}</span>
      <span class="dz-hint">${HINTS[key]}</span></label>
    </div>
    <ul class="files"></ul>`);

  const input = $("input", slot), zone = $(".dropzone", slot);
  const add = (list) => {
    if (isLocked()) return;
    const accepted = list.filter((f) => ACCEPT.split(",").includes(`.${ext(f.name)}`));
    if (accepted.length < list.length) toast("Some files were skipped. Use PDF, Word (.docx), text or image files.", "error");
    files[key].push(...accepted);
    accepted.forEach((f) => inspect(f, slot));
    drawSlot(slot);
    $("#formError").textContent = "";
  };
  input.addEventListener("change", () => { add([...input.files]); input.value = ""; });
  zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("over"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", (e) => { e.preventDefault(); zone.classList.remove("over"); add([...e.dataTransfer.files]); });
  $(".files", slot).addEventListener("click", (e) => {
    const previewBtn = e.target.closest("button.pv"), removeBtn = e.target.closest("button.x");
    if (previewBtn) preview(files[key][+previewBtn.dataset.i]);
    else if (removeBtn && !isLocked()) { files[key].splice(+removeBtn.dataset.i, 1); drawSlot(slot); }
  });
  drawSlot(slot);
}

/** Redraw a slot's file list. */
function drawSlot(slot) {
  const key = slot.dataset.slot, list = files[key];
  $(".files", slot).innerHTML = list.map((f, i) => `<li>
      <span class="ficon">${IMAGE_EXT.includes(ext(f.name)) ? ICON_IMAGE : ICON_FILE}</span>
      <span class="fname"><span class="fn">${esc(f.name)}</span>${fileMeta(f)}</span>
      ${fileInfo.get(f)?.state === "ok" ? `<button type="button" class="pv" data-i="${i}">Preview</button>` : ""}
      <button type="button" class="x" data-i="${i}" aria-label="Remove ${esc(f.name)}">×</button></li>`).join("")
    + (key === "sheets" && list.length ? `<li class="count">${sheetCount(list)}</li>` : "");
  slot.classList.toggle("filled", list.length > 0);
}

function sheetCount(list) {
  const fileWord = `${list.length} file${list.length === 1 ? "" : "s"}`;
  if (mode !== "individual") return `${fileWord} · students are found when grading starts`;
  const n = groupFiles(list).length;
  return `${fileWord} · ${n} student${n === 1 ? "" : "s"}`;
}

/** Show the text read from a file. */
function preview(file) {
  $("#previewTitle").textContent = file.name;
  $("#previewMeta").innerHTML = fileMeta(file);
  $("#previewText").textContent = fileInfo.get(file)?.text?.trim() || "(no text found)";
  $("#preview").showModal();
}

function drawMode() {
  document.querySelectorAll(".seg button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.mode === mode)));
  $("#modeHint").innerHTML = mode === "individual"
    ? "Each file is one student. Photos of several pages are joined when they share a name, like <code>21CS081_p1.jpg</code> and <code>21CS081_p2.jpg</code>."
    : "One or more PDF or Word files, each holding several students' sheets one after another (for example one scan per section). Upload them all together; each student is found from the name or roll number at the top of their sheet.";
  drawSlot($('[data-slot="sheets"]'));
}

/**
 * Set up the upload area. Call once at start-up.
 * @param {() => boolean} locked Returns true while grading is running.
 */
export function initUploads(locked) {
  isLocked = locked;
  document.querySelectorAll(".slot").forEach(buildSlot);
  $(".seg").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-mode]");
    if (b && !isLocked()) { mode = b.dataset.mode; drawMode(); }
  });
  drawMode();
}

/** Remove the answer sheets but keep the test documents (for grading the next batch). */
export function clearSheets() {
  files.sheets = [];
  drawSlot($('[data-slot="sheets"]'));
}

/** Identifies the current test documents, so a test is only read again when they change. */
export const testKey = () => ["qp", "rubric", "model"]
  .map((k) => files[k].map((f) => `${f.name}:${f.size}:${f.lastModified}`).join("|")).join("#");
