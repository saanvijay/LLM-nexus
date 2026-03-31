function extractPrompt(buffer, contentType) {
  if (!buffer || !buffer.length) return null;
  if (!contentType || !contentType.includes('application/json')) return null;
  try {
    const json = JSON.parse(buffer.toString('utf8'));
    const prompt = json.prompt ?? json.messages ?? json.inputs ?? json.input ?? null;
    if (prompt === null) return null;
    const tokens = json.max_tokens ?? null;
    return { prompt: JSON.stringify(prompt).slice(0, 800), inputTokens: tokens };
  } catch {
    return null;
  }
}

function extractResponse(buffer, contentType) {
  if (!buffer || !buffer.length) return null;
  if (!contentType || !contentType.includes('application/json')) return null;
  try {
    const json = JSON.parse(buffer.toString('utf8'));
    const output = json.choices ?? json.completions ?? json.output ?? json.content ?? null;
    if (output === null) return null;
    const totalTokens = json.usage?.total_tokens ?? json.usage?.totalTokens ?? null;
    return { response: JSON.stringify(output).slice(0, 800), totalTokens };
  } catch {
    return null;
  }
}

function log(reqData, resData) {
  // Only log if there is a recognisable prompt or response
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
