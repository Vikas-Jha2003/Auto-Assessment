// Read uploaded files in the browser.
// Typed PDFs, Word files and text are read right here, for free, with no API key.
// Only scanned pages and photos need the AI model to read the handwriting.
import * as pdfjsLib from "../vendor/pdf.min.mjs";
import { TRANSCRIBE_SYSTEM } from "./prompts.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("../vendor/pdf.worker.min.mjs", import.meta.url).href;

const MIN_CHARS_PER_PAGE = 40;
const MAX_IMAGE_SIDE = 2000;
export const IMAGE_EXT = ["png", "jpg", "jpeg", "webp"];
export const ACCEPT = ".pdf,.docx,.txt,.md,.png,.jpg,.jpeg,.webp";
export const ext = (name) => (name.split(".").pop() || "").toLowerCase();

function blobToDataURL(blob) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
}

async function shrinkImage(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bmp.width, bmp.height));
  if (scale === 1 && file.size < 1.5e6) return blobToDataURL(file);
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.88);
}

/**
 * Read a file locally (no AI). Returns { pages: [{ text, image? }], scanned, words }.
 * A page with `image` is a scan or photo: `image()` renders it for the AI to read later.
 * Results are cached per File, so a file is only opened once.
 */
const cache = new WeakMap();
export function readLocal(file) {
  if (!cache.has(file)) cache.set(file, extract(file).catch((e) => { cache.delete(file); throw e; }));
  return cache.get(file);
}

async function extract(file) {
  const e = ext(file.name);
  let pages;
  if (["txt", "md"].includes(e)) pages = [{ text: await file.text() }];
  else if (e === "docx") {
    if (!window.mammoth) throw new Error("The Word reader is still loading. Try again in a moment.");
    const { value } = await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    pages = [{ text: value }];
  } else if (IMAGE_EXT.includes(e)) pages = [{ text: "", image: () => shrinkImage(file) }];
  else if (e === "pdf") {
    let pdf;
    try { pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise; }
    catch { throw new Error(`${file.name} could not be opened as a PDF.`); }
    pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const tc = await page.getTextContent();
      let text = "";
      for (const it of tc.items) text += (it.str || "") + (it.hasEOL ? "\n" : " ");
      text = text.replace(/[ \t]+\n/g, "\n").trim();
      if (text.length >= MIN_CHARS_PER_PAGE) pages.push({ text });
      else pages.push({ text: "", image: async () => {
        const vp = page.getViewport({ scale: 1 });
        const scale = Math.min(2, MAX_IMAGE_SIDE / Math.max(vp.width, vp.height));
        const v = page.getViewport({ scale });
        const c = document.createElement("canvas"); c.width = v.width; c.height = v.height;
        await page.render({ canvasContext: c.getContext("2d"), viewport: v }).promise;
        return c.toDataURL("image/jpeg", 0.85);
      } });
    }
  } else throw new Error(`${file.name}: use PDF, Word (.docx), text or an image.`);
  const typed = pages.map((p) => p.text).join(" ");
  return { pages, scanned: pages.filter((p) => p.image).length, words: (typed.match(/\S+/g) || []).length };
}

export async function transcribe(llm, dataURL, label, pageNo, pageCount) {
  const content = [{ type: "text", text: `Transcribe page ${pageNo} of ${pageCount} of the ${label}.` },
                   { type: "image_url", image_url: { url: dataURL } }];
  const t = await llm.chat(llm.s.vision_model, TRANSCRIBE_SYSTEM, content, { task: `transcribe:${label}`, json: false });
  return t.trim();
}

/** Page texts of a file; scanned pages and photos are read by the AI. `onPage(i, n, how)` reports progress. */
export async function readPages(llm, file, label, onPage = () => {}) {
  const { pages } = await readLocal(file);
  const out = [];
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    if (!p.image) { out.push(p.text); continue; }
    onPage(i + 1, pages.length, "transcribing");
    out.push(await transcribe(llm, await p.image(), label, i + 1, pages.length));
  }
  return out;
}

export async function readFilesText(llm, files, label, onPage) {
  const out = [];
  for (const f of files) out.push((await readPages(llm, f, label, onPage)).join("\n\n"));
  return out.join("\n\n").trim();
}
