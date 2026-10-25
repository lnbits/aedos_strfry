<script lang="ts">
  import { t, locale, number, datetime, time, percent } from './i18n';
  import { onMount } from 'svelte';
  import TrafficChart from './TrafficChart.svelte';
  import type { TrafficData, TrafficRange } from './types';
  import { trafficBytes } from './traffic-format';
  let { api, refresh = 0 }: { api: <T>(path: string) => Promise<T>; refresh?: number } = $props();
  let range = $state<TrafficRange>('24h');
  let data = $state<TrafficData | null>(null);
  let error = $state('');
  let loading = $state(false);
  let request = 0;
  let disposed = false;
  const total = $derived(data ? data.totals.accept + data.totals.reject : 0);
  async function load() {
    const id = ++request;
    const requestedRange = range;
    loading = true;
    try {
      const result = await api<TrafficData>(`/traffic?range=${requestedRange}`);
      if (!disposed && id === request) { data = result; error = ''; }
    } catch (value) {
      if (!disposed && id === request) error = value instanceof Error ? value.message : 'Could not load traffic';
    } finally { if (!disposed && id === request) loading = false; }
  }
  $effect(() => { range; refresh; void load(); });
  onMount(() => {
    const timer = setInterval(() => { if (!document.hidden && !loading) void load(); }, 10000);
    return () => { disposed = true; request++; clearInterval(timer); };
  });
</script>

<p class="intro">{$t("Native strfry traffic, collected in the background. Detailed policy activity is available while filtering or AI collection is enabled.")}</p>
<div class="traffic-controls"><label>{$t("Time range")}<select aria-label={$t("Traffic time range")} bind:value={range}><option value="1h">{$t("Last hour")}</option><option value="24h">{$t("Last 24 hours")}</option><option value="7d">{$t("Last 7 days")}</option><option value="30d">{$t("Last 30 days")}</option></select></label><p class="helper" aria-live="polite">{loading ? $t("Updating…") : data ? $t("Updated {time} · refreshes every 10 seconds", { time: $time(data.until) }) : $t("Loading traffic…")}</p></div>
{#if error}<div class="error-box" role="alert">{$t(error)}. {data ? $t("The graphs below may be out of date.") : ''}<button onclick={() => load()}>{$t("Retry")}</button></div>{/if}
{#if data && data.range === range}
  {#if data.reportingError}<div class="error-box" role="alert">{$t(data.reportingError)}</div>{/if}
  <section class="stats-grid traffic-stats"><article><span>{$t("Messages received")}</span><strong>{$number(data.nativeTotals.received)}</strong></article><article><span>{$t("Messages sent")}</span><strong>{$number(data.nativeTotals.sent)}</strong></article><article><span>{$t("Events processed")}</span><strong>{$number(data.nativeTotals.events)}</strong></article></section>
  <TrafficChart data={{ ...data, points: data.nativePoints.map(p => ({ at: p.at, accept: p.received, reject: p.sent, bytes: p.events })) }} mode="messages" />
  {#if !data.pluginEnabled}<p class="helper">{$t("Policy plugin bypassed. Native traffic above remains available; detailed policy decisions below are not collected while all rules and AI are off.")}</p>{/if}
  {#if data.error}<div class="error-box" role="alert">{$t(data.error)}</div>{/if}
  <section class="stats-grid traffic-stats">
    <article><span>{$t("Publish decisions")}</span><strong>{$number(total)}</strong></article>
    <article><span>{$t("Accepted")}</span><strong>{$number(data.totals.accept)}</strong></article>
    <article><span>{$t("Rejected")}</span><strong>{$number(data.totals.reject)}</strong><small>{total ? $t("{percent} of decisions", { percent: $percent(data.totals.reject / total) }) : $t("No decisions in this period")}</small></article>
    <article><span>{$t("Incoming event data")}</span><strong class="size-stat"><bdi dir="ltr">{trafficBytes(data.totals.bytes, $locale)}</bdi></strong></article>
  </section>
  {#if !total}<div class="callout"><strong>{$t("No publishing recorded in this period")}</strong><p>{$t("Policy graphs fill while rules or AI collection are enabled. Native message traffic is shown above.")}</p></div>{/if}
  {#key range}<TrafficChart {data} mode="events" /><TrafficChart {data} mode="bytes" />{/key}
  <p class="helper">{$t("History collected since {time}. Retained for 30 days. Times use your browser’s time zone; the latest interval is still in progress. Blank history predates collection; zero means no recorded activity, including relay downtime.", { time: $datetime(data.startedAt) })}</p>
{:else if loading}<div class="panel"><p role="status">{$t("Loading traffic graphs…")}</p></div>{/if}
<div class="callout"><strong>{$t("What these graphs measure")}</strong><p>{$t("Native message counts come from strfry and include reader traffic. Event counts are processed events, not a stored-note count. Detailed accepted and rejected write-policy decisions are collected separately when the plugin is active. Acceptance happens before storage and any background AI review. Incoming data counts the event JSON for both outcomes.")}</p><p>{$t("Detailed policy graphs exclude events strfry handles before the plugin. Background collection can have gaps during outages or overload; a missing record does not mean a relay write failed. No bandwidth estimate includes WebSocket overhead or media downloads. These counters do not store note contents or author identities.")}</p></div>

<style>
  .traffic-controls { display: flex; justify-content: space-between; align-items: end; flex-wrap: wrap; gap: 16px; margin-bottom: 24px; }
  .traffic-controls select { min-width: 180px; }
  .traffic-controls p { margin: 0; }
  .traffic-stats small { display: block; margin-top: 8px; color: var(--muted); font-size: 11px; }
</style>
