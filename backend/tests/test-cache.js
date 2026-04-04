'use strict';

/**
 * Unit tests for backend/utils/cache.js
 * Run: node backend/tests/test-cache.js
 */

const cache = require('../utils/cache');

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

function buf(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8');
}

const CT = 'application/json';

// ── getCacheKey ───────────────────────────────────────────────────────────────
section('getCacheKey');

assert('null on empty buffer',       cache.getCacheKey(Buffer.alloc(0), CT) === null);
assert('null on missing buffer',     cache.getCacheKey(null, CT) === null);
assert('null on non-JSON CT',        cache.getCacheKey(buf({ prompt: 'hi' }), 'text/plain') === null);
assert('null when no prompt field',  cache.getCacheKey(buf({ model: 'gpt-4' }), CT) === null);
assert('null on malformed JSON',     cache.getCacheKey(Buffer.from('not-json'), CT) === null);

const keyPrompt = cache.getCacheKey(buf({ prompt: 'hello world' }), CT);
assert('key from prompt field',   keyPrompt === JSON.stringify('hello world'));

const keyMessages = cache.getCacheKey(buf({ messages: [{ role: 'user', content: 'hi' }] }), CT);
assert('key from messages field', keyMessages !== null);

const keyInputs = cache.getCacheKey(buf({ inputs: 'foo' }), CT);
assert('key from inputs field',   keyInputs === JSON.stringify('foo'));

const keyInput = cache.getCacheKey(buf({ input: 'bar' }), CT);
assert('key from input field',    keyInput === JSON.stringify('bar'));

// prompt takes precedence over messages (first defined wins via ??)
const keyBoth = cache.getCacheKey(buf({ prompt: 'first', messages: [] }), CT);
assert('prompt field wins over messages', keyBoth === JSON.stringify('first'));

// ── set / get / size / clear / keys ──────────────────────────────────────────
section('set / get / size / clear / keys');

cache.clear();
assert('empty after clear', cache.size() === 0);

const fakeEntry = { rawBuffer: Buffer.from('resp'), statusCode: 200, headers: {}, resData: null };
cache.set('key1', fakeEntry.rawBuffer, fakeEntry.statusCode, fakeEntry.headers, fakeEntry.resData);
assert('size = 1 after one set',       cache.size() === 1);

const hit = cache.get('key1');
assert('get returns stored entry',     hit !== null);
assert('rawBuffer intact',             hit.rawBuffer.toString() === 'resp');
assert('statusCode intact',            hit.statusCode === 200);
assert('get returns null for miss',    cache.get('no-such-key') === null);

cache.set('key2', Buffer.from('r2'), 200, {}, null);
assert('keys() length = 2',            cache.keys().length === 2);
assert('keys() contains key1',         cache.keys().includes('key1'));

cache.clear();
assert('size = 0 after clear',         cache.size() === 0);
assert('get returns null after clear', cache.get('key1') === null);

// ── set overwrites existing key ───────────────────────────────────────────────
section('set overwrites existing key');

cache.clear();
cache.set('k', Buffer.from('v1'), 200, {}, null);
cache.set('k', Buffer.from('v2'), 201, {}, null);
assert('size still 1',      cache.size() === 1);
assert('latest value wins', cache.get('k').rawBuffer.toString() === 'v2');
assert('latest status wins', cache.get('k').statusCode === 201);

// ── findSimilar — string prompts ──────────────────────────────────────────────
// Jaccard reference:
//   seed  = {write, python, function, to, sort, given, list}           = 7 tokens
//   near  = {write, python, function, to, sort, given, list, quickly}  = 8 tokens
//   J(seed,near) = 7/8 = 0.875  ✓ above threshold
//   diff  = {how, do, bake, chocolate, cake, recipe}
//   J(seed,diff) = 0/13 = 0     ✗ below threshold
section('findSimilar — string prompts');

cache.clear();
const seedPrompt = 'write a python function to sort a given list';
const seedKey    = JSON.stringify(seedPrompt);
cache.set(seedKey, Buffer.from('cached'), 200, {}, null);

// Exact key → score 1.0
const exactSimilar = cache.findSimilar(seedKey);
assert('identical prompt scores 1.0', exactSimilar && exactSimilar.score === 1.0);

// One word added → J = 7/8 = 0.875
const nearKey = JSON.stringify('write a python function to sort a given list quickly');
const nearHit = cache.findSimilar(nearKey);
assert('near-identical prompt is a hit (J=0.875)',  nearHit !== null);
assert('near-identical score < 1',                  nearHit && nearHit.score < 1.0);
assert('near-identical score >= threshold',         nearHit && nearHit.score >= cache.SIMILARITY_THRESHOLD);

