const zlib = require('zlib');
const { tokenize } = require('./tokenizer');

function decompress(buffer, encoding) {
  try {
    if (encoding === 'gzip')    return zlib.gunzipSync(buffer);
    if (encoding === 'br')      return zlib.brotliDecompressSync(buffer);
    if (encoding === 'deflate') return zlib.inflateSync(buffer);
  } catch { /* fall through */ }
  return buffer;
}

/**
 * Extracts prompt text and counts input tokens using tiktoken.
 * Content-type header is not required — always tries JSON parse.
 */
function extractPrompt(buffer) {
  if (!buffer || !buffer.length) return null;
  try {
    const json   = JSON.parse(buffer.toString('utf8'));
    const raw    = json.prompt ?? json.messages ?? json.inputs ?? json.input ?? null;
    if (raw === null) return null;
    const model  = json.model ?? 'gpt-4o';
    const text   = typeof raw === 'string' ? raw : JSON.stringify(raw);
    const { count: inputTokens } = tokenize(text, model);
    return { prompt: text, inputTokens, model };
  } catch {
    return null;
  }
}

/**
 * Extracts response text and token counts.
 * - SSE is detected by content-type OR by body starting with "data:" so it works
 *   even when the header is absent or mismatched.
 * - Output tokens fall back to tiktoken when the API omits the usage field.
 * @param {string} [model] - model name from the request, used for tiktoken fallback
 */
function extractResponse(buffer, contentType, contentEncoding, model = 'gpt-4o') {
  if (!buffer || !buffer.length) return null;
  try {
    const decompressed = decompress(buffer, contentEncoding);
    const text = decompressed.toString('utf8');

    // Detect SSE by header OR by body shape (works even when header is wrong/missing)
    const isSSE = (contentType && contentType.includes('text/event-stream'))
               || text.trimStart().startsWith('data:');

    if (isSSE) {
      let content      = '';
      let inputTokens  = null;
      let outputTokens = null;
      for (const line of text.split('\n')) {
        if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
        try {
          const chunk  = JSON.parse(line.slice(6));
          const delta  = chunk.choices?.[0]?.delta?.content ?? chunk.choices?.[0]?.text ?? '';
          if (delta) content += delta;
          if (chunk.usage) {
            inputTokens  = chunk.usage.prompt_tokens     ?? chunk.usage.input_tokens  ?? inputTokens;
            outputTokens = chunk.usage.completion_tokens ?? chunk.usage.output_tokens ?? outputTokens;
          }
        } catch { /* skip malformed chunk */ }
      }
      if (!content) return null;
      // Fallback: count output tokens locally when API does not report them
      if (outputTokens == null) outputTokens = tokenize(content, model).count;
      return { response: content, inputTokens, outputTokens };
    }

    // Try JSON regardless of content-type header
    try {
      const json   = JSON.parse(text);
      const output = json.choices ?? json.completions ?? json.output ?? json.content ?? null;
      if (output !== null) {
        const inputTokens   = json.usage?.prompt_tokens     ?? json.usage?.input_tokens  ?? null;
        const reportedOut   = json.usage?.completion_tokens ?? json.usage?.output_tokens ?? null;
        const outputText    = typeof output === 'string' ? output : JSON.stringify(output);
        const outputTokens  = reportedOut ?? tokenize(outputText, model).count;
        return { response: outputText, inputTokens, outputTokens };
      }
    } catch { /* not JSON */ }
  } catch { /* ignore */ }
  return null;
}

/**
 * Logs every proxied request.
 * Always prints METHOD + URL + status. Appends prompt and response with
 * explicit token counts when extraction succeeds.
 */
function log(method, url, statusCode, reqData, resData) {
  const ts = new Date().toISOString();
  const lines = [`[${ts}] ${method} ${url} → ${statusCode}`];
  if (reqData) {
    lines.push(`  PROMPT  [${reqData.inputTokens} tokens] : ${reqData.prompt}`);
  }
  if (resData) {
    const inPart  = resData.inputTokens  != null ? `input: ${resData.inputTokens}` : null;
    const outPart = resData.outputTokens != null ? `output: ${resData.outputTokens}` : null;
    const tok     = [inPart, outPart].filter(Boolean).join(', ');
    lines.push(`  RESPONSE${tok ? ` [${tok} tokens]` : ''} : ${resData.response}`);
  }
  console.log(lines.join('\n'));
}

/**
 * Logs a cache hit (exact or similar-prompt match).
 */
function logCacheHit(method, url, reqData, resData, similarity = null) {
  const ts       = new Date().toISOString();
  const label    = similarity != null
    ? `CACHE HIT (similar ${(similarity * 100).toFixed(1)}%)`
    : 'CACHE HIT (exact)';
  const lines    = [`[${ts}] ${method} ${url} → ${label}`];
  if (reqData) {
    lines.push(`  PROMPT  [${reqData.inputTokens} tokens] : ${reqData.prompt}`);
  }
  if (resData) {
    const input  = resData.inputTokens  ?? 0;
    const output = resData.outputTokens ?? 0;
    const hasAny = resData.inputTokens != null || resData.outputTokens != null;
    const tok    = hasAny
      ? `input: ${input}, output: ${output}, total: ${input + output}`
      : '';
    lines.push(`  CACHED RESPONSE${tok ? ` [${tok} tokens]` : ''} : ${resData.response}`);
  }
  console.log(lines.join('\n'));
}

/**
 * Logs an intercepted simple-operation request (no LLM call made).
 */
function logSimpleOp(method, url, reqData, opName, instruction, estimatedTokens) {
  const ts    = new Date().toISOString();
  const lines = [
    `[${ts}] ${method} ${url} → SIMPLE OP INTERCEPTED — LLM call skipped`,
    `  OPERATION        : ${opName}`,
    `  ESTIMATED TOKENS : ${estimatedTokens} (saved by skipping LLM)`,
    `  DO MANUALLY      : ${instruction}`,
  ];
  if (reqData) lines.splice(1, 0, `  PROMPT  [${reqData.inputTokens} tokens] : ${reqData.prompt}`);
  console.log(lines.join('\n'));
}

module.exports = { log, logCacheHit, logSimpleOp, extractPrompt, extractResponse };
