const zlib = require('zlib');

function decompress(buffer, encoding) {
  try {
    if (encoding === 'gzip')    return zlib.gunzipSync(buffer);
    if (encoding === 'br')      return zlib.brotliDecompressSync(buffer);
    if (encoding === 'deflate') return zlib.inflateSync(buffer);
  } catch { /* fall through */ }
  return buffer;
}

function extractPrompt(buffer, contentType) {
  if (!buffer || !buffer.length) return null;
  if (!contentType || !contentType.includes('application/json')) return null;
  try {
    const json = JSON.parse(buffer.toString('utf8'));
    const prompt = json.prompt ?? json.messages ?? json.inputs ?? json.input ?? null;
    if (prompt === null) return null;
    const inputTokens = json.max_tokens ?? null;
    return { prompt: JSON.stringify(prompt).slice(0, 800), inputTokens };
  } catch {
    return null;
  }
}

function extractResponse(buffer, contentType, contentEncoding) {
  if (!buffer || !buffer.length) return null;
  try {
    const decompressed = decompress(buffer, contentEncoding);
    const text = decompressed.toString('utf8');

    // Streaming SSE response (text/event-stream)
    if (contentType && contentType.includes('text/event-stream')) {
      let content = '';
      let inputTokens = null;
      let outputTokens = null;
      for (const line of text.split('\n')) {
        if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
        try {
          const chunk = JSON.parse(line.slice(6));
          const delta = chunk.choices?.[0]?.delta?.content ?? chunk.choices?.[0]?.text ?? '';
          if (delta) content += delta;
          if (chunk.usage) {
            inputTokens  = chunk.usage.prompt_tokens     ?? chunk.usage.input_tokens  ?? inputTokens;
            outputTokens = chunk.usage.completion_tokens ?? chunk.usage.output_tokens ?? outputTokens;
          }
        } catch { /* skip malformed chunk */ }
      }
      if (!content) return null;
      return { response: content.slice(0, 800), inputTokens, outputTokens };
    }

    // Regular JSON response
    if (contentType && contentType.includes('application/json')) {
      const json = JSON.parse(text);
      const output = json.choices ?? json.completions ?? json.output ?? json.content ?? null;
      if (output === null) return null;
      const inputTokens  = json.usage?.prompt_tokens     ?? json.usage?.input_tokens  ?? null;
      const outputTokens = json.usage?.completion_tokens ?? json.usage?.output_tokens ?? null;
      return { response: JSON.stringify(output).slice(0, 800), inputTokens, outputTokens };
    }
  } catch { /* ignore */ }
  return null;
}

function log(reqData, resData) {
  if (!reqData && !resData) return;
  const ts = new Date().toISOString();
  const lines = [`[${ts}]`];
  if (reqData) {
    lines.push(`  PROMPT: ${reqData.prompt}`);
  }
  if (resData) {
    const parts = [];
    if (resData.inputTokens  != null) parts.push(`input tokens: ${resData.inputTokens}`);
    if (resData.outputTokens != null) parts.push(`output tokens: ${resData.outputTokens}`);
    const tokenNote = parts.length ? ` (${parts.join(', ')})` : '';
    lines.push(`  RESPONSE${tokenNote}: ${resData.response}`);
  }
  console.log(lines.join('\n'));
}

module.exports = { log, extractPrompt, extractResponse };
