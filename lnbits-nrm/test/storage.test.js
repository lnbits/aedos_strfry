import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, statfs, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diskSpace } from '../server/storage.js';
import { Relay } from '../server/relay.js';
import { Store } from '../server/store.js';

test('available disk space excludes reserved blocks and uses the supplied database mount', async () => {
  const result = await diskSpace('/data/strfry-db', async (path, options) => {
    assert.equal(path, '/data/strfry-db');
    assert.deepEqual(options, { bigint: true });
    return { bsize: 4096n, blocks: 1000n, bfree: 300n, bavail: 250n };
  });
  assert.deepEqual(result, { totalBytes: 4096000, usedBytes: 2867200, availableBytes: 1024000, reservedBytes: 204800 });
  assert.equal(result.totalBytes, result.usedBytes + result.availableBytes + result.reservedBytes);
});

test('full disks report zero available; read failures or invalid stats report unknown', async () => {
  const full = await diskSpace('/db', async () => ({ bsize: 4096n, blocks: 1000n, bfree: 0n, bavail: 0n }));
  assert.equal(full.availableBytes, 0);
  assert.equal(full.usedBytes, full.totalBytes);
  assert.equal(await diskSpace('/db', async () => { throw new Error('unavailable'); }), null);
  for (const stats of [
    { bsize: 0n, blocks: 1n, bfree: 0n, bavail: 0n },
    { bsize: 4096n, blocks: 0n, bfree: 0n, bavail: 0n },
    { bsize: 4096n, blocks: 10n, bfree: 11n, bavail: 0n },
    { bsize: 4096n, blocks: 10n, bfree: 5n, bavail: 6n }
  ]) assert.equal(await diskSpace('/db', async () => stats), null);
});

test('overview reads the database filesystem and handles a missing database mount without failing', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'lnbits-nrm-storage-'));
  const store = new Store(':memory:');
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const relay = new Relay(store, { dataDir: dir, relayUrl: 'ws://localhost:7777', name: 'test' });
  relay.countAt = Date.now();
  relay.count = 0;
  relay.online = async () => true;
  assert.equal((await relay.overview()).disk, null, 'never substitute the parent filesystem when the database mount is absent');
  const db = join(dir, 'strfry-db');
  await mkdir(db);
  await writeFile(join(db, 'data.mdb'), new Uint8Array(8192));
  const stats = await statfs(db, { bigint: true });
  const overview = await relay.overview();
  assert.equal(overview.disk.totalBytes, Number(stats.bsize * stats.blocks));
  assert.ok(overview.disk.availableBytes >= 0 && overview.disk.availableBytes <= overview.disk.totalBytes);
  assert.equal(overview.disk.usedBytes + overview.disk.availableBytes + overview.disk.reservedBytes, overview.disk.totalBytes);
  assert.equal(overview.databaseBytes, 8192);
  assert.equal(overview.online, true);
  assert.doesNotThrow(() => JSON.stringify(overview), 'API response must not contain BigInt values');
});

test('migration guard refuses missing, empty, or non-file databases before startup', async t => {
  const { requireExistingDatabase } = await import('../server/storage.js');
  const { runtimeOptions } = await import('../server/config.js');
  const dir = await mkdtemp(join(tmpdir(), 'lnbits-nrm-migration-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal(runtimeOptions({}).requireExistingDb, false);
  for (const value of ['true', '1', ' TRUE ']) assert.equal(runtimeOptions({ REQUIRE_EXISTING_DB: value }).requireExistingDb, true);
  for (const value of ['false', '0']) assert.equal(runtimeOptions({ REQUIRE_EXISTING_DB: value }).requireExistingDb, false);
  assert.throws(() => runtimeOptions({ REQUIRE_EXISTING_DB: 'yes' }), /REQUIRE_EXISTING_DB/);
  await assert.rejects(requireExistingDatabase(dir), /refusing to create an empty relay/);
  await mkdir(join(dir, 'data.mdb'));
  await assert.rejects(requireExistingDatabase(dir), /REQUIRE_EXISTING_DB/);
  await rm(join(dir, 'data.mdb'), { recursive: true });
  await writeFile(join(dir, 'data.mdb'), '');
  await assert.rejects(requireExistingDatabase(dir), /REQUIRE_EXISTING_DB/);
  await writeFile(join(dir, 'data.mdb'), new Uint8Array(8192));
  await requireExistingDatabase(dir);
});
