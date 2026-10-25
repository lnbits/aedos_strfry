<script lang="ts">
  import { t, locale, percent } from './i18n';
  import type { DiskSpace as Space } from './types';
  import { trafficBytes as formatBytes } from './traffic-format';
  let { disk, loading = false }: { disk: Space | null | undefined; loading?: boolean } = $props();
  const occupied = $derived(disk ? disk.totalBytes - disk.availableBytes : 0);
  const occupiedPercent = $derived(disk ? occupied / disk.totalBytes * 100 : 0);
</script>

<section class="panel disk-space" aria-label={$t("Disk space")}>
  <div class="panel-heading"><h2>{$t("Disk space")}</h2>{#if disk}<span class="helper">{disk.reservedBytes > 0 ? $t("{percent} used or reserved", { percent: $percent(occupiedPercent / 100) }) : $t("{percent} used", { percent: $percent(occupiedPercent / 100) })}</span>{/if}</div>
  {#if disk}
    <div class="disk-available"><strong><bdi dir="ltr">{formatBytes(disk.availableBytes, $locale)}</bdi></strong><span>{$t("available")}</span></div>
    <progress aria-label={$t("Disk space used or reserved")} max={disk.totalBytes} value={occupied}>{$percent(occupiedPercent / 100)}</progress>
    <dl><div><dt>{$t("Total capacity")}</dt><dd><bdi dir="ltr">{formatBytes(disk.totalBytes, $locale)}</bdi></dd></div><div><dt>{$t("Used")}</dt><dd><bdi dir="ltr">{formatBytes(disk.usedBytes, $locale)}</bdi></dd></div>{#if disk.reservedBytes > 0}<div><dt>{$t("Reserved by filesystem")}</dt><dd><bdi dir="ltr">{formatBytes(disk.reservedBytes, $locale)}</bdi></dd></div>{/if}</dl>
    <p class="helper">{$t("Space on the disk holding your relay database. Shared with other data on that disk; separate hosting quotas may be lower.")}</p>
  {:else}<p class="helper">{loading ? $t("Checking available disk space…") : $t("Available disk space could not be read.")}</p>{/if}
</section>

<style>
  .panel-heading { flex-wrap: wrap; gap: 12px; }
  .disk-available { display: flex; align-items: baseline; flex-wrap: wrap; gap: 12px; margin: 20px 0 16px; }
  .disk-available strong { font-size: 32px; font-weight: 900; font-variant-numeric: tabular-nums; }
  .disk-available span { color: var(--muted); font-size: 14px; }
  progress { display: block; width: 100%; height: 10px; border: 0; border-radius: 3px; overflow: hidden; appearance: none; background: var(--surface-active); color: var(--text); }
  progress::-webkit-progress-bar { background: var(--surface-active); }
  progress::-webkit-progress-value { background: var(--text); }
  progress::-moz-progress-bar { background: var(--text); }
  dl { display: flex; flex-wrap: wrap; gap: 18px 32px; margin: 20px 0; }
  dt { font-size: 12px; color: var(--muted); margin-bottom: 6px; }
  dd { font-size: 14px; font-weight: 700; margin: 0; font-variant-numeric: tabular-nums; }
  .helper { margin-bottom: 0; }
</style>
