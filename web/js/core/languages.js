/**
 * @file Languages the feedback can be written in.
 *
 * Students may answer in any language or script; the grader judges content, not language.
 * This list only controls the language of the *feedback*. "auto" means "the language the
 * student wrote in", which is the default.
 */

/** @typedef {{ code: string, name: string, native: string }} Language */

/** @type {Language[]} */
export const LANGUAGES = [
  { code: "auto", name: "Same as the student's answer", native: "" },
  { code: "English", name: "English", native: "English" },
  { code: "Hindi", name: "Hindi", native: "हिन्दी" },
  { code: "Bengali", name: "Bengali", native: "বাংলা" },
  { code: "Marathi", name: "Marathi", native: "मराठी" },
  { code: "Tamil", name: "Tamil", native: "தமிழ்" },
  { code: "Telugu", name: "Telugu", native: "తెలుగు" },
  { code: "Kannada", name: "Kannada", native: "ಕನ್ನಡ" },
  { code: "Malayalam", name: "Malayalam", native: "മലയാളം" },
  { code: "Gujarati", name: "Gujarati", native: "ગુજરાતી" },
  { code: "Punjabi", name: "Punjabi", native: "ਪੰਜਾਬੀ" },
  { code: "Odia", name: "Odia", native: "ଓଡ଼ିଆ" },
  { code: "Urdu", name: "Urdu", native: "اردو" },
];

/**
 * Describe the target feedback language in words a model can follow.
 * @param {string} code A `LANGUAGES` code.
 * @returns {string}
 */
export function feedbackLanguageInstruction(code) {
  if (!code || code === "auto") {
    return "the same language the student mainly wrote the answer in, in that language's usual script " +
      "(for code-mixed answers such as Hinglish, use the language of most of the words; if the answer is empty, use the language of the question)";
  }
  return code;
}
