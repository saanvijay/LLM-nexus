const zlib   = require('zlib');
const config = require('../config/proxy.config.json');
const { tokenize } = require('./tokenizer');

const LOG_LEVEL = (process.env.LOG_LEVEL ?? config.logLevel ?? 'INFO').toUpperCase();
const isDebug   = LOG_LEVEL === 'DEBUG';

function decompress(buffer, encoding) {
  try {
    if (encoding === 'gzip')    return zlib.gunzipSync(buffer);
    if (encoding === 'br')      return zlib.brotliDecompressSync(buffer);
    if (encoding === 'deflate') return zlib.inflateSync(buffer);
  } catch { /* fall through */ }
  return buffer;
}

// Flatten a message content value to plain text.
// Handles string, OpenAI content-block arrays [{type,text}], and fallback JSON.
function flattenContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(b => b?.text ?? b?.input ?? '').filter(Boolean).join('');
  }
  return JSON.stringify(content);
}

/**
 * Extracts system prompt, last user prompt, and per-part token counts.
 * Returns { systemPrompt, systemTokens, userPrompt, userTokens, model } or null.
 */
function extractPrompt(buffer) {
  if (!buffer || !buffer.length) return null;
  try {
    const json  = JSON.parse(buffer.toString('utf8'));
    const model = json.model ?? 'gpt-4o';

    // Chat format: messages array — each item must have a role field,
    // otherwise it's not an LLM messages array (e.g. telemetry event arrays).
    if (Array.isArray(json.messages) && json.messages.some(m => m?.role)) {
      const msgs = json.messages;

      const systemText = msgs
        .filter(m => m.role === 'system')
        .map(m => flattenContent(m.content))
        .join('\n')
        .trim();

      const lastUser = [...msgs].reverse().find(m => m.role === 'user');
      const userText = lastUser ? flattenContent(lastUser.content).trim() : null;

      if (!systemText && !userText) return null;

      return {
        systemPrompt:  systemText  || null,
        systemTokens:  systemText  ? tokenize(systemText,  model).count : 0,
        userPrompt:    userText,
        userTokens:    userText    ? tokenize(userText,    model).count : 0,
        model,
      };
    }

    // Plain prompt string (completion-style) — must be a string, not an
    // arbitrary JSON array (which is what telemetry payloads look like).
    const raw = json.prompt ?? null;
    if (typeof raw !== 'string' || !raw.trim()) return null;
    return {
      systemPrompt: null,
      systemTokens: 0,
      userPrompt:   raw,
      userTokens:   tokenize(raw, model).count,
      model,
    };
  } catch {
    return null;
  }
}

/**
 * Extracts response text and output token count.
 * Handles OpenAI and Anthropic streaming (SSE) and non-streaming (JSON) formats.
 * Falls back to raw text dump when format is unrecognised so output is always visible.
 */
