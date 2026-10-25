import { statfs, stat } from 'node:fs/promises';
import { join } from 'node:path';

export async function requireExistingDatabase(directory) {
  const path = join(directory, 'data.mdb');
  const file = await stat(path).catch(() => null);
  if (!file?.isFile() || file.size === 0) {
    throw new Error(`REQUIRE_EXISTING_DB is enabled but no nonempty database was found at ${path}. Check the database mount; refusing to create an empty relay.`);
  }
}

// Read the database mount itself: it may be a separate filesystem from /data.
// bavail excludes reserved blocks that the unprivileged relay cannot allocate.
export async function diskSpace(path, read = statfs) {
  try {
    const { bsize, blocks, bfree, bavail } = await read(path, { bigint: true });
    if (bsize <= 0n || blocks <= 0n || bfree < 0n || bfree > blocks || bavail < 0n || bavail > bfree) return null;
    return {
      totalBytes: Number(blocks * bsize),
      usedBytes: Number((blocks - bfree) * bsize),
      availableBytes: Number(bavail * bsize),
      reservedBytes: Number((bfree - bavail) * bsize)
    };
  } catch { return null; }
}