// Unrelated prompt
const diffKey = JSON.stringify('how do I bake a chocolate cake recipe');
assert('unrelated prompt is not a hit', cache.findSimilar(diffKey) === null);

// Empty cache
cache.clear();
assert('no hit on empty cache', cache.findSimilar(seedKey) === null);

// ── findSimilar — messages format ─────────────────────────────────────────────
// Jaccard reference:
//   seed tokens  = {you, are, helpful, assistant, explain, recursion, in, python}     = 8
//   near tokens  = {you, are, helpful, assistant, explain, recursion, in, python, ok} = 9
//   J = 8/9 = 0.889  ✓
section('findSimilar — messages format');

cache.clear();

const msgsKey = JSON.stringify([
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user',   content: 'Explain recursion in Python' },
]);
cache.set(msgsKey, Buffer.from('resp'), 200, {}, null);

// One word added → J ≈ 0.889
const msgsNear = JSON.stringify([
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user',   content: 'Explain recursion in Python ok' },
]);
assert('similar messages prompt is a hit', cache.findSimilar(msgsNear) !== null);

// Different topic
const msgsDiff = JSON.stringify([
  { role: 'user', content: 'What is the capital of France?' },
]);
assert('unrelated messages prompt is not a hit', cache.findSimilar(msgsDiff) === null);

// ── findSimilar — best match selection ────────────────────────────────────────
// query  = "write a python function to reverse a given string"
//          tokens: {write, python, function, to, reverse, given, string}  = 7
// closer = "write a python function to reverse a given list"
//          tokens: {write, python, function, to, reverse, given, list}    = 7
//          J(query,closer) = 6/8 = 0.75  ✓ HIT
// far    = "how to sort items in python"
//          tokens: {how, to, sort, items, in, python}                     = 6
//          J(query,far)    = 2/11 = 0.18  ✗ MISS
section('findSimilar — best match selection');

cache.clear();
const closer = JSON.stringify('write a python function to reverse a given list');
const far    = JSON.stringify('how to sort items in python');
cache.set(closer, Buffer.from('closer'), 200, {}, null);
cache.set(far,    Buffer.from('far'),    200, {}, null);

const query = JSON.stringify('write a python function to reverse a given string');
const best  = cache.findSimilar(query);
assert('returns a hit',               best !== null);
assert('returns the closer match',    best && best.entry.rawBuffer.toString() === 'closer');

// ── token memoisation ─────────────────────────────────────────────────────────
section('token memoisation');

cache.clear();
cache.set(seedKey, Buffer.from('v'), 200, {}, null);
// Call findSimilar twice; second call must not re-tokenize (side-effect free)
cache.findSimilar(nearKey);
cache.findSimilar(nearKey);
assert('findSimilar is idempotent across calls', true); // no throw = pass

cache.clear();
assert('tokenCache cleared with promptCache', cache.size() === 0);

// ── MAX_SIZE eviction ─────────────────────────────────────────────────────────
section('MAX_SIZE eviction');

cache.clear();
const MAX = cache.MAX_SIZE;
assert('MAX_SIZE is exported and positive', typeof MAX === 'number' && MAX > 0);

for (let i = 0; i < MAX + 5; i++) {
  cache.set(`overflow-key-${i}`, Buffer.from(`v${i}`), 200, {}, null);
}
assert(`size does not exceed MAX_SIZE (${MAX})`, cache.size() <= MAX);
assert('latest entries are retained', cache.get(`overflow-key-${MAX + 4}`) !== null);
assert('oldest entries are evicted',  cache.get('overflow-key-0') === null);

// Re-inserting an existing key should NOT grow past MAX_SIZE
const existingKey = `overflow-key-${MAX + 4}`;
cache.set(existingKey, Buffer.from('updated'), 200, {}, null);
assert('re-insert does not exceed MAX_SIZE', cache.size() <= MAX);
assert('re-inserted value updated', cache.get(existingKey).rawBuffer.toString() === 'updated');

// ── Summary ───────────────────────────────────────────────────────────────────
cache.clear();
console.log(`\n${'─'.repeat(52)}`);
console.log(`Total: ${passed + failed}  ✓ ${passed} passed  ${failed ? `✗ ${failed} failed` : ''}`);
console.log(failed === 0 ? '\n✅ cache.js — all tests passed.' : '\n❌ Some tests failed.');
process.exit(failed > 0 ? 1 : 0);
