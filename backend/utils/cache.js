// In-memory prompt cache: stores full response buffers keyed by prompt content.
// On a cache hit (exact or similar), the proxy replays the stored response without
// calling upstream and reports the total tokens that *would have been* consumed.

const promptCache = new Map(); // key → { rawBuffer, statusCode, headers, resData }

// Default Jaccard similarity threshold for "similar prompt" matching (0–1).
const SIMILARITY_THRESHOLD = 0.75;

/**
 * Derives a stable cache key from the request body.
 * Returns the full JSON-stringified prompt/messages string, or null if not applicable.
 */
function getCacheKey(buffer, contentType) {
  if (!buffer || !buffer.length) return null;
  if (!contentType || !contentType.includes('application/json')) return null;
  try {
    const json = JSON.parse(buffer.toString('utf8'));
    const prompt = json.prompt ?? json.messages ?? json.inputs ?? json.input ?? null;
    if (prompt === null) return null;
    return JSON.stringify(prompt);
  } catch {
    return null;
  }
}

/**
 * Flattens a JSON-stringified prompt key into plain text for word-level comparison.
 * Handles messages arrays (extracts `content` fields) and plain strings.
 */
function flattenKey(key) {
  try {
    const parsed = JSON.parse(key);
    if (Array.isArray(parsed)) {
      // OpenAI-style messages: [{ role, content }]
      return parsed
        .map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
        .join(' ');
    }
    if (typeof parsed === 'string') return parsed;
    return JSON.stringify(parsed);
  } catch {
    return key;
  }
}

/**
 * Tokenises text into a Set of lowercase words, stripping punctuation.
 */
function tokenize(text) {
  return new Set(
    text.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 1)   // ignore single-char noise
  );
}

/**
 * Jaccard similarity between two Sets: |A ∩ B| / |A ∪ B|.
 */
function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

/** Exact cache lookup. Returns the stored entry or null. */
function get(key) {
  return promptCache.get(key) ?? null;
}

/**
 * Similarity-based cache lookup.
 * Scans all cached keys and returns the best match above SIMILARITY_THRESHOLD,
 * or null if none qualifies.
 * @returns {{ entry: object, score: number } | null}
 */
function findSimilar(key, threshold = SIMILARITY_THRESHOLD) {
  const newTokens = tokenize(flattenKey(key));
  let bestEntry = null;
  let bestScore = 0;

  for (const [cachedKey, entry] of promptCache) {
    const score = jaccard(newTokens, tokenize(flattenKey(cachedKey)));
    if (score >= threshold && score > bestScore) {
      bestScore = score;
      bestEntry = entry;
    }
  }

  return bestEntry ? { entry: bestEntry, score: bestScore } : null;
}

/**
 * Stores a response in the cache.
 * @param {string} key
 * @param {Buffer} rawBuffer    - original (possibly compressed) response body
 * @param {number} statusCode
 * @param {object} headers      - response headers from upstream
 * @param {object|null} resData - extracted { response, inputTokens, outputTokens }
 */
function set(key, rawBuffer, statusCode, headers, resData) {
  promptCache.set(key, { rawBuffer, statusCode, headers, resData });
}

/** Returns the number of cached entries. */
function size() {
  return promptCache.size;
}

/** Clears all cached entries. */
function clear() {
  promptCache.clear();
}

/** Returns all cache keys (for inspection). */
function keys() {
  return [...promptCache.keys()];
}

module.exports = { getCacheKey, get, findSimilar, set, size, clear, keys, SIMILARITY_THRESHOLD };
