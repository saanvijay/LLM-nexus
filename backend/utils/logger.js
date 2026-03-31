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
      let totalTokens = null;
      for (const line of text.split('\n')) {
        if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
        try {
          const chunk = JSON.parse(line.slice(6));
          const delta = chunk.choices?.[0]?.delta?.content ?? chunk.choices?.[0]?.text ?? '';
          if (delta) content += delta;
          if (chunk.usage?.total_tokens) totalTokens = chunk.usage.total_tokens;
        } catch { /* skip malformed chunk */ }
      }
      if (!content) return null;
      return { response: content.slice(0, 800), totalTokens };
    }

    // Regular JSON response
    if (contentType && contentType.includes('application/json')) {
      const json = JSON.parse(text);
      const output = json.choices ?? json.completions ?? json.output ?? json.content ?? null;
      if (output === null) return null;
      const totalTokens = json.usage?.total_tokens ?? json.usage?.totalTokens ?? null;
      return { response: JSON.stringify(output).slice(0, 800), totalTokens };
    }
  } catch { /* ignore */ }
  return null;
}

function log(reqData, resData) {
  if (!reqData && !resData) return;
  const ts = new Date().toISOString();
  const lines = [`[${ts}]`];
  if (reqData) {
    const tokenNote = reqData.inputTokens != null ? ` (input tokens: ${reqData.inputTokens})` : '';
    lines.push(`  PROMPT${tokenNote}: ${reqData.prompt}`);
  }
  if (resData) {
    const tokenNote = resData.totalTokens != null ? ` (total tokens: ${resData.totalTokens})` : '';
    lines.push(`  RESPONSE${tokenNote}: ${resData.response}`);
  }
  console.log(lines.join('\n'));
}

module.exports = { log, extractPrompt, extractResponse };
