import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaults } from '../server/config.js';
import { policyDescription } from '../server/relay-info.js';
import { Relay } from '../server/relay.js';
import { Store } from '../server/store.js';

const key = 'a'.repeat(64), other = 'b'.repeat(64);
test('public policy explains retention exceptions and restrictions without exposing private rule values', () => {
  const settings = { ...structuredClone(defaults), retentionDays: 30, retentionOverrides: [{ pubkey: other, days: 7 }],
    allow: [key], block: [other], wordFilter: { block: ['private-block-phrase'], allow: ['private-exception'] },
    moderation: { ...defaults.moderation, provider: 'aedos', oracleUrl: 'https://private-oracle.example', model: 'private-model', autoBan: true },
    openaiKey: 'private-api-key', oracleKey: 'private-oracle-key' };
  const text = policyDescription('My relay', settings);
  assert.ok(text.startsWith('My relay\n\nRelay policy: '));
  assert.match(text, /30 days from event creation/);
  assert.match(text, /retention exceptions/);
  assert.match(text, /rolling basis approximately every five minutes/);
  assert.match(text, /60 attempts per UTC minute and 1000 attempts per UTC hour/);
  assert.match(text, /approval takes precedence/);
  assert.match(text, /Word and phrase filtering is enabled/);
  assert.match(text, /AI moderation reviews accepted events in the background/);
  for (const value of [key, other, 'private-block-phrase', 'private-exception', 'private-oracle.example', 'private-model', 'private-api-key', 'private-oracle-key']) {
    assert.equal(text.includes(value), false, value);
  }
});

test('unlimited defaults, finite exceptions and one disabled quota are described accurately', () => {
  const settings = { ...structuredClone(defaults), rate: { perMinute: 0, perHour: 0 } };
  let text = policyDescription('', settings);
  assert.match(text, /^Relay policy: Default age-based retention: unlimited/);
  assert.doesNotMatch(text, /five minutes/);
  assert.match(text, /No per-author publishing rate limits/);
  settings.retentionOverrides = [{ pubkey: key, days: 1 }];
  settings.rate.perHour = 42;
  text = policyDescription('', settings);
  assert.match(text, /retention exceptions/);
  assert.match(text, /five minutes/);
  assert.match(text, /42 attempts per UTC hour/);
  assert.doesNotMatch(text, /per UTC minute/);
});

test('metadata refreshes without plugin switches, stays escaped, and does not accumulate summaries', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'nrm-info-'));
  const store = new Store(':memory:');
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const base = 'Relay "quoted" \\ info\nsecond line';
  const relay = new Relay(store, { dataDir: dir, name: 'Example', description: base, relayUrl: 'wss://example.test' });
  relay.start = () => assert.fail('Metadata must not restart the relay');
  relay.stop = () => assert.fail('Metadata must not stop the relay');
  const description = async () => JSON.parse((await readFile(relay.config, 'utf8')).match(/^    description = (.*)$/m)[1]);
  await relay.configure();
  assert.ok((await description()).startsWith(base + '\n\n'));
  store.saveSettings({ ...store.settings(), retentionDays: 30 });
  await relay.applyPolicy();
  assert.equal(relay.pluginEnabled, true);
  assert.match(await description(), /30 days/);
  store.saveSettings({ ...store.settings(), retentionDays: 7 });
  await relay.applyPolicy();
  assert.match(await description(), /7 days/);
  assert.doesNotMatch(await description(), /30 days/);
  assert.equal((await description()).split('Relay policy:').length, 2);
  store.saveSettings({ ...store.settings(), retentionDays: 0, rate: { perMinute: 0, perHour: 0 } });
  await relay.applyPolicy();
  assert.equal(relay.pluginEnabled, false);
  assert.match(await description(), /unlimited/);
  store.banAuthor(other); await relay.applyPolicy();
  assert.match(await description(), /Author blocking is enabled/);
  assert.equal((await description()).includes(other), false);
});
