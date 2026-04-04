'use strict';

/**
 * Unit tests for backend/utils/redactor.js
 * Run: node backend/tests/test-redactor.js
 */

const { redactBuffer, redactString, getRuleByName, RULES } = require('../utils/redactor');

let passed = 0;
let failed = 0;

function assert(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

function section(name) {
  console.log(`\n── ${name} ${'─'.repeat(Math.max(0, 48 - name.length))}`);
}

function jsonBuf(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8');
}

function parsed(buf) {
  return JSON.parse(buf.toString('utf8'));
}

const CT = 'application/json';

// ── Rule loading ──────────────────────────────────────────────────────────────
section('Rule loading');

assert('RULES is non-empty array',        Array.isArray(RULES) && RULES.length > 0);
assert('every rule has name',             RULES.every(r => typeof r.name === 'string'));
assert('every rule has compiled regex',   RULES.every(r => r.regex instanceof RegExp));

assert('getRuleByName — canonical name',  getRuleByName('EMAIL') !== undefined);
assert('getRuleByName — alias',           getRuleByName('emailAddress') !== undefined);
assert('getRuleByName — case-insensitive alias', getRuleByName('EMAIL') === getRuleByName('email'));
assert('getRuleByName — unknown returns undefined', getRuleByName('NONEXISTENT') === undefined);

// ── redactString — one rule at a time ─────────────────────────────────────────
section('redactString — EMAIL');
{
  const { text, found } = redactString('Contact alice@example.com or bob@test.org for help');
  assert('both emails replaced',   text === 'Contact [EMAIL] or [EMAIL] for help');
  assert('found.length = 1 (one entry per rule)', found.length === 1);
  assert('type = EMAIL',           found.every(f => f.type === 'EMAIL'));
  assert('count = 2 (both matches)', found[0].count === 2);
}
{
  const { text, found } = redactString('No emails here');
  assert('no-match: text unchanged', text === 'No emails here');
  assert('no-match: found is empty', found.length === 0);
}

section('redactString — PHONE');
{
  const { text, found } = redactString('Call me at 415-555-1234 or (800) 123-4567');
  assert('phone replaced',   !text.includes('415-555-1234'));
  assert('found PHONE',      found.some(f => f.type === 'PHONE'));
}
{
  // Private-looking number that shouldn't match (no area-code structure)
  const { text } = redactString('value 12345');
  assert('short number not redacted', text === 'value 12345');
}

section('redactString — SSN');
{
  const { text, found } = redactString('SSN: 123-45-6789');
  assert('SSN replaced',  text.includes('[SSN]'));
  assert('found SSN',     found.some(f => f.type === 'SSN'));
}
{
  // Invalid SSN (starts with 000 — excluded by negative lookahead)
  const { text } = redactString('000-45-6789');
  assert('invalid SSN (000 prefix) not redacted', !text.includes('[SSN]'));
}
{
  // Invalid SSN (starts with 9xx — excluded)
  const { text } = redactString('900-45-6789');
  assert('invalid SSN (9xx prefix) not redacted', !text.includes('[SSN]'));
}

section('redactString — CREDIT_CARD');
{
  const cards = [
    '4111 1111 1111 1111', // Visa
    '5500-0000-0000-0004', // Mastercard
    '6011000990139424',    // Discover
  ];
  for (const card of cards) {
    const { text, found } = redactString(`card: ${card}`);
    assert(`card ${card.slice(0, 4)}... replaced`, text.includes('[CREDIT_CARD]'));
    assert(`found CREDIT_CARD for ${card.slice(0, 4)}...`, found.some(f => f.type === 'CREDIT_CARD'));
  }
}

section('redactString — API_KEY');
{
  const keys = [
    'sk-abc12345678901234567890',           // OpenAI
    'sk-ant-api03-abc12345678901234567890', // Anthropic
    'ghp_' + 'A'.repeat(36),               // GitHub PAT
  ];
  for (const k of keys) {
    const { text, found } = redactString(`key: ${k}`);
    assert(`api key ${k.slice(0, 6)}... replaced`, text.includes('[API_KEY]'));
    assert(`found API_KEY for ${k.slice(0, 6)}...`, found.some(f => f.type === 'API_KEY'));
  }
}

section('redactString — BANK_ACCOUNT');
{
  const { text, found } = redactString('account: 123456789012');
  assert('bank account replaced', text.includes('[BANK_ACCOUNT]'));
  assert('found BANK_ACCOUNT',    found.some(f => f.type === 'BANK_ACCOUNT'));
}
{
  const { text } = redactString('routing #987654321');
  assert('routing number replaced', text.includes('[BANK_ACCOUNT]'));
}

section('redactString — PASSPORT');
{
  const { text, found } = redactString('Passport: AB1234567');
  assert('passport replaced', text.includes('[PASSPORT]'));
  assert('found PASSPORT',    found.some(f => f.type === 'PASSPORT'));
}

section('redactString — IP_ADDRESS');
{
  const { text, found } = redactString('server at 203.0.113.42');
  assert('public IP replaced', text.includes('[IP_ADDRESS]'));
  assert('found IP_ADDRESS',   found.some(f => f.type === 'IP_ADDRESS'));
}
{
  // Private ranges must NOT be redacted
  for (const priv of ['10.0.0.1', '192.168.1.1', '127.0.0.1']) {
    const { text } = redactString(`host ${priv}`);
    assert(`private IP ${priv} not redacted`, !text.includes('[IP_ADDRESS]'));
  }
}

section('redactString — DATE_OF_BIRTH');
{
  const samples = [
    'dob: 01/15/1990',
    'date of birth: 15-01-1990',
    'born on 1/5/85',
    'birthday: 12/31/2000',
  ];
  for (const s of samples) {
    const { text, found } = redactString(s);
    assert(`DOB "${s}" replaced`, text.includes('[DATE_OF_BIRTH]'));
    assert(`found DATE_OF_BIRTH`, found.some(f => f.type === 'DATE_OF_BIRTH'));
  }
}
{
  // Date not labelled → should NOT be redacted
  const { text } = redactString('meeting on 01/15/1990');
  assert('unlabelled date not redacted', !text.includes('[DATE_OF_BIRTH]'));
}

// ── Multiple PII types in one string ──────────────────────────────────────────
section('redactString — multiple types in one string');
{
  const input = 'Email alice@example.com, SSN 123-45-6789, call 415-555-1234';
  const { text, found } = redactString(input);
  assert('email redacted',  text.includes('[EMAIL]'));
  assert('SSN redacted',    text.includes('[SSN]'));
  assert('phone redacted',  text.includes('[PHONE]'));
  assert('original values absent', !text.includes('alice@example.com') && !text.includes('123-45-6789'));
  assert('found has 3 entries', found.length === 3);
}

// ── redactBuffer — no-op cases ────────────────────────────────────────────────
section('redactBuffer — no-op cases');

{
  const r = redactBuffer(null, CT);
  assert('null buffer → same redactions []', r.redactions.length === 0);
}
{
  const r = redactBuffer(Buffer.alloc(0), CT);
  assert('empty buffer → no redactions', r.redactions.length === 0);
}
{
  const buf = jsonBuf({ messages: [{ role: 'user', content: 'hello world' }] });
  const r = redactBuffer(buf, 'text/plain');
  assert('non-JSON content-type → buffer unchanged', r.buffer === buf);
}
{
  const buf = jsonBuf({ model: 'gpt-4', messages: [{ role: 'user', content: 'hello' }] });
  const r = redactBuffer(buf, CT);
  assert('no PII → original buffer returned (same ref)', r.buffer === buf);
  assert('no PII → redactions empty', r.redactions.length === 0);
}
{
  const r = redactBuffer(Buffer.from('not-json'), CT);
  assert('malformed JSON → no redactions', r.redactions.length === 0);
}

// ── redactBuffer — messages array ─────────────────────────────────────────────
section('redactBuffer — messages array');

{
  const input = jsonBuf({
    model: 'gpt-4',
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user',   content: 'My email is alice@example.com and SSN is 123-45-6789' },
    ],
  });
  const { buffer, redactions } = redactBuffer(input, CT);
  const out = parsed(buffer);

  assert('user message email redacted',
    out.messages[1].content.includes('[EMAIL]'));
  assert('user message SSN redacted',
    out.messages[1].content.includes('[SSN]'));
  assert('original email absent',
    !out.messages[1].content.includes('alice@example.com'));
  assert('system message untouched',
    out.messages[0].content === 'You are helpful.');
  assert('redactions array has 2 entries', redactions.length === 2);
  assert('redaction has role=user', redactions.every(r => r.role === 'user'));
}

