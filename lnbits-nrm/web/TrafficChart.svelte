<script lang="ts">
  import { t, locale, number, interval } from './i18n';
  import type { TrafficData, TrafficPoint } from './types';
  import { trafficBytes } from './traffic-format';
  let { data, mode }: { data: TrafficData; mode: 'events' | 'bytes' | 'messages' } = $props();
  let selected = $state<number | null>(null);
  let width = $state(760);
  const plotWidth = $derived(Math.max(width - 80, 1));
  const heading = $derived(mode === 'messages' ? 'Relay messages' : mode === 'events' ? 'Publishing activity' : 'Incoming event data');
  const series = $derived(mode !== 'bytes' ? ['accept', 'reject'] as const : ['bytes'] as const);
  const max = $derived(Math.max(4, Math.ceil(Math.max(...data.points.flatMap(p => series.map(key => p[key]))) / 4) * 4));
  const index = $derived(Math.min(selected ?? data.points.length - 1, data.points.length - 1));
  const point = $derived(data.points[index]);
  const tracked = (p: TrafficPoint) => p.at + data.step > data.startedAt;
  const x = (i: number) => 64 + (i + 0.5) / data.points.length * plotWidth;
  const y = (value: number) => 196 - value / max * 176;
  const value = (n: number) => mode === 'bytes' ? trafficBytes(n, $locale) : $number(n);
  const stamp = (at: number) => new Date(at).toLocaleString($locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const line = (key: 'accept' | 'reject' | 'bytes') => data.points.map((p, i) => tracked(p) ? `${x(i)},${y(p[key])}` : '').filter(Boolean).join(' ');
  function inspect(event: PointerEvent) {
    const box = (event.currentTarget as SVGSVGElement).getBoundingClientRect();
    const svgX = (event.clientX - box.left) / box.width * width;
    selected = Math.max(0, Math.min(data.points.length - 1, Math.floor((svgX - 64) / plotWidth * data.points.length)));
  }
</script>

<section class="panel traffic-chart">
  <div class="panel-heading"><h2>{$t(heading)}</h2><span class="helper">{$t("Interval: {duration}", { duration: $interval(data.step) })}</span></div>
  <div class="chart-legend"><span><i></i>{mode === 'messages' ? $t("Received") : mode === 'events' ? $t("Accepted") : $t("Event JSON bytes")}</span>{#if mode !== 'bytes'}<span class="chart-rejected"><i></i>{mode === 'messages' ? $t("Sent") : $t("Rejected")}</span>{/if}</div>
  <div class="chart-plot" dir="ltr" bind:clientWidth={width}><svg viewBox={`0 0 ${width} 232`} role="img" aria-label={$t("{heading} over the selected period. Use the interval slider below to inspect values.", { heading: $t(heading) })} onpointermove={inspect}>
    {#each [0, 1, 2, 3, 4] as tick}
      <line class="chart-grid" x1="64" x2={width - 16} y1={y(max * tick / 4)} y2={y(max * tick / 4)} />
      <text class="chart-axis" x="56" y={y(max * tick / 4) + 4} text-anchor="end">{value(max * tick / 4)}</text>
    {/each}
    {#each series as key}<polyline class:chart-rejected={key === 'reject'} class="chart-line" points={line(key)} />{/each}
    <line class="chart-cursor" x1={x(index)} x2={x(index)} y1="20" y2="196" />
    {#if tracked(point)}{#each series as key}<circle class:chart-rejected={key === 'reject'} class="chart-dot" cx={x(index)} cy={y(point[key])} r="3.5" />{/each}{/if}
    {#each (width < 500 ? [0, data.points.length - 1] : [0, Math.floor(data.points.length / 2), data.points.length - 1]) as i}
      <text class="chart-axis" x={i === 0 ? 64 : i === data.points.length - 1 ? width - 16 : x(i)} y="220" text-anchor={i === 0 ? 'start' : i === data.points.length - 1 ? 'end' : 'middle'}>{width < 500 ? new Date(data.points[i].at).toLocaleString($locale, data.step < 3600000 ? { hour: '2-digit', minute: '2-digit' } : { month: 'short', day: 'numeric' }) : stamp(data.points[i].at)}</text>
    {/each}
  </svg></div>
  <label class="chart-slider">{$t("Inspect interval")}<input aria-label={$t("{heading} interval", { heading: $t(heading) })} dir="ltr" type="range" min="0" max={data.points.length - 1} step="1" value={index} oninput={event => selected = Number(event.currentTarget.value)} /></label>
  <div class="chart-reading"><span>{stamp(point.at)} – {new Date(Math.min(point.at + data.step, data.until)).toLocaleTimeString($locale, { hour: '2-digit', minute: '2-digit' })}</span><strong dir={mode === 'bytes' ? 'ltr' : undefined}>{!tracked(point) ? $t("Before collection began") : mode === 'bytes' ? trafficBytes(point.bytes, $locale) : mode === 'messages' ? $t("{received} received · {sent} sent", { received: $number(point.accept), sent: $number(point.reject) }) : $t("{accepted} accepted · {rejected} rejected", { accepted: $number(point.accept), rejected: $number(point.reject) })}</strong></div>
</section>

<style>
  .traffic-chart { min-width: 0; }
  .panel-heading { gap: 12px; flex-wrap: wrap; }
  .chart-legend { display: flex; gap: 24px; font-size: 12px; color: var(--text); margin: 18px 0 8px; }
  .chart-legend span { display: inline-flex; align-items: center; gap: 8px; }
  .chart-legend i { width: 20px; border-top: 2px solid currentColor; }
  .chart-legend .chart-rejected i { border-top-style: dashed; }
  svg { display: block; width: 100%; overflow: visible; }
  .chart-grid { stroke: var(--line); opacity: .3; stroke-dasharray: 3 5; }
  .chart-axis { fill: var(--muted); font-size: 11px; }
  .chart-line { fill: none; stroke: var(--text); stroke-width: 2; vector-effect: non-scaling-stroke; }
  .chart-rejected { color: var(--danger); stroke: var(--danger); stroke-dasharray: 5 4; }
  .chart-cursor { stroke: var(--muted); opacity: .5; }
  .chart-dot { fill: var(--text); }
  .chart-dot.chart-rejected { fill: var(--danger); stroke: none; }
  .chart-slider { margin-top: 8px; font-size: 11px; color: var(--muted); }
  .chart-slider input { padding: 0; accent-color: var(--text); width: 100%; cursor: pointer; }
  .chart-reading { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px; font-size: 12px; margin-top: 12px; line-height: 1.6; font-variant-numeric: tabular-nums; }
  .chart-reading span { color: var(--muted); }
  .chart-plot { width: 100%; }
</style>
