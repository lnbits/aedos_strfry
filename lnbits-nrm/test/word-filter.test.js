import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { blockedByWords } from '../server/word-filter.js';
import { defaults, settingsSchema } from '../server/config.js';
import { Store } from '../server/store.js';
import { ReloadedPolicy as Policy } from './policy-helper.js';

const blocked = (text, block, allow = []) => blockedByWords(text, { block, allow });
test('word rules match case-insensitive whole words, phrases and whitespace', () => {
  assert.equal(blocked('A CAT!', ['cat']), true);
  assert.equal(blocked('catalog bobcat cats cat_name', ['cat']), false);
  assert.equal(blocked('GET\n\tRICH   QUICK now', ['get rich quick']), true);
  assert.equal(blocked('get very rich quick', ['get rich quick']), false);
  assert.equal(blocked('', ['cat']), false);
  assert.equal(blocked('cat', []), false);
});
test('Unicode normalization preserves boundaries for letters, marks and numbers', () => {
  assert.equal(blocked('ＣＡＴ', ['cat']), true);
  assert.equal(blocked('A CAFE\u0301!', ['café']), true);
  assert.equal(blocked('caféine écat caté cat42 42cat', ['cat', 'café']), false);
  assert.equal(blocked('cat\u0301', ['cat']), false);
});
test('punctuation and regex metacharacters are literal', () => {
  assert.equal(blocked('Use C++ today', ['c++']), true);
  assert.equal(blocked('Use C today', ['c++']), false);
  assert.equal(blocked('anything', ['.*', '(a+)+$', '[abc]']), false);
  assert.equal(blocked('Here is [abc].', ['[abc]']), true);
  assert.equal(blocked('hello, world', ['hello, world']), true);
  assert.equal(blocked('hello world', ['hello, world']), false);
});
test('allow-listed phrases exempt only fully contained blocked occurrences', () => {
  assert.equal(blocked('SCAM prevention tips', ['scam'], ['scam prevention']), false);
  assert.equal(blocked('scam prevention and another scam', ['scam'], ['scam prevention']), true);
  assert.equal(blocked('a scam, but safe', ['scam'], ['safe']), true);
  assert.equal(blocked('a scam', ['scam'], ['scam']), false);
  assert.equal(blocked('scam prevention tips', ['scam prevention'], ['scam']), true);
  assert.equal(blocked('words without an allowed term', [], ['safe']), false);
});
test('overlapping allowed and blocked phrases are all considered', () => {
  assert.equal(blocked('one two three', ['three'], ['one two', 'two three']), false);
  assert.equal(blocked('one two three', ['two three'], ['one two']), true);
  assert.equal(blocked('one two three four', ['two three', 'three four'], ['one two three']), true);
  assert.equal(blocked('one two three', ['one', 'one two'], ['one']), true);
});
test('settings normalize, deduplicate and bound word lists', () => {
  const value = settingsSchema.parse({ ...defaults, wordFilter: { block: [' SCAM ', 'scam', 'GET\tRICH'], allow: [] } });
  assert.deepEqual(value.wordFilter.block, ['scam', 'get rich']);
  for (const block of [[' '], ['a'.repeat(201)], Array(201).fill('word')]) {
    assert.throws(() => settingsSchema.parse({ ...defaults, wordFilter: { block, allow: [] } }));
  }
});
test('old settings acquire empty lists without losing policies or secrets; edits persist', t => {
  const dir = mkdtempSync(join(tmpdir(), 'lnbits-nrm-word-migration-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'db');
  let store = new Store(path);
  const { wordFilter, ...old } = store.settings();
  store.set('settings', { ...old, retentionDays: 80 });
  store.set('oracleKey', 'preserved-secret');
  store.close(); store = new Store(path);
  assert.deepEqual(store.settings().wordFilter, { allow: [], block: [] });
  assert.equal(store.settings().retentionDays, 80);
  assert.equal(store.get('oracleKey'), 'preserved-secret');
  assert.equal(store.settings().revision, old.revision + 1);
  store.saveSettings({ ...store.settings(), wordFilter: { allow: ['scam prevention'], block: ['scam'] } });
  store.close(); store = new Store(path);
  assert.deepEqual(store.settings().wordFilter, { allow: ['scam prevention'], block: ['scam'] });
  assert.equal(store.settings().revision, old.revision + 2);
  store.close();
});
test('word bans work without AI; exceptions still undergo other policies and moderation', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.saveSettings({ ...store.settings(), wordFilter: { allow: ['scam prevention'], block: ['scam'] } });
  const policy = new Policy(store);
  const event = { id: 'a'.repeat(64), pubkey: 'b'.repeat(64), content: 'scam', created_at: Math.floor(Date.now() / 1000), tags: [] };
  assert.equal(store.settings().moderation.provider, 'off');
  assert.match((await policy.decide({ type: 'new', event })).msg, /banned word or phrase/);
  assert.equal(store.reviewCount(), 0);
  assert.equal(store.decisions().length, 0, 'policy never writes Activity');
  store.saveSettings({ ...store.settings(), moderation: { ...defaults.moderation, provider: 'aedos', oracleUrl: 'http://localhost:1234' } });
  assert.equal((await policy.decide({ type: 'new', event: { ...event, content: 'scam prevention' } })).action, 'accept');
  assert.equal(store.reviewCount(), 0);
  store.saveSettings({ ...store.settings(), block: [event.pubkey] });
  assert.match((await policy.decide({ type: 'new', event: { ...event, content: 'scam prevention' } })).msg, /author is on the block list/);
  assert.equal(store.reviewCount(), 0);
});
