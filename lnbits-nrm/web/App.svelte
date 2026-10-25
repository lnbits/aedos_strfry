<script lang="ts">
  import { t, locale, number, datetime, days } from './i18n';
  import { onMount } from 'svelte';
  import LanguagePicker from './LanguagePicker.svelte';
  import Traffic from './Traffic.svelte';
  import DiskSpace from './DiskSpace.svelte';
  import { trafficBytes as formatBytes } from './traffic-format';
  import { nip19 } from 'nostr-tools';
  import type { Settings, Overview, Session, Decision, NostrEvent } from './types';

  type View = 'traffic' | 'overview' | 'access' | 'words' | 'retention' | 'rates' | 'moderation' | 'activity' | 'storage';
  const views: { id: View; label: string; icon: string }[] = [
    { id: 'overview', label: 'Overview', icon: '⌂' }, { id: 'traffic', label: 'Traffic', icon: '↗' }, { id: 'access', label: 'Access lists', icon: '☷' },
    { id: 'words', label: 'Word filters', icon: '≡' },
    { id: 'retention', label: 'Retention', icon: '◷' }, { id: 'rates', label: 'Rate limits', icon: '⇅' },
    { id: 'moderation', label: 'AI moderation', icon: '◇' }, { id: 'activity', label: 'Activity', icon: '▦' },
    { id: 'storage', label: 'Storage', icon: '⚙' }
  ];
  let active = $state<View>('overview');
  let trafficRefresh = $state(0);
  let session = $state<Session>({ authenticated: false });
  let settings = $state<Settings | null>(null);
  let overview = $state<Overview | null>(null);
  let activity = $state<Decision[]>([]);
  let loading = $state(true);
  let signing = $state(false);
  let saving = $state(false);
  let baseline = $state('');
  let theme = $state<'light' | 'dark'>('light');
  let notice = $state('');
  let error = $state('');
  let connectionError = $state('');
  let allowInput = $state('');
  let blockInput = $state('');
  let overrideInput = $state('');
  let overrideDays = $state(90);
  let openaiKey = $state('');
  let oracleKey = $state('');
  let removeOpenaiKey = $state(false);
  let removeOracleKey = $state(false);
  let blockedTags = $state('');
  let allowedWords = $state('');
  let blockedWords = $state('');
  let showClear = $state(false);
  let clearText = $state('');
  let jobPending = $state(false);
  let activityFilter = $state('all');
  let moreActivity = $state(true);
  let loadingActivity = $state(false);
  let clock = $state(Date.now());

  const brandLogo = $derived(theme === 'light' ? '/images/lnbits-nrm-mark-light.svg' : '/images/lnbits-nrm-mark-dark.svg');
  const policyView = $derived(['access', 'words', 'retention', 'rates', 'moderation'].includes(active) && !(active === 'moderation' && settings?.aiModerationEnabled === false));
  const dirty = $derived(Boolean(settings && (JSON.stringify(settings) !== baseline || openaiKey || oracleKey || removeOpenaiKey || removeOracleKey || blockedTags !== settings.moderation.blockedTags.join(', ') || allowedWords !== settings.wordFilter.allow.join('\n') || blockedWords !== settings.wordFilter.block.join('\n'))));
  const visibleActivity = $derived(activity.filter(row => activityFilter === 'all' || row.action === activityFilter));
  const maintenanceBusy = $derived(jobPending || overview?.maintenance?.status === 'running');
  const title = $derived(views.find(v => v.id === active)?.label ?? 'Overview');
  const short = (value: string | undefined) => value ? `${value.slice(0, 13)}…${value.slice(-6)}` : '—';
  const asNpub = (value: string) => nip19.npubEncode(value);
  const duration = (count: number) => count === 0 ? $t("Forever") : $days(count);
  const date = (value: number) => $datetime(value);

  function applyTheme(next: 'light' | 'dark') {
    theme = next;
    document.documentElement.dataset.theme = next;
    document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.setAttribute('href', `/images/lnbits-nrm-mark-${next}.svg`);
    try { localStorage.setItem('lnbits-nrm-theme', next); } catch { /* Storage may be unavailable. */ }
  }
  async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const response = await fetch(`/api${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 401) session = { authenticated: false, configured: true };
      throw new Error(data.error ?? 'Request failed');
    }
    return data;
  }
  function report(value: unknown) { error = value instanceof Error ? value.message : 'Something went wrong'; notice = ''; }
  function acceptSettings(value: Settings) {
    settings = value; baseline = JSON.stringify(value); blockedTags = value.moderation.blockedTags.join(', ');
    allowedWords = value.wordFilter.allow.join('\n'); blockedWords = value.wordFilter.block.join('\n');
    openaiKey = ''; oracleKey = ''; removeOpenaiKey = false; removeOracleKey = false;
  }
  async function refreshOverview() {
    try {
      overview = await api<Overview>('/overview'); connectionError = '';
      if (settings && !dirty && overview.policyRevision !== settings.revision) {
        const updated = await api<Settings>('/settings');
        if (!dirty) acceptSettings(updated);
      }
    }
    catch (value) { connectionError = value instanceof Error ? value.message : 'Could not reach LNbits NRM'; }
  }
  async function loadActivity(older = false) {
    if (loadingActivity) return;
    loadingActivity = true;
    try {
      const cursor = older && activity.length ? `?before=${activity[activity.length - 1].seq}` : '';
      const data = await api<{ items: Decision[] }>(`/activity${cursor}`);
      activity = older ? [...activity, ...data.items] : data.items;
      moreActivity = data.items.length === 50;
    } catch (value) { report(value); }
    finally { loadingActivity = false; }
  }
  async function loadDashboard() {
    const [value] = await Promise.all([api<Settings>('/settings'), refreshOverview(), loadActivity()]);
    acceptSettings(value);
  }
  async function initialise() {
    loading = true; error = '';
    try { session = await api<Session>('/auth/session'); if (session.authenticated) await loadDashboard(); }
    catch (value) { report(value); }
    finally { loading = false; }
  }
  async function signIn() {
    signing = true; error = '';
    try {
      if (!window.nostr) throw new Error('No Nostr extension found. Enable a NIP-07 browser extension, then try again.');
      const { event } = await api<{ event: NostrEvent }>('/auth/challenge', 'POST', {});
      const signed = await window.nostr.signEvent(event);
      session = await api<Session>('/auth/login', 'POST', { event: signed });
      await loadDashboard();
    } catch (value) { report(value); }
    finally { signing = false; }
  }
  async function logout() {
    if (dirty && !window.confirm($t("Discard unsaved policy changes and sign out?"))) return;
    try {
      await api('/auth/logout', 'POST', {});
      session = { authenticated: false, configured: true }; settings = null; overview = null; activity = [];
      openaiKey = ''; oracleKey = ''; error = ''; notice = '';
    } catch (value) { report(value); }
  }
  function parseKey(value: string): string {
    if (/^[a-f0-9]{64}$/i.test(value.trim())) return value.trim().toLowerCase();
    try { const decoded = nip19.decode(value.trim()); if (decoded.type === 'npub') return decoded.data; } catch {}
    throw new Error('Enter a valid npub or 64-character hex public key.');
  }
  function addKeys(list: 'allow' | 'block') {
    if (!settings) return;
    try {
      const input = list === 'allow' ? allowInput : blockInput;
      const keys = input.split(/[\s,]+/).filter(Boolean).map(parseKey);
      if (!keys.length) return;
      settings[list] = [...new Set([...settings[list], ...keys])];
      if (list === 'allow') allowInput = ''; else blockInput = '';
      error = '';
    } catch (value) { report(value); }
  }
  function addOverride() {
    if (!settings) return;
    try {
      const key = parseKey(overrideInput);
      if (!Number.isInteger(overrideDays) || overrideDays < 0 || overrideDays > 36500) throw new Error('Retention must be between 0 and 36,500 days.');
      if (settings.retentionOverrides.some(r => r.pubkey === key)) throw new Error('This author already has an override. Edit its period below.');
      settings.retentionOverrides.push({ pubkey: key, days: overrideDays }); overrideInput = ''; error = '';
    } catch (value) { report(value); }
  }
  async function save() {
    if (!settings) return;
    saving = true; error = ''; notice = '';
    try {
      const { openaiKeySet, oracleKeySet, aiModerationEnabled, ...value } = settings;
      const payload = { ...value, wordFilter: { allow: allowedWords.split('\n').map(v => v.trim()).filter(Boolean), block: blockedWords.split('\n').map(v => v.trim()).filter(Boolean) },
        moderation: { ...value.moderation, blockedTags: blockedTags.split(/[\s,]+/).filter(Boolean) },
        ...(openaiKey || removeOpenaiKey ? { openaiKey: removeOpenaiKey ? '' : openaiKey } : {}),
        ...(oracleKey || removeOracleKey ? { oracleKey: removeOracleKey ? '' : oracleKey } : {}) };
      acceptSettings(await api<Settings>('/settings', 'PUT', payload));
      notice = 'Policy saved. Allow a few seconds for strfry to apply a change between filtering and unrestricted publishing.';
    } catch (value) { report(value); }
    finally { saving = false; }
  }
  async function discard() {
    if (dirty && !window.confirm($t("Discard your unsaved changes and reload the saved policy?"))) return;
    try { acceptSettings(await api<Settings>('/settings')); error = ''; notice = ''; } catch (value) { report(value); }
  }
  async function runJob(type: 'clear' | 'retention') {
    jobPending = true; error = ''; notice = '';
    try {
      await api(type === 'clear' ? '/events/clear' : '/retention/run', 'POST', type === 'clear' ? { confirmation: clearText } : {});
      showClear = false; clearText = '';
      await refreshOverview(); notice = type === 'clear' ? 'Clear-all job started. Progress appears below.' : 'Retention cleanup started using the saved policy.';
    } catch (value) { report(value); }
    finally { jobPending = false; }
  }
  async function banAuthor(row: Decision) {
    if (dirty) { error = 'Save or discard your policy changes before banning an author.'; return; }
    try {
      acceptSettings(await api<Settings>(`/activity/${row.seq}/ban`, 'POST', {}));
      notice = settings?.allow.includes(row.pubkey)
        ? 'Added to the block list. This author is still allowed by your authoritative allow list.'
        : 'Author added to the block list.';
      error = '';
    } catch (value) { report(value); }
  }
  function openDialog(node: HTMLDialogElement) { node.showModal(); }
  function navigate(view: View) { active = view; notice = ''; if (view === 'activity') void loadActivity(); }

  onMount(() => {
    try { applyTheme((localStorage.getItem('lnbits-nrm-theme') ?? localStorage.getItem('aedos-theme')) === 'dark' ? 'dark' : 'light'); } catch { applyTheme('light'); }
    void initialise();
    const timer = setInterval(() => { clock = Date.now(); if (session.authenticated) { void refreshOverview(); if (active === 'activity' && activity.length <= 50) void loadActivity(); } }, 5000);
    const beforeUnload = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); };
    window.addEventListener('beforeunload', beforeUnload);
    return () => { clearInterval(timer); window.removeEventListener('beforeunload', beforeUnload); };
  });
</script>

<svelte:head><title>{$t("LNbits NRM ·")} {session.authenticated ? $t(title) : $t("Sign in")}</title></svelte:head>

{#if loading || !session.authenticated}
  <main class="auth-shell">
    <div class="auth-controls"><LanguagePicker /><button class="theme-toggle" onclick={() => applyTheme(theme === 'light' ? 'dark' : 'light')}>{theme === 'light' ? $t("Dark") : $t("Light")}</button></div>
    <section class="auth-panel login-panel">
      <div class="brand" title="LNbits Nostr Relay Manager"><img src={brandLogo} alt="" />LNbits NRM</div>
      <p class="eyebrow">LNbits Nostr Relay Manager</p>
      <h1>{loading ? $t("Connecting") : $t("Sign In")}</h1>
      <p class="description">{$t("Your relay. Your rules. Sign in with your Nostr extension to manage LNbits NRM.")}</p>
      {#if !loading}
        {#if session.configured === false}
          <div class="callout"><strong>{$t("Set your operator key")}</strong><p>{$t("Add your public npub to ADMIN_NPUBS in the Docker environment and restart the container. Management stays locked until an operator is configured.")}</p></div>
        {/if}
        <button class="primary login-button" disabled={signing || session.configured === false} onclick={signIn}>{signing ? $t("Approve in your extension…") : $t("Connect Nostr extension")} <span aria-hidden="true">↗</span></button>
        <p class="muted">{$t("LNbits NRM asks you to sign a one-time challenge. Your private key stays in your extension.")}</p>
        <p class="muted"><a href="https://chromewebstore.google.com/detail/nos2x/kpgefcfmnafjgpblomihpgmejjdanjjp" target="_blank" rel="noopener noreferrer">{$t("Use a Chrome extension like nos2x.")}</a></p>
      {/if}
      {#if error}<p class="error-box" role="alert">{$t(error)}</p><button onclick={initialise}>{$t("Retry connection")}</button>{/if}
    </section>
  </main>
{:else}
  <main class="app-shell">
    <header class="topbar">
      <div class="brand" title="LNbits Nostr Relay Manager"><img src={brandLogo} alt="" />LNbits NRM</div>
      <nav aria-label={$t("Primary")}><button class:active={active === 'overview'} onclick={() => navigate('overview')}>{$t("Overview")}</button><button class:active={active === 'traffic'} onclick={() => navigate('traffic')}>{$t("Traffic")}</button><button class:active={policyView} onclick={() => navigate('access')}>{$t("Relay policy")}</button><button class:active={active === 'activity'} onclick={() => navigate('activity')}>{$t("Activity")}</button></nav>
      <LanguagePicker /><button class="theme-toggle" onclick={() => applyTheme(theme === 'light' ? 'dark' : 'light')}>{theme === 'light' ? $t("Dark") : $t("Light")}</button>
      <button class="ghost account" title={$t("Sign out {author}", { author: session.npub ?? "" })} onclick={logout}>{short(session.npub)} ↗</button>
    </header>
    <aside class="sidebar">
      {#each views as view}<button class:active={active === view.id} aria-current={active === view.id ? 'page' : undefined} title={$t(view.label)} onclick={() => navigate(view.id)}><span class="nav-icon" aria-hidden="true">{view.icon}</span><span class="nav-label">{$t(view.label)}</span></button>{/each}
      <div class="sidebar-foot"><span class="eyebrow">{$t("POWERED BY STRFRY")}</span><p>{$t("One relay. One control surface.")}</p></div>
    </aside>
    <section class="content">
      <div class="page-head"><div><p class="eyebrow">{active === 'overview' ? $t("Relay Manager") : policyView ? $t("Relay Policy") : $t("Relay Operations")}</p><div class="title-row"><h1>{active === 'overview' ? $t("Operations") : $t(title)}</h1>{#if active === 'overview'}<span class={`live-indicator ${overview?.online && !connectionError ? 'live' : ''}`}><span></span>{connectionError ? $t("Disconnected") : overview?.online ? $t("Online") : $t("Offline")}</span>{/if}</div></div><button onclick={() => { void refreshOverview(); if (active === 'activity') void loadActivity(); if (active === 'traffic') trafficRefresh++; }}>{$t("Refresh")}</button></div>
      {#if connectionError}<div class="error-box" role="alert">{$t(connectionError)}{$t(". Displayed relay data may be out of date.")}</div>{/if}
      {#if error}<div class="error-box" role="alert">{$t(error)}<button class="ghost" aria-label={$t("Dismiss error")} onclick={() => error = ''}>×</button></div>{/if}
      {#if notice}<div class="notice" role="status">{$t(notice)}<button class="ghost" aria-label={$t("Dismiss notice")} onclick={() => notice = ''}>×</button></div>{/if}
      {#if !settings}
        <div class="panel"><p>{$t("Could not load your relay policy.")}</p><button onclick={initialise}>{$t("Retry")}</button></div>
      {:else if active === 'overview'}
        <section class="stats-grid">
          <article><span>{$t("Stored Events")}</span><strong>{overview?.eventCount == null ? '—' : $number(overview.eventCount)}</strong></article>
          <article><span>{$t("Policy Accepted")}</span><strong>{overview ? $number(overview.counters.accept) : '—'}</strong></article>
          <article><span>{$t("Policy Rejected")}</span><strong>{overview ? $number(overview.counters.reject) : '—'}</strong></article>
          <article><span>{$t("Database Size")}</span><strong class="size-stat"><bdi dir="ltr">{overview ? formatBytes(overview.databaseBytes, $locale) : '—'}</bdi></strong></article>
        </section>
        <DiskSpace disk={overview?.disk} loading={!overview} />
        <section class="status-band">
          <div><span>{$t("Access Policy")}</span><strong>{settings.allow.length ? $t("Allow list") : settings.block.length ? $t("Block list") : $t("Open publishing")}</strong></div>
          <div><span>{$t("Default Retention")}</span><strong>{duration(settings.retentionDays)}</strong></div>
          <div><span>{$t("Per Author / Minute")}</span><strong>{settings.rate.perMinute ? $number(settings.rate.perMinute) : $t("Unlimited")}</strong></div>
          <div><span>{$t("AI Moderation")}</span><strong>{!settings.aiModerationEnabled ? $t("Unavailable") : settings.moderation.provider === 'off' ? $t("Disabled") : settings.moderation.provider === 'openai' ? 'OpenAI' : 'Aedos oracle'}</strong></div>
        </section>
        {#if overview?.reportingError}<div class="error-box" role="alert">{$t(overview.reportingError)}</div>{/if}
        {#if dirty}<p class="helper draft-note">{$t("The policy summary includes unsaved changes. Save your policy to apply them.")}</p>{/if}
        <section class="relay-panel"><header><span>{$t("Nostr Relay")}</span><strong>{overview?.name ?? 'LNbits NRM'}</strong></header><div class="relay-row"><span class={`relay-dot ${overview?.online && !connectionError ? 'online' : ''}`}></span><code class="relay-url">{overview?.relayUrl ?? $t("Connecting…")}</code><span class="relay-state">{overview?.online && !connectionError ? $t('online') : $t('offline')}</span></div><div class="panel-copy"><p>{$t("Author lists, rate limits, and word filters apply before acceptance.")} {#if settings.aiModerationEnabled}{$t("When enabled, AI reviews accepted notes in the background and removes notes that fail review.")} {/if}{$t("Anyone can read public events.")}</p><p class="muted">{overview?.pluginEnabled ? $t("Policy plugin active.") : $t("Policy plugin bypassed; detailed Activity is not collected.")} {$t("Policy counts are background observations, not final LMDB commits.")} {overview?.countedAt ? $t("Stored-event count updated {time}.", { time: date(overview.countedAt) }) : $t("Counting stored events…")}</p></div></section>
        <div class="two-column overview-actions"><button class="action-card" onclick={() => navigate('access')}><span>{$t("01 / ACCESS")}</span><strong>{$t("Choose who can publish")}</strong><p>{$t("Manage your allow and block lists.")}</p><b aria-hidden="true">↗</b></button><button class="action-card" onclick={() => navigate('moderation')}><span>{$t("02 / MODERATION")}</span><strong>{settings.aiModerationEnabled ? $t("Review in the background") : $t("AI moderation unavailable")}</strong><p>{settings.aiModerationEnabled ? $t("Connect AI to vet text and media.") : $t("Disabled by your server operator.")}</p><b aria-hidden="true">↗</b></button></div>
      {:else if active === 'traffic'}
        <Traffic {api} refresh={trafficRefresh} />
      {:else if active === 'access'}
        <p class="intro">{$t("Control which authors can publish to your relay. Read access to public events is unaffected.")}</p>
        <div class="callout"><strong>{$t("The allow list is the authority")}</strong><p>{$t("When it contains any npubs, only those authors can publish—even if they also appear on the block list. When it is empty, the block list applies. If both are empty, neither list restricts publishing.")}</p></div>
        <div class="two-column">
          {#each ['allow', 'block'] as listName}
            {@const list = listName as 'allow' | 'block'}
            <section class="panel list-panel"><div class="panel-heading"><h2>{list === 'allow' ? $t("Allow list") : $t("Block list")}</h2><span class="badge">{$number(settings[list].length)}</span></div><p class="helper">{list === 'allow' ? $t("Only these authors can publish when this list is populated.") : settings.allow.length ? $t("Inactive while the allow list is populated.") : $t("These authors cannot publish.")}</p>
              <form onsubmit={(e) => { e.preventDefault(); addKeys(list); }}><label for={`${list}-input`}>{$t("Add npubs")}</label>{#if list === 'allow'}<textarea id={`${list}-input`} dir="ltr" bind:value={allowInput} placeholder={$t("npub1… · one per line or comma separated")} rows="3"></textarea>{:else}<textarea id={`${list}-input`} dir="ltr" bind:value={blockInput} placeholder={$t("npub1… · one per line or comma separated")} rows="3"></textarea>{/if}<button type="submit">{list === 'allow' ? $t("Add to allow list") : $t("Add to block list")}</button></form>
              <div class="key-list">{#each settings[list] as key}<div class="key-row"><code title={asNpub(key)}>{asNpub(key)}</code><button class="ghost" aria-label={$t("Remove {author} from list", { author: asNpub(key) })} onclick={() => { if (settings) settings[list] = settings[list].filter(k => k !== key); }}>×</button></div>{:else}<p class="empty">{$t("No authors in this list.")}</p>{/each}</div>
            </section>
          {/each}
        </div>
      {:else if active === 'words'}
        <p class="intro">{$t("Block words and phrases in incoming note text, with allowed phrases as exceptions. These local rules work even when AI moderation is disabled.")}</p>
        <div class="two-column">
          <section class="panel"><h2>{$t("Blocked words & phrases")}</h2><label>{$t("Block list")}<textarea aria-label={$t("Blocked words and phrases")} bind:value={blockedWords} rows="8" placeholder={$t("One word or phrase per line")}></textarea><small>{$t("One entry per line. Up to 200 entries, each up to 200 characters. Leave empty to disable word blocking.")}</small></label></section>
          <section class="panel"><h2>{$t("Allowed words & phrases")}</h2><label>{$t("Allow list")}<textarea aria-label={$t("Allowed words and phrases")} bind:value={allowedWords} rows="8" placeholder={$t("One exception per line")}></textarea><small>{$t("An allowed phrase exempts blocked matches fully contained inside it. Other blocked occurrences in the note still reject it.")}</small></label></section>
        </div>
        <div class="callout"><strong>{$t("Whole words, literal phrases")}</strong><p>{$t("Matching ignores letter case and repeated whitespace, and normalizes Unicode text. Words must have boundaries: blocking “cat” does not block “catalog”. Punctuation is literal; entries are not regular expressions.")}</p><p>{$t("For example, block “scam” and allow “scam prevention”. “Scam prevention tips” passes this filter; “scam prevention and another scam” is rejected.")}</p><p>{$t("Allowing a phrase does not bypass author lists, rate limits, blocked topic tags, or AI moderation. Rules check the text in new events; they do not scan media, decrypt private messages, or delete existing notes.")}</p></div>
      {:else if active === 'retention'}
        <p class="intro">{$t("Set how long relay events are kept, measured from their Nostr creation time. Cleanup runs every five minutes.")}</p>
        <section class="panel"><h2>{$t("Default retention")}</h2><div class="field-grid"><label>{$t("Keep events for (days)")}<input type="number" min="0" max="36500" step="1" aria-label={$t("Keep events for (days)")} bind:value={settings.retentionDays} /><small>{$t("Use 0 to keep forever. Applies to all stored event kinds unless the author has an override.")}</small></label><div class="field-note"><strong>{duration(settings.retentionDays)}</strong><p>{$t("Older incoming events are rejected immediately. Stored events beyond their effective period are removed by the next cleanup.")}</p></div></div></section>
        <section class="panel"><div class="panel-heading"><h2>{$t("Author overrides")}</h2><span class="badge">{$number(settings.retentionOverrides.length)}</span></div><p class="helper">{$t("An author's period replaces the default. Use a longer, shorter, or unlimited period.")}</p><form class="override-form" onsubmit={(e) => { e.preventDefault(); addOverride(); }}><label>{$t("Author npub")}<input dir="ltr" bind:value={overrideInput} placeholder="npub1…" required /></label><label>{$t("Days")}<input type="number" min="0" max="36500" step="1" bind:value={overrideDays} required /></label><button type="submit">{$t("Add override")}</button></form>
          <div class="table-scroll"><table class="retention-table"><thead><tr><th>{$t("Author")}</th><th>{$t("Retention (days)")}</th><th></th></tr></thead><tbody>{#each settings.retentionOverrides as row, index}<tr><td class="key-cell"><code title={asNpub(row.pubkey)}>{asNpub(row.pubkey)}</code></td><td><input aria-label={$t("Retention days for {author}", { author: asNpub(row.pubkey) })} class="days-input" type="number" min="0" max="36500" step="1" bind:value={row.days} /></td><td><button class="ghost" aria-label={$t("Remove override for {author}", { author: asNpub(row.pubkey) })} onclick={() => { if (settings) settings.retentionOverrides.splice(index, 1); }}>{$t("Remove")}</button></td></tr>{:else}<tr><td colspan="3" class="empty">{$t("No overrides. Every author uses the default period.")}</td></tr>{/each}</tbody></table></div>
        </section>
        <div class="inline-actions"><button disabled={maintenanceBusy || dirty} onclick={() => runJob('retention')}>{$t("Run cleanup now")}</button><span class="helper">{dirty ? $t("Save your changes before running cleanup.") : $t("Uses the saved policy. Deleted events cannot be recovered.")}</span></div>
      {:else if active === 'rates'}
        <p class="intro">{$t("Set publishing limits for every author, including authors on the allow list.")}</p>
        <section class="panel"><h2>{$t("Per-author publish limits")}</h2><p class="helper">{$t("Counters stay in memory and reset when the policy plugin or relay restarts. Limits apply to this relay process. Set both to 0 to disable them.")}</p><div class="field-grid"><label>{$t("Events per minute")}<input type="number" min="0" max="1000000" step="1" aria-label={$t("Events per minute")} bind:value={settings.rate.perMinute} /><small>{$t("Maximum publish attempts from one npub in a UTC minute. 0 disables this limit.")}</small></label><label>{$t("Events per hour")}<input type="number" min="0" max="10000000" step="1" aria-label={$t("Events per hour")} bind:value={settings.rate.perHour} /><small>{$t("Maximum publish attempts from one npub in a UTC hour. 0 disables this limit.")}</small></label></div></section>
        <div class="callout"><strong>{$t("Both limits apply")}</strong><p>{$t("A write must pass both enabled limits. Attempts that reach moderation consume quota even if AI later removes them. These limits apply to event authors, across connections and IP addresses; they do not throttle reading or prevent someone using multiple keys.")}</p></div>
      {:else if active === 'moderation'}
        {#if !settings.aiModerationEnabled}
          <div class="callout"><strong>{$t("AI moderation is disabled by the server operator")}</strong><p>{$t("This deployment does not support AI reviews or automatic AI bans. Author lists, word filters, retention, and rate limits remain available.")}</p></div>
        {:else}
        <p class="intro">{$t("Accept notes immediately, then review them in the background and remove offending notes. Connect directly to OpenAI or use an existing Aedos moderation oracle.")}</p>
        <section class="panel"><div class="panel-heading"><h2>{$t("Moderation provider")}</h2><span class="badge">{settings.moderation.provider === 'off' ? $t("Disabled") : $t("Enabled on save")}</span></div><div class="field-grid"><label>{$t("Provider")}<select aria-label={$t("Provider")} bind:value={settings.moderation.provider}><option value="off">{$t("Disabled")}</option><option value="openai">{$t("OpenAI · text, images & video frames")}</option><option value="aedos">{$t("Connected Aedos oracle")}</option></select></label><label>{$t("Review timeout (seconds)")}<input type="number" min="2" max="40" aria-label={$t("Review timeout (seconds)")} bind:value={settings.moderation.timeoutSeconds} /><small>{$t("Maximum time per background review. Publishing does not wait for this review.")}</small></label></div>
          {#if settings.moderation.provider === 'openai'}<div class="field-grid"><label>{$t("OpenAI API key")}<input dir="ltr" type="password" autocomplete="new-password" aria-label={$t("OpenAI API key")} bind:value={openaiKey} oninput={() => removeOpenaiKey = false} placeholder={settings.openaiKeySet ? $t('Saved key · leave blank to keep') : $t('Enter API key')} /><small>{$t("Stored on the server and never returned to the browser.")}</small>{#if settings.openaiKeySet}<button type="button" class="ghost key-remove" onclick={() => { removeOpenaiKey = !removeOpenaiKey; openaiKey = ''; }}>{removeOpenaiKey ? $t("Undo key removal") : $t("Remove saved key")}</button>{/if}</label><label>{$t("Moderation model")}<input aria-label={$t("Moderation model")} bind:value={settings.moderation.model} /><small>{$t("Default: omni-moderation-latest.")}</small></label></div><div class="field-grid"><label>{$t("Maximum media attachments")}<input type="number" min="1" max="8" aria-label={$t("Maximum media attachments")} bind:value={settings.moderation.maxMedia} /><small>{$t("Excess attachments follow the unavailable-review policy below.")}</small></label><label>{$t("Frames per video")}<input type="number" min="1" max="8" aria-label={$t("Frames per video")} bind:value={settings.moderation.videoFrames} /><small>{$t("Frames are sampled across the video. Audio is not reviewed.")}</small></label></div>
          {:else if settings.moderation.provider === 'aedos'}<div class="field-grid"><label>{$t("Aedos oracle URL")}<input dir="ltr" type="url" aria-label={$t("Aedos oracle URL")} bind:value={settings.moderation.oracleUrl} placeholder="https://oracle.example.com" /><small>{$t("Base URL of the Aedos API, which exposes /v1/check.")}</small></label><label>{$t("Oracle API key")}<input dir="ltr" type="password" autocomplete="new-password" aria-label={$t("Oracle API key")} bind:value={oracleKey} oninput={() => removeOracleKey = false} placeholder={settings.oracleKeySet ? $t('Saved key · leave blank to keep') : $t('Optional x-api-key')} />{#if settings.oracleKeySet}<button type="button" class="ghost key-remove" onclick={() => { removeOracleKey = !removeOracleKey; oracleKey = ''; }}>{removeOracleKey ? $t("Undo key removal") : $t("Remove saved key")}</button>{/if}</label></div>{/if}
        </section>
        <p class="helper">{$t("Pending reviews: {count}.", { count: overview ? $number(overview.moderationQueue) : "—" })} {$t(overview?.moderationError ?? '')}</p><section class="panel"><h2>{$t("Verdict policy")}</h2><div class="field-grid"><label>{$t("Warning verdicts")}<select aria-label={$t("Warning verdicts")} bind:value={settings.moderation.blockWarnings}><option value={true}>{$t("Remove notes with warnings")}</option><option value={false}>{$t("Keep notes with warnings")}</option></select><small>{$t("Block verdicts always remove the stored event.")}</small></label><label>{$t("If a review is unavailable")}<select aria-label={$t("If a review is unavailable")} bind:value={settings.moderation.failurePolicy}><option value="reject">{$t("Remove the note after review fails")}</option><option value="accept">{$t("Keep the note if review fails")}</option></select><small>{$t("Applies to unknown results, provider errors, timeouts, and media that cannot be reviewed.")}</small></label></div><label>{$t("Automatically ban offending authors")}<select aria-label={$t("Automatically ban offending authors")} bind:value={settings.moderation.autoBan}><option value={false}>{$t("Off · remove offending notes only")}</option><option value={true}>{$t("On · also add authors to the block list")}</option></select><small>{$t("Applies to block verdicts and warnings you choose to remove, including blocked topic tags. Never bans for review errors or timeouts. Your allow list keeps priority; automatic bans do not remove authors from it.")}</small></label><label>{$t("Blocked topic tags")}<textarea aria-label={$t("Blocked topic tags")} bind:value={blockedTags} rows="2" placeholder={$t("One tag per line, or comma separated")}></textarea><small>{$t("When moderation is enabled, matching hashtags and Nostr t tags trigger removal during background review, without a provider call.")}</small></label></section>
        <div class="callout"><strong>{$t("Review coverage")}</strong><p>{$t("Direct OpenAI checks text, supported image/video links, and imeta attachments. Images are limited to 10 MB and videos to 40 MB. Web pages, audio, and streaming playlists are not reviewed. Media is downloaded temporarily and deleted after review; event IDs, author keys, and decisions appear in Activity.")}</p><p>{$t("When enabled, note content and supported media are sent to the selected provider. Notes may reach clients before review; deletion cannot retract copies already delivered. Reviews already saved to the queue survive restarts. Collection is asynchronous: crashes, outages, or a full queue can leave some notes unreviewed. Publishing continues when the queue reaches 10,000 notes; a warning appears in Overview. The unavailable-review setting applies only to queued reviews.")}</p></div>
        {/if}
      {:else if active === 'activity'}
        <div class="activity-head"><p class="intro">{$t("Recent publishing decisions and background review outcomes. No note content or media is stored in this log.")}</p><label>{$t("Show")}<select aria-label={$t("Decision filter")} bind:value={activityFilter}><option value="all">{$t("All decisions")}</option><option value="accept">{$t("Accepted")}</option><option value="reject">{$t("Rejected")}</option><option value="remove">{$t("Removed after review")}</option><option value="review">{$t("Other review outcomes")}</option></select></label></div>
        <section class="table-shell table-scroll"><table><thead><tr><th>{$t("Event / Author")}</th><th>{$t("Decision")}</th><th>{$t("Reason")}</th><th>{$t("Received")}</th></tr></thead><tbody>{#each visibleActivity as row}<tr><td><code title={row.event_id}>{short(row.event_id)}</code><br /><span class="muted mono" title={asNpub(row.pubkey)}>{short(asNpub(row.pubkey))}</span></td><td><span class:rejected={['reject', 'remove'].includes(row.action)} class="badge">{row.action === 'accept' ? $t("Accepted") : row.action === 'reject' ? $t("Rejected") : row.action === 'remove' ? $t("Removed") : $t("Reviewed")}</span></td><td><span>{$t(row.reason)}</span>{#if row.labels.length}<p class="helper">{row.labels.join(', ')}</p>{/if}{#if row.action === 'remove' && row.labels.includes('offending')}<button class="ghost" disabled={dirty || settings.block.includes(row.pubkey)} onclick={() => banAuthor(row)}>{settings.block.includes(row.pubkey) ? $t("On block list") : $t("Ban author")}</button>{/if}</td><td class="nowrap">{date(row.at * 1000)}</td></tr>{:else}<tr><td colspan="4"><div class="empty-state"><span aria-hidden="true">▦</span><h2>{activity.length ? $t("No matching decisions") : $t("Waiting for your first event")}</h2><p>{activity.length ? $t("Choose another filter to see more activity.") : $t("Publish a note to your relay. Its policy decision will appear here.")}</p></div></td></tr>{/each}</tbody></table></section>
        <div class="inline-actions"><p class="helper">{$t("Up to 10,000 recent decisions are retained. Collection is asynchronous and can miss records during outages or overload. With all rules and AI off, the plugin is bypassed and new detailed Activity is not collected.")}</p>{#if moreActivity}<button disabled={loadingActivity} onclick={() => loadActivity(true)}>{loadingActivity ? $t("Loading…") : $t("Load older decisions")}</button>{/if}</div>
      {:else if active === 'storage'}
        <p class="intro">{$t("Manage the events stored in your strfry relay. Settings and moderation decisions are kept separately.")}</p>
        <section class="stats-grid storage-stats"><article><span>{$t("Stored Events")}</span><strong>{overview?.eventCount == null ? '—' : $number(overview.eventCount)}</strong></article><article><span>{$t("Database Size")}</span><strong><bdi dir="ltr">{overview ? formatBytes(overview.databaseBytes, $locale) : '—'}</bdi></strong></article></section>
        <DiskSpace disk={overview?.disk} loading={!overview} />
        <section class="panel"><h2>{$t("Automatic retention")}</h2><p>{$t("Cleanup runs every five minutes using your saved default retention period and author overrides.")}</p><div class="inline-actions"><button disabled={maintenanceBusy || dirty} onclick={() => runJob('retention')}>{$t("Run cleanup now")}</button><button class="ghost" onclick={() => navigate('retention')}>{$t("Edit retention →")}</button></div><p class="helper">{$t("LMDB reuses freed pages. Deleting events does not immediately shrink the database file.")}</p></section>
        <section class="panel danger-panel"><h2>{$t("Clear all notes")}</h2><p>{$t("Permanently delete every stored event, including profiles and replaceable events. Publishing pauses while the job runs and resumes automatically afterward. Pending reviews are cancelled. Your policies, admin access, and decision log are retained.")}</p><button class="danger-button" disabled={maintenanceBusy} onclick={() => { clearText = ''; showClear = true; }}>{$t("Clear all notes…")}</button></section>
      {/if}

      {#if overview?.maintenance && ['overview', 'retention', 'storage'].includes(active)}
        <section class="panel maintenance-panel" aria-live="polite"><div class="panel-heading"><h2>{$t("Last maintenance")}</h2><span class:rejected={overview.maintenance.status === 'error'} class="badge">{$t(overview.maintenance.status)}</span></div><p>{overview.maintenance.type === 'clear' ? $t("Clear all notes") : $t("Retention cleanup")} · {date(overview.maintenance.startedAt)}{overview.maintenance.type === 'retention' ? ' · ' + $t("{count} events selected for deletion", { count: $number(overview.maintenance.deleted) }) : ''}</p>{#if overview.maintenance.error}<p class="error-text">{$t(overview.maintenance.error)}</p>{/if}{#if overview.maintenance.status === 'running'}<p class="helper">{$t("Running for {count} seconds. You can keep this page open to follow progress.", { count: $number(Math.max(0, Math.floor((clock - overview.maintenance.startedAt) / 1000))) })}</p>{/if}</section>
      {/if}
      {#if overview?.error}<p class="error-text">{$t(overview.error)}</p>{/if}
      {#if settings && (policyView || dirty)}<footer class="save-bar"><div><strong>{dirty ? $t("Unsaved policy changes") : $t("Policy is up to date")}</strong><p class="helper">{$t("Saved rules apply to new writes. Enabling or bypassing the plugin may take a few seconds while strfry reloads its configuration.")}</p></div><div class="inline-actions"><button disabled={saving || maintenanceBusy} onclick={discard}>{$t("Reload saved policy")}</button><button class="primary" disabled={!dirty || saving || maintenanceBusy} onclick={save}>{saving ? $t("Saving…") : $t("Save policy")}</button></div></footer>{/if}
    </section>
  </main>
{/if}

{#if showClear}
  <dialog class="confirm-dialog" aria-labelledby="clear-title" use:openDialog oncancel={(event) => { if (jobPending) event.preventDefault(); else showClear = false; }}><p class="eyebrow">{$t("Destructive action")}</p><h2 id="clear-title">{$t("Clear every stored note?")}</h2><p>{$t("This deletes all events from the relay. It cannot be undone. Authors can publish again once the relay restarts.")}</p><form onsubmit={(event) => { event.preventDefault(); void runJob('clear'); }}><label>{$t("Type CLEAR ALL NOTES to confirm")}<input dir="ltr" bind:value={clearText} autocomplete="off" placeholder="CLEAR ALL NOTES" /></label><div class="dialog-actions"><button type="button" disabled={jobPending} onclick={() => showClear = false}>{$t("Cancel")}</button><button class="danger-button" disabled={clearText !== 'CLEAR ALL NOTES' || jobPending} type="submit">{jobPending ? $t("Starting…") : $t("Delete all events")}</button></div></form></dialog>
{/if}