function extractResponse(buffer, contentType, contentEncoding, model = 'gpt-4o') {
  if (!buffer || !buffer.length) return null;
  try {
    const decompressed = decompress(buffer, contentEncoding);
    const text = decompressed.toString('utf8');

    const isSSE = (contentType && contentType.includes('text/event-stream'))
               || text.trimStart().startsWith('data:');

    if (isSSE) {
      let content      = '';
      let outputTokens = null;
      for (const line of text.split('\n')) {
        if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
        try {
          const chunk = JSON.parse(line.slice(6));

          // OpenAI chat / completion — try every known text field name
          const delta =
            chunk.choices?.[0]?.delta?.content ??   // standard OpenAI chat
            chunk.choices?.[0]?.delta?.text    ??   // some providers use text
            chunk.choices?.[0]?.text           ??   // completion-style
            chunk.delta?.content               ??   // top-level delta
            chunk.delta?.text                  ??   // top-level delta alt
            null;
          if (delta) content += delta;

          // Anthropic content_block_delta (text_delta or bare text)
          if (chunk.type === 'content_block_delta') {
            if (chunk.delta?.type === 'text_delta') content += chunk.delta.text ?? '';
            else if (typeof chunk.delta?.text === 'string') content += chunk.delta.text;
          }

          // Token counts
          if (chunk.usage) {
            outputTokens = chunk.usage.completion_tokens ?? chunk.usage.output_tokens ?? outputTokens;
          }
          if (chunk.type === 'message_delta' && chunk.usage) {
            outputTokens = chunk.usage.output_tokens ?? outputTokens;
          }
        } catch { /* skip malformed chunk */ }
      }
      if (content) {
        if (outputTokens == null) outputTokens = tokenize(content, model).count;
        return { response: content, outputTokens };
      }
      // SSE detected but no text — dump raw data lines for diagnosis
      const rawSSE = text.split('\n')
        .filter(l => l.startsWith('data: ') && l !== 'data: [DONE]')
        .join('\n');
      if (rawSSE) return { response: rawSSE, outputTokens: null, isRaw: true };
      return null;
    }

    // Non-streaming JSON
    try {
      const json      = JSON.parse(text);
      let outputText  = null;
      let reportedOut = json.usage?.completion_tokens ?? json.usage?.output_tokens ?? null;

      if (json.choices) {
        outputText = json.choices.map(c => {
          const content = c?.message?.content ?? c?.text ?? null;
          if (typeof content === 'string') return content;
          if (Array.isArray(content)) return content.map(b => b?.text ?? '').join('');
          return '';
        }).filter(Boolean).join('\n');
      } else if (json.content) {
        outputText  = Array.isArray(json.content)
          ? json.content.map(b => b?.text ?? '').filter(Boolean).join('')
          : json.content;
        reportedOut = json.usage?.output_tokens ?? reportedOut;
      } else if (json.completions) {
        outputText = typeof json.completions === 'string' ? json.completions : JSON.stringify(json.completions);
      } else if (json.output) {
        outputText = typeof json.output === 'string' ? json.output : JSON.stringify(json.output);
      }

      if (outputText) {
        const outputTokens = reportedOut ?? tokenize(outputText, model).count;
        return { response: outputText, outputTokens };
      }
    } catch { /* not JSON */ }

    // Last resort: strip non-printable bytes and show whatever is readable
    const readable = text.replace(/[^\x09\x0a\x0d\x20-\x7e]/g, '').trim();
    if (readable.length > 20) {
      return { response: readable, outputTokens: null, isRaw: true };
    }
  } catch { /* ignore */ }
  return null;
}

// ─── Log helpers ─────────────────────────────────────────────────────────────

function log(method, url, statusCode, reqData, resData) {
  if (!isDebug && !reqData?.userPrompt) return;  // INFO: skip non-LLM traffic
  if (!reqData && !resData) return;              // DEBUG: skip if nothing to show
  const ts    = new Date().toISOString();
  const lines = [`[${ts}] ${method} ${url} → ${statusCode}`];

  if (reqData?.systemPrompt) {
    lines.push(`  SYSTEM [${reqData.systemTokens} tokens] : ${reqData.systemPrompt}`);
  }
  if (reqData?.userPrompt) {
    lines.push(`  INPUT  [${reqData.userTokens} tokens] : ${reqData.userPrompt}`);
  }
  if (resData && (!resData.isRaw || isDebug)) {
    const tok = resData.outputTokens != null ? `${resData.outputTokens} tokens` : 'RAW';
    lines.push(`  OUTPUT [${tok}] : ${resData.response}`);
  }
  console.log(lines.join('\n'));
}

function logCacheHit(method, url, reqData, resData, similarity = null) {
  const ts    = new Date().toISOString();
  const label = similarity != null
    ? `CACHE HIT (similar ${(similarity * 100).toFixed(1)}%)`
    : 'CACHE HIT (exact)';
  const lines = [`[${ts}] ${method} ${url} → ${label}`];

  if (reqData?.systemPrompt) {
    lines.push(`  SYSTEM [${reqData.systemTokens} tokens] : ${reqData.systemPrompt}`);
  }
  if (reqData?.userPrompt) {
    lines.push(`  INPUT  [${reqData.userTokens} tokens] : ${reqData.userPrompt}`);
  }
  if (resData) {
    const out   = resData.outputTokens ?? 0;
    const inp   = reqData ? (reqData.systemTokens + reqData.userTokens) : 0;
    const total = inp + out;
    lines.push(`  OUTPUT [${out} tokens, total saved: ${total}] : ${resData.response}`);
  }
  console.log(lines.join('\n'));
}

function logSimpleOp(method, url, reqData, opName, instruction, estimatedTokens) {
  const ts    = new Date().toISOString();
  const lines = [
    `[${ts}] ${method} ${url} → SIMPLE OP INTERCEPTED`,
    `  OPERATION    : ${opName}`,
    `  DO MANUALLY  : ${instruction}`,
    `  TOKENS SAVED : ${estimatedTokens}`,
  ];
  if (reqData?.userPrompt) {
    lines.splice(1, 0, `  INPUT  [${reqData.userTokens} tokens] : ${reqData.userPrompt}`);
  }
  console.log(lines.join('\n'));
}

module.exports = { log, logCacheHit, logSimpleOp, extractPrompt, extractResponse, isDebug };
