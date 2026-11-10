import { link, mkdtemp, open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// Publish complete private files. Exclusive writes keep the first authorization on retries.
export async function writePrivateJson(path, value, exclusive = false) {
  const parent = dirname(path);
  const dir = await mkdtemp(join(parent, '.pending-'));
  const temp = join(dir, 'value');
  try {
    const file = await open(temp, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(value));
      await file.sync();
    } finally {
      await file.close();
    }
    if (exclusive) await link(temp, path);
    else await rename(temp, path);
    const directory = await open(parent, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
