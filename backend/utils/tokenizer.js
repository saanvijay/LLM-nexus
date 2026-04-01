const { encoding_for_model, get_encoding } = require('tiktoken');

// Encodings vary by model family. Map known model prefixes to their encoding.
const MODEL_ENCODING_MAP = {
  'gpt-4o':            'o200k_base',
  'gpt-4':             'cl100k_base',
  'gpt-3.5':           'cl100k_base',
  'text-embedding-3':  'cl100k_base',
  'text-davinci':      'p50k_base',
};

/**
 * Returns the best tiktoken encoding name for a given model string.
 * Falls back to cl100k_base (GPT-4 / most modern models) if unrecognised.
 */
function resolveEncoding(model) {
  if (!model) return 'cl100k_base';
  for (const [prefix, enc] of Object.entries(MODEL_ENCODING_MAP)) {
    if (model.startsWith(prefix)) return enc;
  }
  // tiktoken's own helper — throws for completely unknown models, so wrap it
  try {
    const enc = encoding_for_model(model);
    enc.free();
    return null; // signal to use encoding_for_model directly
  } catch {
    return 'cl100k_base';
  }
}

/**
 * Tokenises `text` using the real tiktoken BPE tokeniser.
 *
 * @param {string} text        - The text to tokenise.
 * @param {string} [model]     - Optional model name (e.g. 'gpt-4o', 'gpt-4').
 *                               Defaults to 'gpt-4o'.
 * @returns {{ count: number, tokens: number[] }}
 *   count  — number of tokens
 *   tokens — array of raw token IDs (BPE integers)
 */
function tokenize(text, model = 'gpt-4o') {
  if (typeof text !== 'string' || text.length === 0) return { count: 0, tokens: [] };

  let enc;
  try {
    enc = encoding_for_model(model);
  } catch {
    // Unknown model — fall back to the closest known encoding
    const encName = resolveEncoding(model) ?? 'cl100k_base';
    enc = get_encoding(encName);
  }

  try {
    const raw    = enc.encode(text);
    const tokens = Array.from(raw);   // Uint32Array → plain array
    return { count: tokens.length, tokens };
  } finally {
    enc.free(); // always release WASM memory
  }
}

module.exports = { tokenize };
