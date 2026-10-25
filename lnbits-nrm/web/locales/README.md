# UI translations

Each JSON file maps the same English message keys to localized plain text. Keep all keys in every catalog, and preserve named placeholders such as `{count}`, `{time}` and `{author}`. Svelte escapes translations and interpolated values; do not add HTML. Brand names, protocol values, API keys, npubs and the literal `CLEAR ALL NOTES` confirmation are not translated.

Language metadata and browser matching are in `../i18n-core.js`; reactive stores and lazy catalog loading are in `../i18n.ts`. New languages need entries in both. Chinese uses Simplified Chinese; Arabic and Urdu are right to left. `Intl` handles numeric quantities, dates and grammatical units without assembling translated fragments.

Run `npm test`, `npm run check` and `npm run test:i18n:browser` from the app directory after edits. Browser tests use fixture data and never touch an existing relay database. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` if using an installed Chrome. Native-speaker wording improvements are welcome; keep policy semantics, especially allow-list priority, unlimited retention and irreversible deletion, intact.
