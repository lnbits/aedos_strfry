// UI-only fixtures: never connect to a running manager, Docker volume or relay.
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { preview } from 'vite';
import { chromium, expect } from '@playwright/test';
import { getPublicKey, nip19 } from 'nostr-tools';
import { languages } from '../web/i18n-core.js';

const server = await preview({ preview: { host: '127.0.0.1', port: 0, open: false } });
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
const pubkey = getPublicKey(new Uint8Array(32).fill(1)), npub = nip19.npubEncode(pubkey);
const catalogs = Object.fromEntries(await Promise.all(languages.map(async ({ code }) => [code, JSON.parse(await readFile(new URL(`../web/locales/${code}.json`, import.meta.url), 'utf8'))])));
const views = ['Overview', 'Traffic', 'Access lists', 'Word filters', 'Retention', 'Rate limits', 'AI moderation', 'Activity', 'Storage'];
const defaults = {
  allow: [], block: [], retentionDays: 0, retentionOverrides: [], wordFilter: { allow: [], block: [] }, rate: { perMinute: 60, perHour: 1000 },
  moderation: { provider: 'off', oracleUrl: '', model: 'omni-moderation-latest', blockWarnings: true, autoBan: false, failurePolicy: 'accept', timeoutSeconds: 15, maxMedia: 4, videoFrames: 3, blockedTags: [] },
  aiModerationEnabled: true, revision: 1, openaiKeySet: false, oracleKeySet: false,
};
let page;
const errors = [];
async function fixture(options = {}) {
  const context = await browser.newContext({ locale: 'es-MX', viewport: { width: 1440, height: 1000 }, ...options });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  let authenticated = false, settings = structuredClone(defaults);
  const writes = [];
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    let data;
    if (path === '/api/auth/session') data = { authenticated, configured: true, npub };
    else if (path === '/api/auth/challenge') data = { event: { kind: 27235, content: '', tags: [], created_at: 1 } };
    else if (path === '/api/auth/login') { authenticated = true; data = { authenticated, npub }; }
    else if (path === '/api/settings') {
      if (request.method() === 'PUT') { const payload = request.postDataJSON(); writes.push(payload); settings = { ...settings, ...payload, revision: settings.revision + 1 }; }
      data = settings;
    } else if (path === '/api/overview') data = {
      online: true, name: 'Relay fixture', relayUrl: 'wss://relay.example.test', eventCount: 12345, countedAt: Date.now(), databaseBytes: 1536,
      disk: { totalBytes: 100 * 1024 ** 3, usedBytes: 70 * 1024 ** 3, availableBytes: 25 * 1024 ** 3, reservedBytes: 5 * 1024 ** 3 },
      counters: { accept: 10000, reject: 2345 }, pluginEnabled: true, appliedRevision: settings.revision, policyRevision: settings.revision,
      reportingError: null, moderationQueue: 0, moderationError: null, error: null, uptimeSeconds: 500,
      maintenance: { type: 'retention', status: 'complete', startedAt: Date.now() - 10000, deleted: 1234, error: null },
    };
    else if (path === '/api/activity') data = { items: [{ seq: 1, event_id: '1'.repeat(64), pubkey, action: 'reject', reason: 'blocked: author is on the block list', labels: [], at: Math.floor(Date.now() / 1000) }] };
    else if (path === '/api/traffic') {
      const step = 15 * 60000, until = Math.floor(Date.now() / step) * step, from = until - 24 * 3600000;
      const points = Array.from({ length: 96 }, (_, i) => ({ at: from + i * step, accept: i * 5, reject: i % 7, bytes: i * 1024 }));
      data = { range: url.searchParams.get('range'), from, until, step, startedAt: from + step * 3, pluginEnabled: true, reportingError: null, error: null,
        points, totals: { accept: 12345, reject: 234, bytes: 1234567 }, nativePoints: points.map(p => ({ at: p.at, received: p.accept, sent: p.reject, events: p.bytes })), nativeTotals: { received: 12345, sent: 54321, events: 10000 } };
    } else throw Error(`Unexpected test API call: ${request.method()} ${path}`);
    await route.fulfill({ json: data });
  });
  await page.addInitScript(() => { window.nostr = { signEvent: async event => event }; });
  return { page, context, writes };
}
async function assertFits(page, description) {
  const overflow = await page.evaluate(() => {
    const width = innerWidth;
    return { ok: document.documentElement.scrollWidth <= width, offenders: [...document.querySelectorAll('body *')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.right > width + 1 || r.left < -1); }).slice(0, 8).map(e => `${e.tagName}.${e.className}`) };
  });
  assert.ok(overflow.ok, `${description}: ${overflow.offenders.join(', ')}`);
}
async function switchLanguage(page, code) {
  await page.locator('.language-picker select').selectOption(code);
  await expect(page.locator('html')).toHaveAttribute('lang', code === 'zh' ? 'zh-Hans' : code);
}
try {
  await mkdir('test-results', { recursive: true });
  const f = await fixture(); page = f.page;
  const downloaded = [];
  page.on('request', request => { if (/\/assets\/(?:zh|hi|es|fr|ar|bn|pt|ru|ur)-/.test(request.url())) downloaded.push(request.url()); });
  await page.goto(origin);
  await expect(page.locator('h1')).toHaveText(catalogs.es['Sign In']);
  await expect(page.locator('html')).toHaveAttribute('lang', 'es');
  assert.equal(downloaded.length, 1, 'only the detected language is downloaded');
  assert.ok(downloaded[0].includes('/es-'));
  await switchLanguage(page, 'fr');
  await page.reload();
  await expect(page.locator('h1')).toHaveText(catalogs.fr['Sign In']);
  assert.equal(await page.evaluate(() => localStorage.getItem('lnbits-nrm-language')), 'fr');
  await page.locator('.language-picker select').selectOption('auto');
  await expect(page.locator('html')).toHaveAttribute('lang', 'es');
  assert.equal(await page.evaluate(() => localStorage.getItem('lnbits-nrm-language')), null);
  await page.getByRole('button', { name: catalogs.es['Connect Nostr extension'] }).click();
  await expect(page.locator('h1')).toHaveText(catalogs.es.Operations);
  console.log('PASS browser detection, regional matching, lazy loading, remembered selection and automatic mode');

  for (const { code, dir } of languages) {
    const t = key => catalogs[code][key];
    await switchLanguage(page, code);
    await expect(page.locator('html')).toHaveAttribute('dir', dir);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const view of views) {
        await page.locator('.sidebar button').filter({ has: page.locator('.nav-label', { hasText: new RegExp(`^${t(view)}$`) }) }).click();
        await expect(page.locator('h1')).toHaveText(t(view === 'Overview' ? 'Operations' : view));
        if (view === 'Traffic') await page.getByRole('heading', { name: t('Publishing activity'), exact: true }).waitFor();
        await assertFits(page, `${code} ${width}px ${view}`);
        assert.ok(!(await page.locator('main').innerText()).match(/\{(?:count|author|time|heading|duration|percent)\}/), `${code}: no unsubstituted parameters`);
        if (view === 'AI moderation') {
          for (const provider of ['openai', 'aedos', 'off']) {
            await page.getByLabel(t('Provider'), { exact: true }).selectOption(provider);
            await assertFits(page, `${code} ${width}px ${provider}`);
          }
        }
      }
    }
    console.log(`PASS ${code}: all 9 pages, provider forms, desktop/mobile and ${dir} layout`);
  }

  await switchLanguage(page, 'ar');
  await page.locator('.sidebar button[title="' + catalogs.ar['Retention'] + '"]').click();
  await page.getByLabel(catalogs.ar['Keep events for (days)'], { exact: true }).fill('30');
  await page.getByLabel(catalogs.ar['Author npub'], { exact: true }).fill(npub);
  await page.getByLabel(catalogs.ar.Days, { exact: true }).fill('0');
  await page.getByRole('button', { name: catalogs.ar['Add override'], exact: true }).click();
  await page.getByRole('button', { name: catalogs.ar['Save policy'], exact: true }).click();
  await expect(page.locator('.notice')).toContainText(catalogs.ar['Policy saved. Allow a few seconds for strfry to apply a change between filtering and unrestricted publishing.']);
  assert.equal(f.writes.at(-1).retentionDays, 30);
  assert.deepEqual(f.writes.at(-1).retentionOverrides, [{ pubkey, days: 0 }]);
  await page.screenshot({ path: 'test-results/i18n-ar-retention-mobile.png', fullPage: true });
  await page.locator('.sidebar button[title="' + catalogs.ar.Storage + '"]').click();
  await page.getByRole('button', { name: catalogs.ar['Clear all notes…'], exact: true }).click();
  const confirm = page.getByRole('button', { name: catalogs.ar['Delete all events'], exact: true });
  await expect(confirm).toBeDisabled();
  await page.getByPlaceholder('CLEAR ALL NOTES').fill('امسح الكل');
  await expect(confirm).toBeDisabled();
  await page.getByPlaceholder('CLEAR ALL NOTES').fill('CLEAR ALL NOTES');
  await expect(confirm).toBeEnabled();
  await assertFits(page, 'Arabic confirmation');
  await page.getByRole('button', { name: catalogs.ar.Cancel, exact: true }).click();
  await page.locator('.sidebar button[title="' + catalogs.ar.Traffic + '"]').click();
  await page.getByRole('heading', { name: catalogs.ar['Relay messages'], exact: true }).waitFor();
  await page.getByRole('button', { name: catalogs.ar.Dark, exact: true }).click();
  await page.screenshot({ path: 'test-results/i18n-ar-traffic-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await switchLanguage(page, 'zh');
  await page.screenshot({ path: 'test-results/i18n-zh-traffic.png', fullPage: true });
  console.log('PASS Arabic saved policy preserves numeric/protocol fields and literal deletion guard');
  await f.context.close();

  const denied = await fixture({ locale: 'ur-PK' }); page = denied.page;
  await page.addInitScript(() => { Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Denied', 'SecurityError'); } }); });
  await page.goto(origin);
  await expect(page.locator('h1')).toHaveText(catalogs.ur['Sign In']);
  await switchLanguage(page, 'en');
  await expect(page.locator('h1')).toHaveText('Sign In');
  await denied.context.close();

  const fallback = await fixture({ locale: 'de-DE' }); page = fallback.page;
  await page.addInitScript(() => localStorage.setItem('lnbits-nrm-language', 'invalid'));
  await page.goto(origin);
  await expect(page.locator('h1')).toHaveText('Sign In');
  await page.evaluate(() => { Object.defineProperty(navigator, 'languages', { configurable: true, value: ['bn-BD'] }); window.dispatchEvent(new Event('languagechange')); });
  await expect(page.locator('h1')).toHaveText(catalogs.bn['Sign In']);
  await switchLanguage(page, 'en');
  await page.evaluate(() => { Object.defineProperty(navigator, 'languages', { configurable: true, value: ['es-ES'] }); window.dispatchEvent(new Event('languagechange')); });
  await expect(page.locator('h1')).toHaveText('Sign In');
  await fallback.context.close();

  const raced = await fixture({ locale: 'en-GB' }); page = raced.page;
  let releaseDownload;
  const downloadGate = new Promise(resolve => { releaseDownload = resolve; });
  await page.route('**/assets/fr-*.js', async route => { await downloadGate; await route.continue(); });
  await page.goto(origin);
  await expect(page.locator('h1')).toHaveText('Sign In');
  const frenchRequested = page.waitForRequest('**/assets/fr-*.js');
  await page.locator('.language-picker select').selectOption('fr');
  await frenchRequested;
  await switchLanguage(page, 'en');
  const frenchDownloaded = page.waitForResponse('**/assets/fr-*.js');
  releaseDownload();
  await frenchDownloaded;
  await page.waitForLoadState('networkidle');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('h1')).toHaveText('Sign In');
  await raced.context.close();
  console.log('PASS a slow language download cannot overwrite a newer selection');

  const failedDownload = await fixture({ locale: 'fr-FR' }); page = failedDownload.page;
  await page.route('**/assets/fr-*.js', route => route.abort());
  await page.goto(origin);
  await expect(page.locator('h1')).toHaveText('Sign In');
  await expect(page.locator('.language-error')).toBeVisible();
  await failedDownload.context.close();
  assert.deepEqual(errors, []);
  console.log('PASS unavailable storage, unsupported language, OS language changes, manual priority and failed-download fallback');
} catch (error) {
  await page?.screenshot({ path: 'test-results/i18n-failure.png', fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser.close();
  await new Promise(resolve => server.httpServer.close(resolve));
}
