import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { parse } from 'svelte/compiler';
import { languages, detectLanguage, resolveLanguage, translate } from '../web/i18n-core.js';
import { trafficBytes } from '../web/traffic-format.ts';
const catalogs = Object.fromEntries(languages.map(({ code }) => [code, JSON.parse(readFileSync(new URL(`../web/locales/${code}.json`, import.meta.url), 'utf8'))]));
const placeholders = value => [...value.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();

test('browser preference order, regional variants, invalid values and explicit choices', () => {
  assert.equal(detectLanguage(['de-DE', 'pt-BR', 'en']), 'pt');
  for (const { code } of languages) assert.equal(detectLanguage([`${code.toUpperCase()}-XX`]), code);
  assert.equal(detectLanguage(['zh-Hant-TW']), 'zh');
  assert.equal(detectLanguage(['en-GB', 'es-ES']), 'en');
  assert.equal(detectLanguage([null, 123, 'xx']), 'en');
  assert.equal(detectLanguage([]), 'en');
  assert.equal(resolveLanguage('fr', ['es-ES']), 'fr');
  assert.equal(resolveLanguage('auto', ['es-MX']), 'es');
  assert.equal(resolveLanguage('<script>', ['ur-PK']), 'ur');
  assert.equal(resolveLanguage('toString', ['bn-BD']), 'bn');
  assert.deepEqual(languages.filter(l => l.dir === 'rtl').map(l => l.code), ['ar', 'ur']);
});

test('all ten catalogs cover every message with matching placeholders', () => {
  const keys = Object.keys(catalogs.en).sort();
  assert.ok(keys.length > 290);
  for (const { code } of languages) {
    assert.deepEqual(Object.keys(catalogs[code]).sort(), keys, `${code} keys`);
    for (const key of keys) {
      const value = catalogs[code][key];
      assert.equal(typeof value, 'string', `${code}: ${key}`);
      assert.ok(value.trim(), `${code}: ${key}`);
      assert.deepEqual(placeholders(value), placeholders(key), `${code}: ${key}`);
      if (code !== 'en' && !['LNbits NRM ·', 'Online', 'Offline', 'error', 'Aedos oracle URL'].includes(key)) assert.notEqual(value, key, `Untranslated ${code}: ${key}`);
    }
    assert.ok(catalogs[code]['Type CLEAR ALL NOTES to confirm'].includes('CLEAR ALL NOTES'));
  }
});

test('literal UI translation keys exist in the source catalog', () => {
  const found = new Set();
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'CallExpression' && node.callee?.name === '$t' && node.arguments[0]?.type === 'Literal') found.add(node.arguments[0].value);
    for (const [key, value] of Object.entries(node)) {
      if (key === 'loc') continue;
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  }
  const root = new URL('../web/', import.meta.url);
  for (const file of readdirSync(root).filter(name => name.endsWith('.svelte'))) visit(parse(readFileSync(new URL(file, root), 'utf8'), { modern: true }));
  for (const key of found) assert.ok(Object.hasOwn(catalogs.en, key), `Missing UI key: ${key}`);
  assert.ok(found.size > 240);
});

test('interpolation preserves unknown messages and never recursively substitutes values', () => {
  assert.equal(translate(catalogs.es, 'Sign out {author}', { author: '<script>{count}</script>' }), 'Cerrar sesión de <script>{count}</script>');
  assert.equal(translate(catalogs.fr, 'Provider-specific diagnostic'), 'Provider-specific diagnostic');
  assert.equal(translate(catalogs.ar, 'toString'), 'toString');
  assert.equal(translate(catalogs.en, 'Pending reviews: {count}.', { count: 0 }), 'Pending reviews: 0.');
  assert.equal(translate(catalogs.en, 'Pending reviews: {count}.'), 'Pending reviews: {count}.');
});

test('byte quantities use the chosen locale without changing units', () => {
  assert.equal(trafficBytes(1536, 'en'), '1.5 KiB');
  assert.equal(trafficBytes(1536, 'fr'), '1,5 KiB');
  assert.equal(trafficBytes(0, 'en'), '0 B');
  assert.equal(trafficBytes(25 * 1024 ** 3, 'en'), '25.0 GiB');
});
