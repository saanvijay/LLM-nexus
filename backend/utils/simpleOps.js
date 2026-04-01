// Detects simple file/project operations that a human can perform manually,
// intercepting the LLM call entirely to save tokens.

const { tokenize } = require('./tokenizer');

const SIMPLE_OPS = [
  {
    name: 'Create / Add File',
    pattern: /\b(create|add|make|touch|new)\s+(a\s+)?(new\s+)?file\b/i,
    instruction: 'Run in your terminal:  touch <filename>  or use your editor\'s "New File" option.',
  },
  {
    name: 'Delete / Remove File',
    pattern: /\b(delete|remove|rm|erase)\s+(the\s+)?(file\b|files\b)/i,
    instruction: 'Run in your terminal:  rm <filename>  or use your file manager.',
  },
  {
    name: 'Move File / Directory',
    pattern: /\b(move|mv)\s+(the\s+)?(file|directory|folder|dir)\b/i,
    instruction: 'Run in your terminal:  mv <source> <destination>',
  },
  {
    name: 'Rename File / Directory',
    pattern: /\brename\s+(the\s+)?(file|directory|folder|dir)\b/i,
    instruction: 'Run in your terminal:  mv <old-name> <new-name>',
  },
  {
    name: 'Copy File / Directory',
    pattern: /\b(copy|cp|duplicate)\s+(the\s+)?(file|directory|folder|dir)\b/i,
    instruction: 'Run in your terminal:  cp <source> <destination>  (use -r for directories)',
  },
  {
    name: 'Add Comment',
    pattern: /\badd\s+(a\s+)?(line\s+)?(comment|comments)\b/i,
    instruction: 'Open the file in your editor and type the comment directly (e.g.  // your note  or  # your note).',
  },
];

/**
 * Flattens a parsed prompt value into a single plain-text string for pattern matching.
 */
function flattenPrompt(prompt) {
  if (typeof prompt === 'string') return prompt;
  if (Array.isArray(prompt)) {
    // OpenAI-style messages array
    return prompt
      .map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join(' ');
  }
  return JSON.stringify(prompt);
}

/**
 * Inspects the request body for simple operations a human can do manually.
 * Returns { opName, instruction, estimatedTokens } if matched, otherwise null.
 * Token count is computed with the real tiktoken BPE tokeniser.
 */
function detectSimpleOp(buffer, contentType) {
  if (!buffer || !buffer.length) return null;
  if (!contentType || !contentType.includes('application/json')) return null;
  try {
    const json  = JSON.parse(buffer.toString('utf8'));
    const raw   = json.prompt ?? json.messages ?? json.inputs ?? json.input ?? null;
    if (raw === null) return null;

    const text  = flattenPrompt(raw);
    // Use the model field from the request body if present so token counts
    // reflect the correct BPE vocabulary; fall back to gpt-4o otherwise.
    const model = json.model ?? 'gpt-4o';
    const { count: estimatedTokens } = tokenize(buffer.toString('utf8'), model);

    for (const op of SIMPLE_OPS) {
      if (op.pattern.test(text)) {
        return { opName: op.name, instruction: op.instruction, estimatedTokens };
      }
    }
  } catch { /* ignore parse errors */ }
  return null;
}

/**
 * Builds an OpenAI-compatible JSON response body that tells the user to act manually.
 * Returned as a Buffer so handler.js can send it directly.
 */
function buildInterceptResponse(opName, instruction, estimatedTokens) {
  const message =
    `[INTERCEPTED — No LLM call made]\n\n` +
    `Operation detected : ${opName}\n` +
    `Estimated tokens   : ${estimatedTokens} (input) — saved by not calling the LLM\n\n` +
    `Do it manually:\n${instruction}`;

  const body = {
    id: 'simple-op-intercepted',
    object: 'chat.completion',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: message },
      finish_reason: 'stop',
    }],
    usage: {
      prompt_tokens: estimatedTokens,
      completion_tokens: 0,
      total_tokens: estimatedTokens,
    },
  };

  return Buffer.from(JSON.stringify(body), 'utf8');
}

module.exports = { detectSimpleOp, buildInterceptResponse };
