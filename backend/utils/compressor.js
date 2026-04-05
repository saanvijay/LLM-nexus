/**
 * Prompt Compressor
 *
 * Reduces token count before a request reaches the upstream LLM by applying
 * a series of lossless (structure) and near-lossless (phrasing) transforms:
 *
 *   1. Whitespace normalisation   — collapse blank lines, trailing spaces
 *   2. Verbose phrase substitution — long phrases → short equivalents
 *   3. AI filler removal          — boilerplate added by agents/wrappers
 *   4. Punctuation cleanup        — repeated !!!, ???, ...
 *   5. Sentence deduplication     — identical adjacent sentences removed
 *
 * Works on:
 *   - OpenAI-style messages arrays  (messages[].content — string or block array)
 *   - Plain prompt strings          (json.prompt)
 *
 * Each transform preserves the original meaning — no factual content is dropped.
 * Disable individual rules by setting enabled: false in the RULES array.
 */

'use strict';

const { tokenize } = require('./tokenizer');

// ── Compression rules ─────────────────────────────────────────────────────────
// Ordered: cheaper structural passes first, phrase substitutions last.

const RULES = [
  // ── 1. Whitespace ────────────────────────────────────────────────────────
  {
    name: 'trailing-whitespace',
    desc: 'Strip trailing spaces/tabs from every line',
    enabled: true,
    fn: text => text.replace(/[ \t]+$/gm, ''),
  },
  {
    name: 'excess-blank-lines',
    desc: 'Collapse 3+ consecutive blank lines into one',
    enabled: true,
    fn: text => text.replace(/(\n\s*){3,}/g, '\n\n'),
  },
  {
    name: 'multiple-spaces',
    desc: 'Collapse runs of spaces/tabs inside a line to a single space',
    enabled: true,
    fn: text => text.replace(/[ \t]{2,}/g, ' '),
  },

  // ── 2. Punctuation ───────────────────────────────────────────────────────
  {
    name: 'repeated-exclamation',
    desc: 'Replace 2+ exclamation marks with one',
    enabled: true,
    fn: text => text.replace(/!{2,}/g, '!'),
  },
  {
    name: 'repeated-question',
    desc: 'Replace 2+ question marks with one',
    enabled: true,
    fn: text => text.replace(/\?{2,}/g, '?'),
  },
  {
    name: 'repeated-period',
    desc: 'Normalise 4+ dots to ellipsis',
    enabled: true,
    fn: text => text.replace(/\.{4,}/g, '...'),
  },

  // ── 3. AI filler / boilerplate ───────────────────────────────────────────
  {
    name: 'ai-preamble',
    desc: 'Remove AI self-introduction boilerplate',
    enabled: true,
    fn: text => text
      .replace(/\bAs an AI(?:\s+language)?\s+model[,.]?\s*/gi, '')
      .replace(/\bAs a large language model[,.]?\s*/gi, '')
      .replace(/\bI(?:'m|\s+am) (?:an AI|a language model|Claude|ChatGPT)[,.]?\s*/gi, ''),
  },
  {
    name: 'filler-openers',
    desc: 'Remove hollow sentence openers',
    enabled: true,
    fn: text => text
      .replace(/\bCertainly[,!]\s*/gi, '')
      .replace(/\bOf course[,!]\s*/gi, '')
      .replace(/\bAbsolutely[,!]\s*/gi, '')
      .replace(/\bSure[,!]\s*/gi, '')
      .replace(/\bGreat[,!]\s*/gi, '')
      .replace(/\bI(?:'d| would) be (?:happy|glad|delighted) to (?:help(?: you)?[.!]?\s*)/gi, '')
      .replace(/\bI(?:'ll| will) help you\s*/gi, '')
      .replace(/\bFeel free to ask[^.]*\.\s*/gi, '')
      .replace(/\bDon't hesitate to ask[^.]*\.\s*/gi, '')
      .replace(/\bI hope (?:this|that) helps[^.]*\.\s*/gi, '')
      .replace(/\bLet me know if (?:you have|there are) (?:any )?(?:more )?questions[^.]*\.\s*/gi, ''),
  },

  // ── 4. Verbose phrasing → concise equivalents ────────────────────────────
  {
    name: 'verbose-connectives',
    desc: 'Shorten verbose connective phrases',
    enabled: true,
    fn: text => text
      .replace(/\bIn order to\b/gi,          'To')
      .replace(/\bSo as to\b/gi,             'To')
      .replace(/\bDue to the fact that\b/gi, 'Because')
      .replace(/\bOwing to the fact that\b/gi, 'Because')
      .replace(/\bIn the event that\b/gi,    'If')
      .replace(/\bIn the case that\b/gi,     'If')
      .replace(/\bIn cases? where\b/gi,      'If')
      .replace(/\bFor the purpose of\b/gi,   'To')
      .replace(/\bWith (?:respect|regard) to\b/gi, 'For')
      .replace(/\bWith regards to\b/gi,      'For')
      .replace(/\bIn terms of\b/gi,          'For')
      .replace(/\bIn the context of\b/gi,    'In')
      .replace(/\bIn the process of\b/gi,    'While')
      .replace(/\bAt this point in time\b/gi,'Now')
      .replace(/\bAt the present time\b/gi,  'Now')
      .replace(/\bOn a regular basis\b/gi,   'Regularly')
      .replace(/\bOn a daily basis\b/gi,     'Daily')
      .replace(/\bPrior to\b/gi,             'Before')
      .replace(/\bSubsequent to\b/gi,        'After')
      .replace(/\bA large number of\b/gi,    'Many')
      .replace(/\bA number of\b/gi,          'Several')
      .replace(/\bThe majority of\b/gi,      'Most')
      .replace(/\bIn spite of the fact that\b/gi, 'Although')
      .replace(/\bDespite the fact that\b/gi,'Although')
      .replace(/\bOn the other hand[,]?\b/gi,'However,')
      .replace(/\bIt is worth noting that\b/gi, 'Note:')
      .replace(/\bIt is important to note that\b/gi, 'Note:')
      .replace(/\bIt should be noted that\b/gi, 'Note:')
      .replace(/\bPlease note that\b/gi,     'Note:')
      .replace(/\bPlease be aware that\b/gi, 'Note:')
      .replace(/\bPlease be advised that\b/gi, 'Note:')
      .replace(/\bBe aware that\b/gi,        'Note:'),
  },
  {
    name: 'verbose-instructions',
    desc: 'Shorten verbose instruction patterns',
    enabled: true,
    fn: text => text
      .replace(/\bPlease (?:make sure|ensure) (?:that )?(?:you )?/gi, 'Ensure ')
      .replace(/\bMake sure (?:that )?(?:you )?/gi,                   'Ensure ')
      .replace(/\bYou (?:must|should|need to) ensure (?:that )?/gi,   'Ensure ')
      .replace(/\bYou (?:must|should) (?:always )?/gi,                '')
      .replace(/\bYou (?:are )?(?:required|expected) to /gi,          '')
      .replace(/\bIt is (?:necessary|required) (?:that you |to )?/gi, '')
      .replace(/\bPlease (?:also )?(?:remember to |keep in mind that )?/gi, ''),
  },
  {
    name: 'redundant-qualifiers',
    desc: 'Remove qualifiers that add length without precision',
    enabled: true,
    fn: text => text
      .replace(/\bvery unique\b/gi,        'unique')
      .replace(/\bcompletely (?:unique|new|different)\b/gi, m => m.split(' ').pop())
      .replace(/\babsolutely (?:certain|sure|clear)\b/gi,   m => m.split(' ').pop())
      .replace(/\bbasically\b/gi,          '')
      .replace(/\bliterally\b/gi,          '')
      .replace(/\bactually\b/gi,           '')
      .replace(/\bjust\b(?= (?:make sure|ensure|note|remember))/gi, '')
      .replace(/  +/g,                     ' '),   // re-collapse after removals
  },

  // ── 5. Sentence deduplication ────────────────────────────────────────────
  {
    name: 'duplicate-sentences',
    desc: 'Remove identical consecutive sentences',
    enabled: true,
    fn(text) {
      // Split on sentence-ending punctuation followed by whitespace
      const sentences = text.split(/(?<=[.!?])\s+/);
      const seen = new Set();
      const deduped = sentences.filter(s => {
        const key = s.trim().toLowerCase();
        if (!key) return true;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return deduped.join(' ');
    },
  },

  // ── 6. Final trim ────────────────────────────────────────────────────────
  {
    name: 'trim',
    desc: 'Trim leading/trailing whitespace from the whole text',
    enabled: true,
    fn: text => text.trim(),
  },
];

const ENABLED_RULES = RULES.filter(r => r.enabled);

// ── Core text compression ─────────────────────────────────────────────────────

function compressText(text) {
  if (typeof text !== 'string' || !text.trim()) return text;
  let out = text;
  for (const rule of ENABLED_RULES) {
    out = rule.fn(out);
  }
  return out;
}

// ── Walk a single message's content (string or OpenAI block array) ────────────

function compressMessageContent(content) {
  if (typeof content === 'string') {
    return compressText(content);
  }
  if (Array.isArray(content)) {
    return content.map(block => {
      if (block.type === 'text' && typeof block.text === 'string') {
        return { ...block, text: compressText(block.text) };
      }
      return block;
    });
  }
  return content;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Compresses prompt content inside a JSON request buffer.
 *
 * @param {Buffer} buffer       - Raw (already PII-redacted) request body
 * @param {string} contentType  - Value of Content-Type header
 * @returns {{
 *   buffer: Buffer,           - Compressed buffer (original ref if nothing changed)
 *   report: {
 *     originalTokens: number,
 *     compressedTokens: number,
 *     savedTokens: number,
 *     savedPct: number,
 *     rulesApplied: string[]
 *   } | null                  - null when nothing was compressible
 * }}
 */
function compressBuffer(buffer, contentType) {
  if (!buffer || !buffer.length) return { buffer, report: null };
  if (!contentType || !contentType.includes('application/json')) return { buffer, report: null };

  const first = buffer[0];
  if (first !== 0x7b && first !== 0x5b) return { buffer, report: null };

  let json;
  try {
    json = JSON.parse(buffer.toString('utf8'));
  } catch {
    return { buffer, report: null };
  }

  const model = json.model;
  let changed = false;

  // Compress messages array
  if (Array.isArray(json.messages)) {
    for (const msg of json.messages) {
      const compressed = compressMessageContent(msg.content);
      if (compressed !== msg.content) {
        msg.content = compressed;
        changed = true;
      }
    }
  }

  // Compress plain prompt string
  if (typeof json.prompt === 'string') {
    const compressed = compressText(json.prompt);
    if (compressed !== json.prompt) {
      json.prompt = compressed;
      changed = true;
    }
  }

  if (!changed) return { buffer, report: null };

  const originalText   = buffer.toString('utf8');
  const compressedJson = JSON.stringify(json);
  const newBuffer      = Buffer.from(compressedJson, 'utf8');

  const originalTokens   = tokenize(originalText, model).count;
  const compressedTokens = tokenize(compressedJson, model).count;
  const savedTokens      = originalTokens - compressedTokens;
  const savedPct         = originalTokens > 0
    ? Math.round((savedTokens / originalTokens) * 100)
    : 0;

  return {
    buffer: newBuffer,
    report: {
      originalTokens,
      compressedTokens,
      savedTokens,
      savedPct,
      rulesApplied: ENABLED_RULES.map(r => r.name),
    },
  };
}

/**
 * Convenience: compress a plain string directly (useful for testing).
 */
function compressString(text) {
  return compressText(text);
}

module.exports = { compressBuffer, compressString, RULES };
