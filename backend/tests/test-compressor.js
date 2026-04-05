'use strict';

/**
 * Unit tests for backend/utils/compressor.js
 * Run: node backend/tests/test-compressor.js
 */

const { compressString, compressBuffer, RULES } = require('../utils/compressor');

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

const CT = 'application/json';

// ── Rule inventory ────────────────────────────────────────────────────────────
section('Rule inventory');

const ruleNames = RULES.map(r => r.name);
const expectedRules = [
  'trailing-whitespace', 'excess-blank-lines', 'multiple-spaces',
  'repeated-exclamation', 'repeated-question', 'repeated-period',
  'ai-preamble', 'filler-openers',
  'verbose-connectives', 'verbose-instructions', 'redundant-qualifiers',
  'duplicate-sentences', 'trim',
];
assert('all expected rules present',    expectedRules.every(r => ruleNames.includes(r)));
assert('every rule has name + fn',      RULES.every(r => typeof r.name === 'string' && typeof r.fn === 'function'));
assert('every rule has enabled field',  RULES.every(r => typeof r.enabled === 'boolean'));

// ── Whitespace rules ──────────────────────────────────────────────────────────
section('Whitespace — trailing spaces');
{
  const out = compressString('hello   \nworld  \t');
  assert('trailing spaces stripped from lines', !out.match(/[ \t]+$/m));
}

section('Whitespace — excess blank lines');
{
  const out = compressString('line1\n\n\n\n\nline2');
  assert('3+ blank lines collapsed to one', out === 'line1\n\nline2');
}

section('Whitespace — multiple spaces');
{
  const out = compressString('too    many     spaces here');
  assert('runs of spaces collapsed', out === 'too many spaces here');
}

// ── Punctuation rules ─────────────────────────────────────────────────────────
section('Punctuation — repeated marks');
{
  assert('!! → !',    compressString('wow!!') === 'wow!');
  assert('!!! → !',   compressString('wow!!!') === 'wow!');
  assert('?? → ?',    compressString('really??') === 'really?');
  assert('.... → ...',compressString('hmm....') === 'hmm...');
  assert('...... → ...',compressString('hmm......') === 'hmm...');
}

// ── AI filler / boilerplate ───────────────────────────────────────────────────
section('AI preamble removal');
{
  assert('removes "As an AI language model,"',
    !compressString('As an AI language model, I can help.').includes('As an AI'));
  assert('removes "As a large language model,"',
    !compressString('As a large language model, here is my answer.').includes('large language model'));
}

section('Filler opener removal');
{
  assert('"Certainly! " removed',
    !compressString('Certainly! Here is the answer.').includes('Certainly'));
  assert('"Of course! " removed',
    !compressString('Of course! I can do that.').includes('Of course'));
  assert('"I\'d be happy to help" removed',
    !compressString("I'd be happy to help you with that.").includes("happy to help"));
  assert('"I hope this helps." removed',
    !compressString('I hope this helps. Let me know if you need more.').includes('I hope this helps'));
  assert('"Feel free to ask" sentence removed',
    !compressString('Feel free to ask any questions.').includes('Feel free'));
}

// ── Verbose connectives ───────────────────────────────────────────────────────
section('Verbose connectives');

const connectives = [
  ['In order to run this',          'To run this'],
  ['Due to the fact that it failed','Because it failed'],
  ['In the event that it breaks',   'If it breaks'],
  ['For the purpose of testing',    'To testing'],
  ['With respect to performance',   'For performance'],
  ['At this point in time',         'Now'],
  ['Prior to deployment',           'Before deployment'],
  ['Subsequent to the merge',       'After the merge'],
  ['A large number of users',       'Many users'],
  ['The majority of requests',      'Most requests'],
  ['Despite the fact that it works','Although it works'],
  ['It is important to note that',  'Note:'],
  ['Please note that',              'Note:'],
];

for (const [input, expected] of connectives) {
  const out = compressString(input);
  assert(`"${input.slice(0, 30)}" → starts with "${expected.slice(0, 20)}"`,
    out.startsWith(expected));
}

// ── Verbose instructions ──────────────────────────────────────────────────────
section('Verbose instructions');
{
  // verbose-instructions + post-cleanup: "Please make sure that you [verb]" → "[verb]..."
  assert('"Please make sure that you restart" reduces tokens',
    compressString('Please make sure that you restart the server.').length <
    'Please make sure that you restart the server.'.length);
  assert('"Make sure to save" reduces tokens',
    compressString('Make sure to save your work.').length < 'Make sure to save your work.'.length);
  assert('"You must ensure that all tests pass" reduces tokens',
    compressString('You must ensure that all tests pass.').length <
    'You must ensure that all tests pass.'.length);
}

// ── Redundant qualifiers ──────────────────────────────────────────────────────
section('Redundant qualifiers');
{
  assert('"very unique" → "unique"',
    compressString('This is very unique.') === 'This is unique.');
  assert('"absolutely certain" → "certain"',
    compressString('I am absolutely certain.') === 'I am certain.');
  assert('"basically" removed',
    !compressString('This is basically correct.').includes('basically'));
  assert('"literally" removed',
    !compressString('It literally works.').includes('literally'));
}

