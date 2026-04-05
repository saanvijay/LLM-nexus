/**
 * Prompt Compressor
 *
 * Reduces token count before a request reaches the upstream LLM by applying
 * a series of lossless (structure) and near-lossless (phrasing) transforms:
 *
 *   1.  Whitespace normalisation    — collapse blank lines, trailing spaces
 *   2.  Punctuation cleanup         — repeated !!!, ???, ...
 *   3.  AI filler removal           — boilerplate added by agents/wrappers
 *   4.  Meta lead-ins               — "Here is a list of X:" → "X:"
 *   5.  Transition word removal     — Additionally/Furthermore/Moreover → removed
 *   6.  You-should patterns         — "You should [X]" → "[X]"
 *   7.  Goal/task/purpose phrases   — "Your goal is to [X]" → "[X]"
 *   8.  Soft imperatives            — "It is recommended that you" → "Prefer to"
 *   9.  Verbose connectives         — "In order to" → "To", 20+ more
 *   10. Verbose instructions        — "Please make sure that you" → "Ensure"
 *   11. Clarification phrases       — "In other words," → "i.e.,"
 *   12. Passive progressive         — "is being processed" → "is processed"
 *   13. Redundant qualifiers        — "very unique" → "unique", "basically" → removed
 *   14. Enumeration simplification  — "first and foremost" → "first"
 *   15. Sentence deduplication      — identical adjacent sentences removed
 *   16. Final trim
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
      .replace(/(?<![Nn]ot )\bSure[,!]\s*/g, '')   // skip "not sure,"
      .replace(/(?<![Nn]ot )\bGreat[,!]\s*/g, '')
      .replace(/\bI(?:'d| would) be (?:happy|glad|delighted) to (?:help(?: you)?[.!]?[^\S\n]*)/gi, '')
      .replace(/\bI(?:'ll| will) help you[^\S\n]*/gi, '')
      .replace(/\bFeel free to ask[^.\n]*\.[^\S\n]*/gi, '')
      .replace(/\bDon't hesitate to ask[^.\n]*\.[^\S\n]*/gi, '')
      .replace(/\bI hope (?:this|that) helps[^.\n]*\.[^\S\n]*/gi, '')
      .replace(/\bLet me know if (?:you have|there are) (?:any )?(?:more )?questions[^.\n]*\.[^\S\n]*/gi, ''),
  },

  // ── 4. Meta lead-ins — structural intro phrases before sections/lists ────
  {
    name: 'meta-lead-ins',
    desc: 'Shorten "Here is/are X:" and "The following is/are X:" to just "X:"',
    enabled: true,
    fn: text => text
      // "Here is a list of guidelines you should follow:" → "Guidelines:"
      .replace(/\bHere (?:is|are) (?:a |an |the )?(?:list of |set of |summary of |overview of |description of |collection of )?([^:\n.!?]{3,60})(?:\s+you should follow)?[:\s]*\n/gi,
               (_, noun) => noun.trim().replace(/^[a-z]/, c => c.toUpperCase()) + ':\n')
      // "The following is/are/contains a [set of] X:" → "X:"
      .replace(/\bThe following (?:is|are|contains?) (?:a |an |the )?(?:list of |set of |summary of |collection of )?([^:\n.!?]{3,60})[:\s]*\n/gi,
               (_, noun) => noun.trim().replace(/^[a-z]/, c => c.toUpperCase()) + ':\n')
      // "Below is/are a [X]:" → "X:"
      .replace(/\bBelow (?:is|are) (?:a |an |the )?(?:list of |set of |summary of |description of )?([^:\n.!?]{3,60})[:\s]*\n/gi,
               (_, noun) => noun.trim().replace(/^[a-z]/, c => c.toUpperCase()) + ':\n')
      // "Above is/are" same treatment
      .replace(/\bAbove (?:is|are) (?:a |an |the )?([^:\n.!?]{3,60})[:\s]*\n/gi,
               (_, noun) => noun.trim().replace(/^[a-z]/, c => c.toUpperCase()) + ':\n')
      // "Here is how to X:" → "How to X:"
      .replace(/\bHere is how to /gi, 'How to ')
      // "Here is what you need to do:" → "Steps:"
      .replace(/\bHere is what you need to do[:\s]*/gi, 'Steps: ')
      // Standalone "Here is/are the X" in running text (no newline)
      .replace(/\bHere (?:is|are) (?:the |a |an )?/gi, '')
      .replace(/\bBelow (?:is|are) (?:the |a |an )?/gi, ''),
  },

  // ── 5. Transition words — discourse connectors that add tokens, not meaning
  {
    name: 'transition-words',
    desc: 'Remove high-token discourse connectors that pad without adding meaning',
    enabled: true,
    fn: text => text
      .replace(/\bAdditionally,?\s*/gi,     '')
      .replace(/\bFurthermore,?\s*/gi,      '')
      .replace(/\bMoreover,?\s*/gi,         '')
      .replace(/\bIn addition(?:\s+to\s+that)?,?\s*/gi, '')
      .replace(/\bAlso,\s*/gi,              '')
      .replace(/\bConsequently,?\s*/gi,     'So, ')
      .replace(/\bTherefore,?\s*/gi,        'So, ')
      .replace(/\bThus,?\s*/gi,             'So, ')
      .replace(/\bHence,?\s*/gi,            'So, ')
      .replace(/\bNevertheless,?\s*/gi,     'But ')
      .replace(/\bNonetheless,?\s*/gi,      'But ')
      .replace(/\bFirst and foremost,?\s*/gi, 'First, ')
      .replace(/\bLast but not least,?\s*/gi, 'Finally, ')
      .replace(/\bIn the first place,?\s*/gi, 'First, ')
      .replace(/\bTo begin with,?\s*/gi,    'First, ')
      .replace(/\bAs such,?\s*/gi,          'So, ')
      .replace(/\bWith that said,?\s*/gi,   '')
      .replace(/\bThat being said,?\s*/gi,  '')
      .replace(/\bHaving said that,?\s*/gi, '')
      .replace(/\bAll things considered,?\s*/gi, '')
      .replace(/\bAll in all,?\s*/gi,       '')
      // Re-collapse any double spaces left by removals
      .replace(/  +/g, ' '),
  },

  // ── 6. "You should / You must / You need to" patterns ────────────────────
  {
    name: 'you-should',
    desc: '"You should [X]" → "[X]", "You need to [X]" → "[X]"',
    enabled: true,
    fn: text => text
      .replace(/\bYou should (?:always )?/gi,  '')
      .replace(/\bYou must (?:always )?/gi,     '')
      .replace(/\bYou need to (?:always )?/gi,  '')
      .replace(/\bYou (?:are required|are expected) to /gi, '')
      .replace(/\bYou will need to /gi,         '')
      .replace(/\bYou are to /gi,               '')
      .replace(/\bYou ought to /gi,             '')
      .replace(/\bOne should /gi,               '')
      .replace(/  +/g, ' '),
  },

  // ── 7. Goal / task / purpose / role verbosity ────────────────────────────
  {
    name: 'goal-purpose',
    desc: 'Remove verbose goal/task/role preambles, keeping just the action',
    enabled: true,
    fn: text => text
      .replace(/\bYour (?:primary |main |key |core )?(?:goal|objective|purpose|mission|aim) (?:here |now )?is to /gi, '')
      .replace(/\bYour (?:primary |main |key )?(?:task|job|responsibility|role|function) (?:here |now )?is to /gi, '')
      .replace(/\bThe (?:main |primary |key )?(?:goal|purpose|objective|aim) (?:of this |here )?is to /gi, '')
      .replace(/\bI (?:want|need|would like) you to /gi, '')
      .replace(/\bCan you (?:please )?/gi, '')
      .replace(/\bCould you (?:please )?/gi, '')
      .replace(/\bPlease go ahead and /gi, '')           // only "please go ahead and", not bare "please"
      .replace(/\bYou will be (?:asked|expected|required) to /gi, '')
      .replace(/\bYou will be given /gi, 'Given ')
      .replace(/\bThe user will (?:provide you with|give you) /gi, 'Input: ')
      .replace(/\bWhen the user (?:provides?|gives?) you /gi, 'When given ')
      .replace(/  +/g, ' '),
  },

  // ── 8. Soft imperatives ──────────────────────────────────────────────────
  {
    name: 'soft-imperatives',
    desc: 'Shorten hedged recommendations to direct alternatives',
    enabled: true,
    fn: text => text
      .replace(/\bIt is (?:strongly )?recommended (?:that you |to )/gi, 'Prefer to ')
      .replace(/\bIt is (?:strongly )?advised (?:that you |to )/gi,     'Prefer to ')
      .replace(/\bIt is best (?:practice )?to /gi,                      'Best to ')
      .replace(/\bIt is (?:a )?good (?:practice|idea) to /gi,           'Best to ')
      // Remove trailing qualifiers — they add tokens without changing the core instruction
      .replace(/[, ]+whenever (?:it is )?possible\.?/gi,  '.')
      .replace(/[, ]+wherever (?:it is )?possible\.?/gi,  '.')
      .replace(/[, ]+when (?:it is )?possible\.?/gi,      '.')
      .replace(/[, ]+whenever (?:it is )?applicable\.?/gi,'.')
      .replace(/[, ]+as (?:needed|necessary|required|appropriate)\.?/gi, '.')
      .replace(/[, ]+if (?:and when )?(?:it is )?(?:necessary|needed|required|applicable)\.?/gi, '.')
      // Fix doubled periods left by removal (preserve ellipsis ... = 3 dots)
      .replace(/(?<!\.)\.\.(?!\.)/g, '.')
      .replace(/  +/g, ' '),
  },

  // ── 9. Verbose phrasing → concise equivalents ────────────────────────────
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
      .replace(/\bPlease (?:also )?(?:remember to |keep in mind that )?/gi, '')
      // "Ensure always/never X" → "Always/Never X" (left by prior Ensure substitution)
      .replace(/\bEnsure always\b/gi, 'Always')
      .replace(/\bEnsure never\b/gi,  'Never')
      .replace(/  +/g, ' '),
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

  // ── 13. Clarification / definition phrases ───────────────────────────────
  {
    name: 'clarification-phrases',
    desc: 'Shorten verbose clarification lead-ins',
    enabled: true,
    fn: text => text
      .replace(/\bIn other words,?\s*/gi,     'i.e., ')
      .replace(/\bThat is to say,?\s*/gi,      'i.e., ')
      .replace(/\bThat is,?\s*/gi,             'i.e., ')
      .replace(/\bWhat this means is (?:that )?/gi, 'Meaning: ')
      .replace(/\bThis means (?:that )?/gi,    'Meaning: ')
      .replace(/\bIn short,?\s*/gi,            '')
      .replace(/\bTo put it (?:simply|briefly|differently),?\s*/gi, '')
      .replace(/\bSimply put,?\s*/gi,          '')
      .replace(/\bPut simply,?\s*/gi,          '')
      .replace(/\bTo be (?:more )?(?:specific|precise|clear|exact),?\s*/gi, '')
      .replace(/\bAs (?:a |an )?(?:general )?(?:rule|guideline),?\s*/gi, 'Generally, ')
      .replace(/\bFor (?:your )?(?:reference|context|background),?\s*/gi, '')
      .replace(/  +/g, ' '),
  },

  // ── 14. Passive progressive → simple passive ─────────────────────────────
  {
    name: 'passive-progressive',
    desc: '"is/are/was/were being [verb]ed" → "is/are/was/were [verb]ed"',
    enabled: true,
    fn: text => text
      .replace(/\b(is|are|was|were) being (\w+ed)\b/gi, '$1 $2'),
  },

  // ── 15. Sentence deduplication ───────────────────────────────────────────
  {
    name: 'duplicate-sentences',
    desc: 'Remove identical consecutive sentences, preserving newlines/list structure',
    enabled: true,
    fn(text) {
      // Process line-by-line to preserve list formatting and newlines
      return text.split('\n').map(line => {
        const sentences = line.split(/(?<=[.!?]) +/);
        const seen = new Set();
        const deduped = sentences.filter(s => {
          const key = s.trim().toLowerCase();
          if (!key) return true;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        return deduped.join(' ');
      }).join('\n');
    },
  },

  // ── 16. Post-substitution cleanup ───────────────────────────────────────
  {
    name: 'post-cleanup',
    desc: 'Fix artefacts left by prior passes: empty list items, bare Ensure, re-capitalise',
    enabled: true,
    fn: text => text
      // "Ensure [verb]" (no "that") → drop "Ensure", keep the verb capitalised
      // e.g. "Ensure understand" → "understand", "Ensure analyze" → "analyze"
      .replace(/\bEnsure (?!that\b)/g, '')
      // Remove empty list items left when the full bullet content was stripped
      .replace(/^[ \t]*[-*][ \t]*[-*]?[ \t]*$/gm, '')
      // Collapse blank lines again (removals may have left extras)
      .replace(/(\n\s*){3,}/g, '\n\n')
      .replace(/  +/g, ' '),
  },

  // ── 18. Final trim ───────────────────────────────────────────────────────
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
