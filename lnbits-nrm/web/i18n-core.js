// Locale matching is independent of Svelte and safe in non-browser environments.
export const languages = [
  { code: 'en', name: 'English', dir: 'ltr' },
  { code: 'zh', name: '简体中文', dir: 'ltr' },
  { code: 'hi', name: 'हिन्दी', dir: 'ltr' },
  { code: 'es', name: 'Español', dir: 'ltr' },
  { code: 'fr', name: 'Français', dir: 'ltr' },
  { code: 'ar', name: 'العربية', dir: 'rtl' },
  { code: 'bn', name: 'বাংলা', dir: 'ltr' },
  { code: 'pt', name: 'Português', dir: 'ltr' },
  { code: 'ru', name: 'Русский', dir: 'ltr' },
  { code: 'ur', name: 'اردو', dir: 'rtl' },
];
export const storageKey = 'lnbits-nrm-language';
export const isSupported = value => languages.some(language => language.code === value);
export function detectLanguage(preferences = []) {
  for (const preference of preferences) {
    if (typeof preference !== 'string') continue;
    const base = preference.toLowerCase().split(/[-_]/)[0];
    if (isSupported(base)) return base;
  }
  return 'en';
}
export function resolveLanguage(choice, preferences) {
  return isSupported(choice) ? choice : detectLanguage(preferences);
}
export function interpolate(message, values = {}) {
  // Values are substituted once and rendered by Svelte as escaped text, never HTML.
  return message.replace(/\{(\w+)\}/g, (token, key) => Object.hasOwn(values, key) ? String(values[key]) : token);
}
export function translate(catalog, key, values = {}) {
  return interpolate(Object.hasOwn(catalog, key) ? catalog[key] : key, values);
}
