/**
 * PII Redactor / Guardrail
 *
 * Scans incoming LLM request bodies and replaces Personally Identifiable
 * Information (PII) with labelled placeholders before the request is forwarded
 * upstream or stored in the prompt cache.
 *
 * Works on:
 *   - OpenAI-style messages arrays  (messages[].content — string or block array)
 *   - Plain prompt strings           (json.prompt)
 *
 * Each rule produces a placeholder like [EMAIL], [PHONE], [SSN], etc.
 * The original value is never logged or stored.
 *
 * Rules are loaded from config.json → "piiRules". Each entry has:
 *   name        — placeholder label, e.g. "EMAIL"
 *   description — human-readable explanation
 *   pattern     — regex pattern string (JSON-escaped)
 *   flags       — regex flags, e.g. "gi"
 *   enabled     — set to false to skip a rule without deleting it
 *
 * To add a custom rule, append an entry to piiRules in config.json.
 */

const config = require('../config/config.json');

// ---------------------------------------------------------------------------
// Compile rules from config at startup (fail fast on bad patterns)
// ---------------------------------------------------------------------------
const RULES = (config.piiRules ?? [])
  .filter(r => r.enabled !== false)
  .map(r => {
    try {
      return { name: r.name, regex: new RegExp(r.pattern, r.flags ?? 'g') };
    } catch (err) {
      console.error(`[REDACT] Invalid pattern for rule "${r.name}": ${err.message}`);
      return null;
    }
  })
  .filter(Boolean);

// ---------------------------------------------------------------------------
// Core redaction logic on a plain string
// ---------------------------------------------------------------------------
function redactText(text) {
  let out = text;
  const found = [];

  for (const rule of RULES) {
    // Re-create the regex each call so lastIndex resets to 0
    const re = new RegExp(rule.regex.source, rule.regex.flags);
    const matches = out.match(re);
    if (matches) {
      found.push({ type: rule.name, count: matches.length });
      out = out.replace(re, `[${rule.name}]`);
    }
  }

  return { text: out, found };
}

// ---------------------------------------------------------------------------
// Walk a single message's content (string or OpenAI block array)
// ---------------------------------------------------------------------------
function redactMessageContent(content, role) {
  const redactions = [];

  if (typeof content === 'string') {
    const { text, found } = redactText(content);
    found.forEach(f => redactions.push({ ...f, role }));
    return { content: text, redactions };
  }

  if (Array.isArray(content)) {
    const newBlocks = content.map(block => {
      if (block.type === 'text' && typeof block.text === 'string') {
        const { text, found } = redactText(block.text);
        found.forEach(f => redactions.push({ ...f, role }));
        return { ...block, text };
      }
      return block;
    });
    return { content: newBlocks, redactions };
  }

  return { content, redactions };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Redacts PII from an incoming request buffer.
 *
 * @param {Buffer} buffer        - Raw request body
 * @param {string} contentType   - Value of the Content-Type header
 * @returns {{ buffer: Buffer, redactions: Array }}
 *   buffer     — original buffer if no PII found, otherwise a new buffer with
 *                PII replaced by placeholders
 *   redactions — array of { type, count, role? } describing what was removed
 */
function redactBuffer(buffer, contentType) {
  if (!buffer || !buffer.length) return { buffer, redactions: [] };
  if (!contentType || !contentType.includes('application/json')) return { buffer, redactions: [] };

  // Quick check: must start with '{' or '[' to be JSON
  const first = buffer[0];
  if (first !== 0x7b && first !== 0x5b) return { buffer, redactions: [] };

  let json;
  try {
    json = JSON.parse(buffer.toString('utf8'));
  } catch {
    return { buffer, redactions: [] };
  }

  const allRedactions = [];

  // OpenAI / Anthropic messages array
  if (Array.isArray(json.messages)) {
    for (const msg of json.messages) {
      const { content, redactions } = redactMessageContent(msg.content, msg.role ?? 'unknown');
      if (redactions.length) {
        msg.content = content;
        allRedactions.push(...redactions);
      }
    }
  }

  // Plain prompt string
  if (typeof json.prompt === 'string') {
    const { text, found } = redactText(json.prompt);
    if (found.length) {
      json.prompt = text;
      allRedactions.push(...found);
    }
  }

  if (allRedactions.length === 0) return { buffer, redactions: [] };

  return {
    buffer: Buffer.from(JSON.stringify(json), 'utf8'),
    redactions: allRedactions,
  };
}

/**
 * Convenience: redact a plain string (for testing or ad-hoc use).
 */
function redactString(text) {
  return redactText(text);
}

module.exports = { redactBuffer, redactString, RULES };
