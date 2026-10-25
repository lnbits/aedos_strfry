import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaults } from '../server/config.js';
import { Moderator, publicAddress, mediaUrls, downloadMedia } from '../server/moderation.js';

const event = { id: 'a'.repeat(64), content: 'A normal note', tags: [] };
const settings = (provider = 'openai') => ({ ...structuredClone(defaults), revision: 1, moderation: { ...defaults.moderation, provider } });
const store = { get: key => key === 'openaiKey' ? 'test-openai-key' : 'test-oracle-key' };

test('SSRF protection rejects private, loopback, mapped and link-local addresses', async () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '::1', '::ffff:127.0.0.1', 'fe80::1', '0.0.0.0']) assert.equal(publicAddress(address), false, address);
  assert.equal(publicAddress('8.8.8.8'), true);
  await assert.rejects(downloadMedia('http://127.0.0.1/image.png', AbortSignal.timeout(1000)), /public IP/);
  await assert.rejects(downloadMedia('file:///etc/passwd', AbortSignal.timeout(1000)), /Unsafe/);
});
test('extracts direct media and extensionless imeta attachments without fetching ordinary links', () => {
  assert.deepEqual(mediaUrls({ content: 'See https://example.com/a.png?x=1 and https://example.com/page https://example.com/v.mp4.', tags: [['imeta', 'url https://cdn.example.com/file']] }), ['https://example.com/a.png?x=1', 'https://example.com/v.mp4', 'https://cdn.example.com/file']);
});
test('locally blocked tags never reach the provider', async () => {
  let calls = 0;
  const moderator = new Moderator(store, { fetch: async () => { calls++; throw new Error(); } });
  assert.equal((await moderator.review({ ...event, content: '#csam' }, settings())).status, 'block');
  assert.equal((await moderator.review({ ...event, tags: [['t', 'CSAM']] }, settings())).status, 'block');
  assert.equal(calls, 0);
});
test('OpenAI receives text and image bytes; severe flags block and verdicts cache by revision', async () => {
  let calls = 0;
  const moderator = new Moderator(store, {
    download: async () => ({ bytes: Buffer.from('test image'), mime: 'image/png' }),
    fetch: async (url, options) => {
      calls++;
      assert.equal(url, 'https://api.openai.com/v1/moderations');
      assert.equal(options.headers.authorization, 'Bearer test-openai-key');
      const body = JSON.parse(options.body);
      assert.equal(body.input[0].type, 'text');
      assert.match(body.input[1].image_url.url, /^data:image\/png;base64,/);
      return new Response(JSON.stringify({ results: [{ flagged: true, categories: { 'violence/graphic': true } }] }));
    }
  });
  const input = { ...event, content: 'https://example.com/image.png' };
  assert.equal((await moderator.review(input, settings())).status, 'block');
  await moderator.review(input, settings());
  assert.equal(calls, 1);
  await moderator.review(input, { ...settings(), revision: 2 });
  assert.equal(calls, 2);
});
test('malformed, failed and excess-media reviews become error verdicts', async () => {
  for (const response of [new Response('{}'), new Response('failure', { status: 503 })]) {
    const moderator = new Moderator(store, { fetch: async () => response });
    assert.equal((await moderator.review(event, settings())).status, 'error');
  }
  const moderator = new Moderator(store, { fetch: async () => { throw new Error('must not call'); } });
  const input = { ...event, tags: Array.from({ length: 5 }, (_, i) => ['imeta', `url https://example.com/${i}`]) };
  assert.equal((await moderator.review(input, settings())).status, 'error');
});
test('connected Aedos sends signed event with wait=true and propagates unknown', async () => {
  const moderator = new Moderator(store, { fetch: async (url, options) => {
    assert.equal(url, 'https://oracle.example.com/v1/check');
    assert.deepEqual(JSON.parse(options.body).raw_event, event);
    assert.equal(JSON.parse(options.body).wait, true);
    assert.equal(options.headers['x-api-key'], 'test-oracle-key');
    return new Response(JSON.stringify({ status: 'unknown', labels: ['unknown'] }));
  } });
  const s = settings('aedos'); s.moderation.oracleUrl = 'https://oracle.example.com/';
  assert.equal((await moderator.review(event, s)).status, 'unknown');
});
