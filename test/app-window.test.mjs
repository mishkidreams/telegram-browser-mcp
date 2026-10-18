// Synthetic only: test the headed operator window, not a headless substitute.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHarness } from '../src/harness.mjs';
import { openOperatorWindow } from '../src/operator-window.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('operator launch rejects unsafe addresses and never returns a capability in errors', async () => {
  const capability = 'A'.repeat(43);
  const invalid = [
    `https://127.0.0.1:9/#${capability}`,
    `http://127.0.0.1:9/other#${capability}`,
    `http://127.0.0.1:9/?token=synthetic#${capability}`,
    `http://synthetic:synthetic@127.0.0.1:9/#${capability}`,
    'http://127.0.0.1:9/#short',
  ];
  for (const viewerUrl of invalid) {
    await assert.rejects(openOperatorWindow({ profileDir: join(tmpdir(), 'unused-operator-validation'), viewerUrl }), error => error.message === 'OPERATOR_WINDOW_FAILED' && !String(error).includes(capability));
  }
});
test('headed operator window loads controls and the stream instead of staying blank', { timeout: 20_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'telegram-app-startup-'));
  let harness, viewer;
  t.after(async () => {
    await viewer?.close();
    await harness?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  harness = await startHarness({ mode: 'fixture', profileDir: join(root, 'fixture') });
  viewer = await openOperatorWindow({ profileDir: join(root, 'operator'), viewerUrl: harness.viewerUrl });
  assert.equal(harness.status().operatorConnected, true, 'Headed viewer must connect instead of staying blank.');
  await viewer.close(); viewer = undefined;
  const deadline = Date.now() + 3000;
  while (harness.status().operatorConnected && Date.now() < deadline) await wait(50);
  assert.equal(harness.status().operatorConnected, false);
  // Repeat with the same operator profile, not just a fresh first launch.
  viewer = await openOperatorWindow({ profileDir: join(root, 'operator'), viewerUrl: harness.viewerUrl });
  assert.equal(harness.status().operatorConnected, true);
});