// ── Sentence deduplication ────────────────────────────────────────────────────
section('Sentence deduplication');
{
  const dup = 'Always validate input. Always validate input. Check the output.';
  const out = compressString(dup);
  const count = (out.match(/Always validate input/g) || []).length;
  assert('duplicate adjacent sentence removed', count === 1);
  assert('non-duplicate sentence kept', out.includes('Check the output'));
}
{
  // Different sentences must not be removed
  const unique = 'First sentence. Second sentence. Third sentence.';
  const out = compressString(unique);
  assert('unique sentences all kept', out.includes('First') && out.includes('Second') && out.includes('Third'));
}

// ── Idempotency ───────────────────────────────────────────────────────────────
section('Idempotency');
{
  const input = 'In order to test this, please make sure that you run the suite.';
  const first  = compressString(input);
  const second = compressString(first);
  assert('double-compress produces same result', first === second);
}

// ── compressBuffer — no-op cases ──────────────────────────────────────────────
section('compressBuffer — no-op cases');
{
  const r = compressBuffer(null, CT);
  assert('null buffer → report null',  r.report === null);
}
{
  const r = compressBuffer(Buffer.alloc(0), CT);
  assert('empty buffer → report null', r.report === null);
}
{
  const buf = jsonBuf({ messages: [{ role: 'user', content: 'hi' }] });
  const r = compressBuffer(buf, 'text/plain');
  assert('non-JSON content-type → original buffer ref', r.buffer === buf);
}
{
  // No compressible content — original buffer reference returned
  const buf = jsonBuf({ messages: [{ role: 'user', content: 'hi' }] });
  const r = compressBuffer(buf, CT);
  assert('nothing to compress → buffer same ref', r.buffer === buf);
  assert('nothing to compress → report null', r.report === null);
}
{
  const r = compressBuffer(Buffer.from('not-json'), CT);
  assert('malformed JSON → report null', r.report === null);
}

// ── compressBuffer — messages array ──────────────────────────────────────────
section('compressBuffer — messages array');
{
  const input = jsonBuf({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: 'As an AI language model, please make sure that you always respond helpfully.' },
      { role: 'user',   content: 'In order to understand recursion, please note that it is self-referential.' },
    ],
  });
  const { buffer, report } = compressBuffer(input, CT);
  const out = JSON.parse(buffer.toString('utf8'));

  assert('system message compressed',
    !out.messages[0].content.includes('As an AI language model'));
  assert('user message compressed',
    !out.messages[1].content.includes('In order to'));
  assert('report has originalTokens',    typeof report.originalTokens === 'number');
  assert('report has compressedTokens',  typeof report.compressedTokens === 'number');
  assert('report savedTokens > 0',       report.savedTokens > 0);
  assert('report savedPct 1–99',         report.savedPct >= 1 && report.savedPct <= 99);
  assert('compressedTokens < originalTokens', report.compressedTokens < report.originalTokens);
}

// ── compressBuffer — block-content (OpenAI content array) ────────────────────
section('compressBuffer — block-content');
{
  const input = jsonBuf({
    messages: [{
      role: 'user',
      content: [
        { type: 'text',      text: 'Certainly! In order to proceed, please make sure that you confirm.' },
        { type: 'image_url', image_url: { url: 'http://img.example.com/img.png' } },
      ],
    }],
  });
  const { buffer, report } = compressBuffer(input, CT);
  const out = JSON.parse(buffer.toString('utf8'));
  const textBlock = out.messages[0].content[0];
  const imgBlock  = out.messages[0].content[1];

  assert('text block compressed',   !textBlock.text.includes('Certainly'));
  assert('image block untouched',   imgBlock.image_url.url.includes('http'));
  assert('tokens saved > 0',        report.savedTokens > 0);
}

// ── compressBuffer — plain prompt field ──────────────────────────────────────
section('compressBuffer — plain prompt field');
{
  const input = jsonBuf({ prompt: 'In order to test this, please make sure that you run all the checks carefully.' });
  const { buffer, report } = compressBuffer(input, CT);
  const out = JSON.parse(buffer.toString('utf8'));

  assert('prompt compressed',       !out.prompt.includes('In order to'));
  assert('tokens saved > 0',        report.savedTokens > 0);
}

// ── Token savings sanity check ────────────────────────────────────────────────
section('Token savings — realistic system prompt');
{
  const verbose = [
    'As an AI language model, you are a helpful assistant.',
    'Please make sure that you always respond in a clear and concise manner.',
    'In order to assist the user effectively, please note that you should ask clarifying questions.',
    'It is important to note that you must ensure that your responses are accurate.',
    'Certainly, feel free to ask if you need any clarification.',
  ].join(' ');

  const input  = jsonBuf({ model: 'gpt-4o', messages: [{ role: 'system', content: verbose }] });
  const { report } = compressBuffer(input, CT);

  assert('at least 10 tokens saved on verbose system prompt', report && report.savedTokens >= 10);
  assert('at least 10% reduction',                            report && report.savedPct    >= 10);
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(52)}`);
console.log(`Total: ${passed + failed}  ✓ ${passed} passed  ${failed ? `✗ ${failed} failed` : ''}`);
console.log(failed === 0 ? '\n✅ compressor.js — all tests passed.' : '\n❌ Some tests failed.');
process.exit(failed > 0 ? 1 : 0);
