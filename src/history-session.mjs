// Local history is partitioned by BOTH the dedicated profile and verified account.
// Offline reads use the last verified binding, never infer the current login.
import { createHash, randomBytes } from 'node:crypto';
import { lstat, readFile, realpath, rename, open, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ensurePrivateDirectory } from './local-storage.mjs';
import { createHistoryStore } from './history-store.mjs';

export function createHistorySession({ root, profileDir = root }) {
  const fingerprint = createHash('sha256').update(resolve(profileDir)).digest('hex');
  const bindingDir = join(root, 'private', 'history-bindings');
  const bindingPath = join(bindingDir, fingerprint + '.json');
  const openStore = accountId => ({ accountId, datasetId: `account-${accountId}-${fingerprint.slice(0, 16)}`, store: createHistoryStore({ root, datasetId: `account-${accountId}-${fingerprint.slice(0, 16)}` }) });
  return {
    async local() {
      try {
        const info = await lstat(bindingPath);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 4096 || resolve(await realpath(bindingPath)) !== resolve(bindingPath)) throw new Error();
        const value = JSON.parse(await readFile(bindingPath, 'utf8'));
        if (value.profile !== fingerprint || typeof value.accountId !== 'string' || !/^[1-9]\d{0,19}$/.test(value.accountId)) throw new Error();
        return openStore(value.accountId);
      } catch (error) { if (error?.code === 'ENOENT') return null; throw new Error('HISTORY_UNSAFE'); }
    },
    async online(accountId) {
      if (typeof accountId !== 'string' || !/^[1-9]\d{0,19}$/.test(accountId)) throw new Error('HISTORY_IDENTITY_UNAVAILABLE');
      let temporary;
      try {
        await ensurePrivateDirectory(bindingDir);
        const previous = await this.local();
        if (previous?.accountId === accountId) return previous;
        temporary = bindingPath + '.' + randomBytes(12).toString('hex') + '.tmp';
        const file = await open(temporary, 'wx', 0o600);
        try { await file.writeFile(JSON.stringify({ version: 1, profile: fingerprint, accountId, verifiedAt: new Date().toISOString() }) + '\n'); await file.sync(); }
        finally { await file.close(); }
        await rename(temporary, bindingPath);
        return openStore(accountId);
      } catch (error) { if (temporary) await rm(temporary, { force: true }).catch(() => {}); throw new Error(error?.message === 'HISTORY_UNSAFE' ? 'HISTORY_UNSAFE' : 'HISTORY_WRITE_FAILED'); }
    },
  };
}
