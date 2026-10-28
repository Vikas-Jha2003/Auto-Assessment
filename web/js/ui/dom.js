/**
 * @file Small helpers shared by the UI modules.
 */

/** `document.querySelector` shorthand. */
export const $ = (selector, root = document) => root.querySelector(selector);

/** Escape text for safe insertion into HTML. */
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Format a mark without trailing zeros: 2.50 -> "2.5". */
export const fmt = (n) => String(+(+n).toFixed(2));

/** Format US dollars; small amounts keep four decimals. */
export const money = (x) => (x > 0 && x < 0.01 ? `$${x.toFixed(4)}` : `$${(x || 0).toFixed(2)}`);

/** A string that is safe as a file name (keeps letters of any script). */
export const safeName = (s) => String(s || "file").replace(/[^\p{L}\p{M}\p{N}.-]+/gu, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "file";

/**
 * Show a short message in the corner of the screen.
 * @param {string} message
 * @param {"info" | "ok" | "error"} [kind]
 */
export function toast(message, kind = "info", ms = 4000) {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.setAttribute("role", "status");
  el.textContent = message;
  $("#toasts").append(el);
  setTimeout(() => el.remove(), ms);
}

/** Save `content` as a file in the user's downloads. */
export function download(name, content, type = "text/plain") {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
