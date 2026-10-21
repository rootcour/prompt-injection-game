// =============================================================================
// words.js: reads the list of possible passwords
// =============================================================================
//
// The words themselves are NOT in this repo. They live in a Worker secret named
// WORD_LIST, so players can't open GitHub and narrow the password down from a
// public list. Each day, each level picks one word from that list (see
// derivePassword in security.js).
//
// WORD_LIST format: words separated by commas, spaces or new lines, for example
//   ALMANAC, BAGPIPE, CANTEEN, ...
// Case doesn't matter; words are uppercased here.
//
// Rules for the words (anything that breaks them is skipped):
//   - Letters only. The guess checker strips everything except letters, so
//     spaces or punctuation in a word would break matching.
//   - 6 to 10 letters. Short words show up by accident in normal replies, which
//     makes the output filter on level 3 block innocent answers.
//   - Pick words the AI is unlikely to say on its own (avoid words like ANSWER,
//     SECRET or PASSWORD).
//
// Changing the list changes today's passwords, which is fine at any time.

// The fewest usable words we accept. With fewer, guessing at random would be
// too easy even with the daily guess limit.
export const MIN_WORDS = 50;

// -----------------------------------------------------------------------------
// parseWordList(text)
// Turns the WORD_LIST secret into a clean array of unique uppercase words.
// Returns an empty array if the secret is missing.
// -----------------------------------------------------------------------------
export function parseWordList(text) {
  const words = String(text ?? '')
    .split(/[\s,]+/) // split on commas, spaces and new lines
    .map((word) => word.trim().toUpperCase())
    .filter((word) => /^[A-Z]{6,10}$/.test(word)); // keep only valid words
  return [...new Set(words)]; // drop duplicates
}
