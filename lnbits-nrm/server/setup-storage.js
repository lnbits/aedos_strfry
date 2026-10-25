// One-off helper for host mounts; the relay and UI still run as UID/GID 1000.
import { access, chmod, chown, readdir, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { runtimeOptions } from './config.js';
import { requireExistingDatabase } from './storage.js';

const directories = ['/setup/settings', '/setup/database'];
try {
  if (runtimeOptions().requireExistingDb) await requireExistingDatabase(directories[1]);
  for (const directory of directories) {
    // Never recursively change ownership or permissions on imported data.
    if ((await readdir(directory)).length === 0) {
      await chown(directory, 1000, 1000);
      await chmod(directory, 0o700);
    }
  }
  process.setgid(1000);
  process.setuid(1000);
  for (const directory of directories) {
    await access(directory, constants.R_OK | constants.W_OK | constants.X_OK);
    for (const name of await readdir(directory)) {
      const path = join(directory, name);
      if ((await lstat(path)).isFile()) await access(path, constants.R_OK | constants.W_OK);
    }
  }
  console.log('Host storage is ready for UID/GID 1000. Existing files were not changed.');
} catch (error) {
  console.error(`Storage setup failed: ${error.message}`);
  console.error('Check NRM_DATA_DIR and STRFRY_DB_DIR. Existing directories and database files must permit UID/GID 1000 to read and write. Back up and stop the old relay before adjusting imported data permissions.');
  process.exitCode = 1;
}
