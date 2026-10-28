/**
 * @file Reads uploaded files in the browser. Implements the pipeline's `DocumentReader`.
 *
 * - Typed PDFs (pdf.js), Word files (Mammoth) and text files are read locally, for free, as soon
 *   as they are uploaded, so the teacher can preview the text without an API key.
 * - Scanned PDF pages and photos have no text layer; they are rendered to an image and read by
 *   the vision model when grading starts. The same happens to pages whose text layer is broken,
 *   which is common in PDFs written in Indian scripts.
 */
import * as pdfjsLib from "../../vendor/pdf.min.mjs";
import { TRANSCRIBE_SYSTEM } from "../core/prompts.js";
import { textLayerLooksBroken } from "../core/textmatch.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("../../vendor/pdf.worker.min.mjs", import.meta.url).href;

/** A PDF page with less text than this is treated as a scan. */
const MIN_CHARS_PER_PAGE = 40;
/** Longest side of images sent to the vision model, in pixels. */
const MAX_IMAGE_SIDE = 2000;

export const IMAGE_EXT = ["png", "jpg", "jpeg", "webp"];
export const ACCEPT = ".pdf,.docx,.txt,.md,.png,.jpg,.jpeg,.webp";
/** File extension in lower case. */
export const ext = (name) => (name.split(".").pop() || "").toLowerCase();

/**
 * @typedef {object} LocalPage
 * @property {string} text                        Text layer ("" for scans and photos).
 * @property {() => Promise<string>} [image]     Renders the page as a JPEG data URL, for pages the vision model must read.
 * @property {"scan" | "broken-text"} [reason]   Why the page needs the vision model.
 *
 * @typedef {object} LocalRead
 * @property {LocalPage[]} pages
 * @property {number} scanned  How many pages need the vision model (scans, photos, broken text layers).
 * @property {number} words    Words in the text layer.
 */

const cache = new WeakMap();

/**
 * Read a file without any AI. Cached per File, so each file is opened once.
 * @param {File} file
 * @returns {Promise<LocalRead>}
 */
export function readLocal(file) {
  if (!cache.has(file)) cache.set(file, extract(file).catch((e) => { cache.delete(file); throw e; }));
  return cache.get(file);
}

async function extract(file) {
  const e = ext(file.name);
  let pages;
  if (e === "txt" || e === "md") {
    pages = [{ text: await file.text() }];
  } else if (e === "docx") {
    if (!window.mammoth) throw new Error("The Word reader is still loading. Try again in a moment.");
    const { value } = await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    pages = [{ text: value }];
  } else if (IMAGE_EXT.includes(e)) {
    pages = [{ text: "", image: () => imageToDataURL(file), reason: "scan" }];
  } else if (e === "pdf") {
    pages = await readPdf(file);
  } else {
    throw new Error(`${file.name}: use PDF, Word (.docx), text or an image.`);
  }
  const typed = pages.map((p) => p.text).join(" ");
  return { pages, scanned: pages.filter((p) => p.image).length, words: (typed.match(/\S+/g) || []).length };
}

/** Text of each PDF page; pages without a text layer get an `image` renderer instead. */
async function readPdf(file) {
  let pdf;
  try { pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise; }
  catch { throw new Error(`${file.name} could not be opened as a PDF.`); }
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    let text = "";
    for (const item of content.items) text += (item.str || "") + (item.hasEOL ? "\n" : " ");
    text = text.replace(/[ \t]+\n/g, "\n").trim();
    const hasText = text.length >= MIN_CHARS_PER_PAGE;
    if (hasText && !textLayerLooksBroken(text)) {
      pages.push({ text });
    } else {
      pages.push({ text: "", reason: hasText ? "broken-text" : "scan", image: async () => {
        const natural = page.getViewport({ scale: 1 });
        const scale = Math.min(2, MAX_IMAGE_SIDE / Math.max(natural.width, natural.height));
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width; canvas.height = viewport.height;
        await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
        return canvas.toDataURL("image/jpeg", 0.85);
      } });
    }
  }
  return pages;
}

/** Shrink a photo to at most MAX_IMAGE_SIDE pixels and return it as a data URL. */
async function imageToDataURL(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.88);
}

/**
 * Ask the vision model to transcribe one page image.
 * @param {import("../core/llm.js").LLM} llm
 * @param {string} dataURL
 * @param {string} label What the page is, e.g. "answer sheet".
 */
export async function transcribe(llm, dataURL, label, pageNo, pageCount) {
  const content = [
    { type: "text", text: `Transcribe page ${pageNo} of ${pageCount} of the ${label}.` },
    { type: "image_url", image_url: { url: dataURL } },
  ];
  return (await llm.chat(llm.s.vision_model, TRANSCRIBE_SYSTEM, content, { task: `transcribe:${label}`, json: false })).trim();
}

/** The `DocumentReader` used by the grading pipeline in the browser. */
export const browserReader = {
  /** Text of each page; scans and photos are transcribed. `onPage(i, n, "transcribing")` reports progress. */
  async readPages(llm, file, label, onPage = () => {}) {
    const { pages } = await readLocal(file);
    const out = [];
    for (let i = 0; i < pages.length; i++) {
      if (!pages[i].image) { out.push(pages[i].text); continue; }
      onPage(i + 1, pages.length, "transcribing");
      out.push(await transcribe(llm, await pages[i].image(), label, i + 1, pages.length));
    }
    return out;
  },
  /** All files' text, in order. */
  async readFilesText(llm, files, label, onPage) {
    const parts = [];
    for (const f of files) parts.push((await this.readPages(llm, f, label, onPage)).join("\n\n"));
    return parts.join("\n\n").trim();
  },
  isPaged: (file) => ext(file.name) === "pdf" || IMAGE_EXT.includes(ext(file.name)),
};
