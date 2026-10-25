export function trafficBytes(value: number, locale?: string) {
  const exponent = value < 1024 ? 0 : Math.min(5, Math.floor(Math.log(value) / Math.log(1024)));
  const amount = value / 1024 ** exponent;
  const digits = exponent === 0 ? 0 : 1;
  return `${amount.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'][exponent]}`;
}