// ── redactBuffer — block-content messages ─────────────────────────────────────
section('redactBuffer — block-content (OpenAI content array)');

{
  const input = jsonBuf({
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'My email is bob@example.com' },
        { type: 'image_url', image_url: { url: 'http://img.example.com/img.png' } },
      ],
    }],
  });
  const { buffer, redactions } = redactBuffer(input, CT);
  const out = parsed(buffer);
  const block = out.messages[0].content[0];
  const imgBlock = out.messages[0].content[1];

  assert('text block email redacted',      block.text.includes('[EMAIL]'));
  assert('image block untouched',          imgBlock.image_url.url.includes('http'));
  assert('redactions has 1 entry',         redactions.length === 1);
}

// ── redactBuffer — plain prompt field ─────────────────────────────────────────
section('redactBuffer — plain prompt field');

{
  const input = jsonBuf({ prompt: 'Call 415-555-1234 or email carol@test.com' });
  const { buffer, redactions } = redactBuffer(input, CT);
  const out = parsed(buffer);

  assert('phone redacted in prompt',  out.prompt.includes('[PHONE]'));
  assert('email redacted in prompt',  out.prompt.includes('[EMAIL]'));
  assert('redactions has 2 entries',  redactions.length === 2);
}

// ── redactBuffer — both messages and prompt present ───────────────────────────
section('redactBuffer — messages + prompt both present');

{
  const input = jsonBuf({
    prompt: 'token: sk-abc12345678901234567890',
    messages: [{ role: 'user', content: 'ssn 234-56-7890' }],
  });
  const { buffer, redactions } = redactBuffer(input, CT);
  const out = parsed(buffer);

  assert('prompt API key redacted',   out.prompt.includes('[API_KEY]'));
  assert('messages SSN redacted',     out.messages[0].content.includes('[SSN]'));
  assert('total redactions = 2',      redactions.length === 2);
}

// ── Idempotency — double-redact ───────────────────────────────────────────────
section('Idempotency — double-redact');

{
  const input = 'Email: alice@example.com';
  const first  = redactString(input).text;
  const second = redactString(first).text;
  assert('second pass does not double-wrap placeholder', first === second);
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(52)}`);
console.log(`Total: ${passed + failed}  ✓ ${passed} passed  ${failed ? `✗ ${failed} failed` : ''}`);
console.log(failed === 0 ? '\n✅ redactor.js — all tests passed.' : '\n❌ Some tests failed.');
process.exit(failed > 0 ? 1 : 0);
