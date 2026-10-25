import dns from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent, fetch } from 'undici';
import ipaddr from 'ipaddr.js';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

export function publicAddress(address) {
  try { return ipaddr.process(address).range() === 'unicast'; } catch { return false; }
}

// DNS is resolved once, checked, and pinned to the connection to prevent rebinding.
export async function downloadMedia(input, signal) {
  let url = new URL(input);
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))) throw new Error('Unsafe media URL');
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await dns.lookup(hostname, { all: true });
    if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw new Error('Media must resolve to a public IP address');
    const dispatcher = new Agent({ connect: { lookup: (_host, options, callback) => {
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    } } });
    try {
      const response = await fetch(url, { dispatcher, redirect: 'manual', signal });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        if (!response.headers.get('location')) throw new Error('Invalid media redirect');
        url = new URL(response.headers.get('location'), url);
        continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error(`Media returned HTTP ${response.status}`); }
      const mime = (response.headers.get('content-type') || '').split(';')[0].toLowerCase();
      if (!/^(image\/(jpeg|png|gif|webp)|video\/(mp4|webm|quicktime|ogg))$/.test(mime)) {
        await response.body?.cancel(); throw new Error('Unsupported media type');
      }
      const limit = mime.startsWith('video/') ? 40 * 1024 * 1024 : 10 * 1024 * 1024;
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > limit) throw new Error('Media exceeds download limit');
        chunks.push(chunk);
      }
      return { bytes: Buffer.concat(chunks), mime };
    } finally { await dispatcher.close(); }
  }
  throw new Error('Too many media redirects');
}

export function mediaUrls(event) {
  const urls = new Set();
  for (const match of event.content.matchAll(/https?:\/\/[^\s<>"\\]+/gi)) {
    const value = match[0].replace(/[).,;!?]+$/, '');
    try { if (/\.(jpe?g|png|gif|webp|mp4|webm|mov|ogg)$/i.test(new URL(value).pathname)) urls.add(value); } catch {}
  }
  for (const tag of event.tags) {
    if (tag[0] === 'imeta') for (const part of tag.slice(1)) if (part.startsWith('url ')) urls.add(part.slice(4));
    if (tag[0] === 'url' && typeof tag[1] === 'string') urls.add(tag[1]);
  }
  return [...urls];
}

async function videoImages(bytes, count, signal) {
  const directory = await mkdtemp(join(tmpdir(), 'lnbits-nrm-media-'));
  try {
    const source = join(directory, 'input');
    await writeFile(source, bytes, { mode: 0o600 });
    const { stdout } = await exec('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file', '-format_whitelist', 'mov,matroska,webm,ogg', '-max_alloc', '67108864', '-show_entries', 'format=duration', '-of', 'json', source], { timeout: 8000, signal, maxBuffer: 65536 });
    const duration = Number(JSON.parse(stdout).format?.duration);
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('Video duration could not be read');
    const images = [];
    for (let i = 0; i < count; i++) {
      const destination = join(directory, `${i}.jpg`);
      await exec('ffmpeg', ['-v', 'error', '-nostdin', '-threads', '1', '-protocol_whitelist', 'file', '-format_whitelist', 'mov,matroska,webm,ogg', '-max_alloc', '67108864', '-ss', String(duration * i / count), '-i', source,
        '-frames:v', '1', '-vf', 'scale=640:640:force_original_aspect_ratio=decrease', '-threads', '1', '-y', destination], { timeout: 8000, signal, maxBuffer: 65536 });
      try {
        images.push(`data:image/jpeg;base64,${(await readFile(destination)).toString('base64')}`);
      } catch (error) {
        // A low-frame-rate clip can end with a held frame: seeking beyond its
        // last frame yields no output even though ffmpeg succeeds.
        if (error.code !== 'ENOENT' || !images.length) throw error;
        images.push(images.at(-1));
      }
    }
    return images;
  } finally { await rm(directory, { recursive: true, force: true }); }
}

