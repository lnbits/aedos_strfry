import { derived, writable, get } from 'svelte/store';
import { languages, storageKey, isSupported, resolveLanguage, translate } from './i18n-core.js';
import en from './locales/en.json';
export { languages };
type Catalog = Record<string, string>;
const catalogs: Record<string, Catalog> = { en };
const loaders: Record<string, () => Promise<{ default: Catalog }>> = {
  zh: () => import('./locales/zh.json'), hi: () => import('./locales/hi.json'),
  es: () => import('./locales/es.json'), fr: () => import('./locales/fr.json'),
  ar: () => import('./locales/ar.json'), bn: () => import('./locales/bn.json'),
  pt: () => import('./locales/pt.json'), ru: () => import('./locales/ru.json'),
  ur: () => import('./locales/ur.json'),
};
const pending = new Map<string, Promise<void>>();
let request = 0;
export const languageLoadError = writable(false);
export const preference = writable('auto');
export const locale = writable('en');
export const t = derived(locale, code => (key: string, values: Record<string, string | number> = {}) => translate(catalogs[code] ?? en, key, values));
export const number = derived(locale, code => new Intl.NumberFormat(code).format);
export const percent = derived(locale, code => new Intl.NumberFormat(code, { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 }).format);
export const days = derived(locale, code => new Intl.NumberFormat(code, { style: 'unit', unit: 'day', unitDisplay: 'long' }).format);
export const interval = derived(locale, code => (milliseconds: number) => new Intl.NumberFormat(code, { style: 'unit', unit: milliseconds < 3600000 ? 'minute' : 'hour', unitDisplay: 'long' }).format(milliseconds / (milliseconds < 3600000 ? 60000 : 3600000)));
export const datetime = derived(locale, code => (value: number) => new Date(value).toLocaleString(code));
export const time = derived(locale, code => (value: number) => new Date(value).toLocaleTimeString(code));
async function applyLanguage() {
  const id = ++request;
  let code = resolveLanguage(get(preference), navigator.languages?.length ? navigator.languages : [navigator.language]);
  let failed = false;
  if (!catalogs[code]) {
    const target = code;
    let download = pending.get(target);
    if (!download) {
      download = loaders[target]().then(module => { catalogs[target] = module.default; }).finally(() => { pending.delete(target); });
      pending.set(target, download);
    }
    try { await download; } catch { failed = true; code = 'en'; }
  }
  if (id !== request) return; // A slow download must not undo a newer selection.
  languageLoadError.set(failed);
  locale.set(code);
  document.documentElement.lang = code === 'zh' ? 'zh-Hans' : code;
  document.documentElement.dir = languages.find(language => language.code === code)!.dir;
}
export async function selectLanguage(value: string) {
  preference.set(isSupported(value) ? value : 'auto');
  try {
    if (get(preference) === 'auto') localStorage.removeItem(storageKey);
    else localStorage.setItem(storageKey, get(preference));
  } catch { /* Private browsing may deny persistent storage. Selection still works. */ }
  await applyLanguage();
}
export async function initializeLanguage() {
  let saved: string | null = null;
  try { saved = localStorage.getItem(storageKey); } catch { /* Use browser preferences. */ }
  preference.set(isSupported(saved) ? saved! : 'auto');
  await applyLanguage();
  const update = () => { if (get(preference) === 'auto') void applyLanguage(); };
  window.addEventListener('languagechange', update);
  return () => window.removeEventListener('languagechange', update);
}
