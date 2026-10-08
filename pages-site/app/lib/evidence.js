// "Where did this action item come from?" for the static demo - a plain
// JavaScript port of the real app's core/evidence.py. An action item is stored
// with the file it was pulled from, but not with the exact words (the model
// rewrote them into a short task), so this finds the passage of that file that
// most closely matches the task - no model, no network - and says honestly
// when nothing matches well enough.

const MIN_MATCH = 0.34;
const MAX_PASSAGE_CHARS = 420;
const MAX_CONTEXT_CHARS = 180;

const STOPWORDS = new Set([
  "the", "and", "for", "that", "this", "with", "from", "have", "will", "would", "should", "could", "about",
  "into", "their", "there", "they", "them", "then", "than", "what", "when", "which", "while", "your", "you",
  "are", "was", "were", "been", "being", "has", "had", "does", "did", "not", "but", "can", "also", "just",
  "need", "needs", "get", "make", "send", "share", "confirm", "check", "review", "update", "follow",
]);

function wordSet(text) {
  const found = String(text || "").toLowerCase().match(/[a-z0-9']+/g) || [];
  return new Set(found.filter((w) => w.length > 2 && !STOPWORDS.has(w)));
}

function clip(text, limit) {
  const flat = String(text || "").split(/\s+/).filter(Boolean).join(" ");
  if (flat.length <= limit) return flat;
  const cut = flat.slice(0, limit - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).replace(/[ ,;:-]+$/, "")}…`;
}

// The candidate passages of a file: a meeting's speaker turns when it has
// them, otherwise its lines.
function units(file) {
  const turns = file?.meta?.speaker_turns;
  if (Array.isArray(turns) && turns.length) {
    return turns.filter((t) => t.text).map((t) => ({ text: t.text, speaker: t.speaker || "", ts: t.ts || "" }));
  }
  return String(file?.extracted_text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => ({ text: line, speaker: "", ts: "" }));
}

// The passage of `file` that best matches the task `title`, or null.
export function findSupportingPassage(file, title) {
  const titleWords = wordSet(title);
  if (titleWords.size < 2) return null;
  const all = units(file);
  let bestIndex = -1;
  let bestScore = 0;
  all.forEach((unit, i) => {
    const unitWords = wordSet(unit.text);
    if (unitWords.size < 2) return;
    let shared = 0;
    titleWords.forEach((w) => {
      if (unitWords.has(w)) shared += 1;
    });
    const overlap = shared / titleWords.size;
    if (overlap < MIN_MATCH) return;
    if (overlap > bestScore) {
      bestIndex = i;
      bestScore = overlap;
    }
  });
  if (bestIndex < 0) return null;
  const unit = all[bestIndex];
  return {
    text: clip(unit.text, MAX_PASSAGE_CHARS),
    speaker: unit.speaker,
    ts: unit.ts,
    before: bestIndex > 0 ? clip(all[bestIndex - 1].text, MAX_CONTEXT_CHARS) : "",
    after: bestIndex + 1 < all.length ? clip(all[bestIndex + 1].text, MAX_CONTEXT_CHARS) : "",
    score: Math.round(Math.min(bestScore, 1) * 100) / 100,
  };
}