async function responseJson(response) {
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Moderation provider returned HTTP ${response.status}`); }
  let size = 0; const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error('Moderation response too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}

export class Moderator {
  constructor(store, dependencies = {}) {
    this.store = store;
    this.fetch = dependencies.fetch ?? fetch;
    this.download = dependencies.download ?? downloadMedia;
    this.cache = new Map();
  }
  async review(event, settings) {
    if (this.store.aiModerationEnabled === false) return { status: 'safe', labels: [], reason: 'AI moderation disabled by operator' };
    const m = settings.moderation;
    if (m.provider === 'off') return { status: 'safe', labels: [], reason: 'Moderation disabled' };
    const tags = [...event.content.matchAll(/(?:^|\s)#([\p{L}\p{N}_-]+)/gu)].map(v => v[1].toLowerCase());
    tags.push(...event.tags.filter(t => t[0] === 't').map(t => String(t[1]).toLowerCase()));
    if (m.blockedTags.some(tag => tags.includes(tag.toLowerCase()))) return { status: 'block', labels: ['blocked-tag'], reason: 'Blocked topic tag' };
    const cacheKey = `${settings.revision}:${event.id}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expires > Date.now()) return cached.result;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), m.timeoutSeconds * 1000);
    // Keep the whole review bounded, including DNS and video processing.
    let abortListener;
    try {
      const result = await Promise.race([
        this.request(event, m, controller.signal),
        new Promise((_, reject) => {
          abortListener = () => reject(new Error('Moderation timed out'));
          controller.signal.addEventListener('abort', abortListener, { once: true });
        })
      ]);
      if (['safe', 'warn', 'block'].includes(result.status)) {
        if (this.cache.size >= 1000) this.cache.delete(this.cache.keys().next().value);
        this.cache.set(cacheKey, { result, expires: Date.now() + 3600000 });
      }
      return result;
    } catch (error) {
      // Do not leak URLs, API keys, or ffmpeg stderr into logs or relay replies.
      const safeReasons = ['Media exceeds download limit', 'Unsupported media type', 'Too many media attachments to review',
        'Media must resolve to a public IP address', 'Unsafe media URL', 'Invalid moderation response', 'Invalid oracle verdict'];
      const reason = safeReasons.includes(error.message) || /^Moderation provider returned HTTP \d{3}$/.test(error.message)
        ? error.message : 'Moderation unavailable or media could not be reviewed';
      return { status: 'error', labels: [], reason: controller.signal.aborted ? 'Moderation timed out' : reason };
    } finally {
      clearTimeout(timeout);
      controller.signal.removeEventListener('abort', abortListener);
    }
  }
  async request(event, m, signal) {
    if (m.provider === 'aedos') {
      const headers = { 'content-type': 'application/json' };
      const key = this.store.get('oracleKey');
      if (key) headers['x-api-key'] = key;
      const response = await this.fetch(`${m.oracleUrl.replace(/\/$/, '')}/v1/check`, {
        method: 'POST', headers, signal, redirect: 'error',
        body: JSON.stringify({ raw_event: event, wait: true, timeout_seconds: Math.max(1, m.timeoutSeconds - 1) })
      });
      const data = await responseJson(response);
      if (!['safe', 'warn', 'block', 'unknown', 'error'].includes(data.status)) throw new Error('Invalid oracle verdict');
      return { status: data.status, labels: Array.isArray(data.labels) ? data.labels.filter(x => typeof x === 'string').slice(0, 20).map(x => x.slice(0, 80)) : [], reason: `Aedos verdict: ${data.status}` };
    }
    const urls = mediaUrls(event);
    if (urls.length > m.maxMedia) throw new Error('Too many media attachments to review');
    const input = [{ type: 'text', text: event.content || event.tags.map(t => t.join(' ')).join('\n') || '(empty event)' }];
    for (const url of urls) {
      signal.throwIfAborted();
      const { bytes, mime } = await this.download(url, signal);
      const images = mime.startsWith('video/') ? await videoImages(bytes, m.videoFrames, signal) : [`data:${mime};base64,${bytes.toString('base64')}`];
      input.push(...images.map(url => ({ type: 'image_url', image_url: { url } })));
    }
    const response = await this.fetch('https://api.openai.com/v1/moderations', {
      method: 'POST', redirect: 'error', signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.store.get('openaiKey')}` },
      body: JSON.stringify({ model: m.model, input })
    });
    const data = await responseJson(response);
    const result = data.results?.[0];
    if (typeof result?.flagged !== 'boolean' || !result.categories) throw new Error('Invalid moderation response');
    const labels = Object.entries(result.categories).filter(([, flagged]) => flagged === true).map(([category]) => category);
    const severe = ['sexual/minors', 'violence/graphic', 'hate', 'hate/threatening', 'self-harm', 'self-harm/intent', 'self-harm/instructions'];
    const status = labels.some(l => severe.includes(l)) ? 'block' : result.flagged ? 'warn' : 'safe';
    return { status, labels, reason: `OpenAI verdict: ${status}` };
  }
}
