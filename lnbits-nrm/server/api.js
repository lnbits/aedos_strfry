import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import staticFiles from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { settingsSchema } from './config.js';
import { Auth } from './auth.js';

export async function createApp({ store, relay, admins, origin, dist = resolve('dist') }) {
  const app = Fastify({
    logger: false, bodyLimit: 2 * 1024 * 1024,
    // Bound slow/incomplete management requests even without a reverse proxy.
    connectionTimeout: 15000, requestTimeout: 30000, keepAliveTimeout: 5000,
    http: { headersTimeout: 15000, connectionsCheckingInterval: 1000 }
  });
  const auth = new Auth(store, admins, origin);
  // Keep existing cookie names so operator sessions survive the application rename.
  const cookies = { httpOnly: true, sameSite: 'strict', secure: origin.startsWith('https:'), path: '/' };
  const limits = new Map();
  let limitsMinute = -1;
  const publicRoutes = new Set(['/api/health', '/api/auth/session', '/api/auth/challenge', '/api/auth/login', '/api/auth/logout']);
  await app.register(cookie);
  app.addHook('onRequest', async (request, reply) => {
    const route = request.routeOptions.url ?? '';
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    if (!['GET', 'HEAD'].includes(request.method) && request.headers.origin !== origin) {
      return reply.code(403).send({ error: 'Request origin does not match PUBLIC_ORIGIN' });
    }
    if (route.startsWith('/api/auth/')) {
      const minute = Math.floor(Date.now() / 60000);
      if (minute !== limitsMinute) { limits.clear(); limitsMinute = minute; }
      const entry = limits.get(request.ip) ?? { count: 0 };
      if (entry.count >= 60 || (!limits.has(request.ip) && limits.size >= 10000)) {
        return reply.code(429).send({ error: 'Too many sign-in requests; try again in a minute' });
      }
      entry.count++;
      limits.set(request.ip, entry);
    }
    if (route.startsWith('/api/') && !publicRoutes.has(route)) {
      if (!auth.session(request.cookies.aedos_session).authenticated) return reply.code(401).send({ error: 'Sign in with your admin Nostr extension' });
    }
  });
  // Recheck after body parsing: shutdown can begin while a client uploads a body.
  app.addHook('preHandler', async (request, reply) => {
    if (relay.closing && !['GET', 'HEAD'].includes(request.method)) {
      return reply.code(503).send({ error: 'Service is shutting down; retry after restart' });
    }
  });
  app.setErrorHandler((error, request, reply) => {
    if (error.name === 'ZodError') return reply.code(400).send({ error: error.issues.map(v => `${v.path.join('.')}: ${v.message}`).join('; ') });
    const status = error.statusCode ?? 500;
    if (status >= 500) console.error('API request failed:', request.method, request.routeOptions.url, error.message);
    reply.code(status).send({ error: status >= 500 ? 'The operation failed. Check the container logs.' : error.message });
  });
  app.get('/api/health', async (_, reply) => {
    const healthy = await relay.online() && !relay.policyError;
    return reply.code(healthy ? 200 : 503).send({ healthy });
  });
  app.get('/api/auth/session', async request => auth.session(request.cookies.aedos_session));
  app.post('/api/auth/challenge', { bodyLimit: 8192 }, async (_, reply) => {
    if (!admins.length) return reply.code(503).send({ error: 'Set ADMIN_NPUBS in your Docker environment, then restart LNbits NRM' });
    const challenge = auth.challenge();
    reply.setCookie('aedos_challenge', challenge.token, { ...cookies, maxAge: 120 });
    return { event: challenge.event };
  });
  app.post('/api/auth/login', { bodyLimit: 8192 }, async (request, reply) => {
    const token = auth.login(request.cookies.aedos_challenge, request.body?.event);
    reply.clearCookie('aedos_challenge', cookies);
    reply.setCookie('aedos_session', token, { ...cookies, maxAge: 43200 });
    return auth.session(token);
  });
  app.post('/api/auth/logout', { bodyLimit: 8192 }, async (request, reply) => {
    auth.logout(request.cookies.aedos_session);
    reply.clearCookie('aedos_session', cookies);
    return { ok: true };
  });
  app.get('/api/settings', async () => store.publicSettings());
  app.put('/api/settings', async request => {
    if (relay.busy) throw Object.assign(new Error('Wait for maintenance to finish before changing policy'), { statusCode: 409 });
    const settings = store.saveSettings(settingsSchema.parse(request.body));
    await relay.applyPolicy?.();
    return settings;
  });
  app.get('/api/overview', async () => relay.overview());
  app.get('/api/traffic', async request => ({ ...store.traffic.snapshot(request.query.range ?? '24h'), reportingError: relay.reporting?.error ?? relay.reporting?.warning ?? relay.metrics?.error ?? null, pluginEnabled: relay.pluginEnabled ?? false }));
  app.get('/api/activity', async request => {
    const raw = request.query.before;
    const before = raw === undefined ? Number.MAX_SAFE_INTEGER : Number(raw);
    if (!Number.isSafeInteger(before) || before < 1) throw Object.assign(new Error('Invalid activity cursor'), { statusCode: 400 });
    return { items: store.decisions(50, before) };
  });
  app.post('/api/activity/:seq/ban', async request => {
    const seq = Number(request.params.seq);
    if (!Number.isSafeInteger(seq) || seq < 1) throw Object.assign(new Error('Invalid decision'), { statusCode: 400 });
    const decision = store.db.prepare('SELECT * FROM decisions WHERE seq=?').get(seq);
    if (!decision || decision.action !== 'remove' || !JSON.parse(decision.labels).includes('offending')) {
      throw Object.assign(new Error('Select an offending moderation decision'), { statusCode: 400 });
    }
    if (!store.banAuthor(decision.pubkey)) throw Object.assign(new Error('Block list is full'), { statusCode: 409 });
    await relay.applyPolicy?.();
    return store.publicSettings();
  });
  app.post('/api/retention/run', async (_, reply) => reply.code(202).send(relay.maintenance('retention')));
  app.post('/api/events/clear', async (request, reply) => {
    if (request.body?.confirmation !== 'CLEAR ALL NOTES') return reply.code(400).send({ error: 'Type CLEAR ALL NOTES to confirm deletion' });
    return reply.code(202).send(relay.maintenance('clear'));
  });
  if (existsSync(dist)) {
    await app.register(staticFiles, { root: dist });
    for (const route of ['/admin', '/login']) app.get(route, (_, reply) => reply.sendFile('index.html'));
  }
  return app;
}
