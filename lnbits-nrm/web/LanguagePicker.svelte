<script lang="ts">
  import { languages, preference, selectLanguage, languageLoadError, t } from './i18n';
</script>
<label class="language-picker">
  <span aria-hidden="true">◎</span>
  <select aria-label={$t('Language')} value={$preference} onchange={event => selectLanguage(event.currentTarget.value)}>
    <option value="auto">{$t('Automatic (browser)')}</option>
    {#each languages as language}
      <option value={language.code} lang={language.code} dir={language.dir as 'ltr' | 'rtl'}>{language.name}</option>
    {/each}
  </select>
</label>

{#if $languageLoadError}<span class="language-error" role="status">{$t('Language download failed. Showing English; reload the page to retry.')}</span>{/if}
