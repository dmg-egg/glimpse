import assert from 'node:assert/strict';
import childProcess, { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sourceDir = fileURLToPath(new URL('../src/', import.meta.url));
const waitFor = (emitter, event) => once(emitter, event, { signal: AbortSignal.timeout(5_000) });

if (process.env.GLIMPSE_VISIBILITY_MOCK_DIR) {
  // Simulate host resolution, not native window behavior. No UI is spawned.
  Object.defineProperty(process, 'platform', { value: process.env.GLIMPSE_VISIBILITY_MOCK_PLATFORM });
  delete process.env.GLIMPSE_BINARY_PATH;
  delete process.env.GLIMPSE_HOST_PATH;
  if (process.platform !== 'darwin') {
    process.env.GLIMPSE_BINARY_PATH = join(process.env.GLIMPSE_VISIBILITY_MOCK_DIR, 'glimpse');
  }
  process.env.GLIMPSE_BACKEND = 'native';
  // Only this isolated subprocess changes the spawn boundary. Platform spoofing
  // does not change the OS launcher; Node runs the fixture on every real host.
  const originalSpawn = childProcess.spawn;
  const fixture = join(process.env.GLIMPSE_VISIBILITY_MOCK_DIR, 'glimpse');
  childProcess.spawn = (path, args, options) => {
    assert.equal(realpathSync(path), realpathSync(fixture), 'simulated host still resolves the fixture');
    const proc = originalSpawn(process.execPath, [path, ...args], options);
    assert.equal(proc.spawnfile, process.execPath, 'fixture launches through Node');
    return proc;
  };
  syncBuiltinESMExports();
  const { open, statusItem } = await import(pathToFileURL(join(process.env.GLIMPSE_VISIBILITY_MOCK_DIR, 'glimpse.mjs')));
  const win = open('<body>synthetic</body>', { hidden: true });
  let closedCount = 0;
  win.on('closed', () => closedCount++);
  try {
    await waitFor(win, 'ready');
    for (const activate of [0, 1, 'false', 'true', {}, [], NaN]) {
      assert.throws(() => win.show({ activate }), {
        name: 'TypeError', message: 'show options.activate must be a boolean',
      });
    }
    if (process.platform === 'darwin') {
      for (const visible of [false, false, true, false, true]) {
        const receipt = waitFor(win, 'visibility');
        if (visible) win.show({ activate: false, title: 'Synthetic' });
        else win.hide();
        assert.deepEqual(await receipt, [{ visible }]);
        assert.equal(closedCount, 0);
      }
    } else {
      assert.throws(() => win.hide(), /ordinary macOS windows/);
      assert.throws(() => win.show({ activate: false }), /ordinary macOS windows/);
    }
    const echo = waitFor(win, 'message');
    win.show({ title: 'Legacy' });
    assert.deepEqual(await echo, [{ command: { type: 'show', title: 'Legacy' } }]);
    const omitted = waitFor(win, 'message');
    win.show({ activate: null });
    assert.deepEqual(await omitted, [{ command: { type: 'show' } }]);
    const explicit = waitFor(win, 'message');
    win.show({ activate: true });
    assert.deepEqual(await explicit, [{ command: { type: 'show', activate: true } }]);
    const closed = waitFor(win, 'closed');
    win.close();
    await closed;
    // Duplicate native closed + process exit still yields one wrapper terminal event.
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(closedCount, 1);
    if (process.platform === 'darwin') {
      win.hide();
      win.show({ activate: false });
    }
    win.send('ignored after close');
    win.close();
  } finally {
    win.close();
  }
  if (process.platform === 'darwin') {
    const item = statusItem('<body>synthetic</body>');
    try {
      await waitFor(item, 'ready');
      assert.throws(() => item.hide(), /ordinary macOS windows/);
      assert.throws(() => item.show({ activate: false }), /ordinary macOS windows/);
      for (const activate of [0, 1, 'false', 'true', {}, [], NaN]) {
        assert.throws(() => item.show({ activate }), {
          name: 'TypeError', message: 'show options.activate must be a boolean',
        });
      }
      const shown = waitFor(item, 'message');
      item.show();
      assert.deepEqual(await shown, [{ command: { type: 'show' } }]);
      const closed = waitFor(item, 'closed');
      item.close();
      await closed;
    } finally {
      item.close();
    }
  }
} else {
  const swift = readFileSync(join(sourceDir, 'glimpse.swift'), 'utf8');
  const hide = swift.split('case "hide":')[1].split('case "show":')[0];
  assert.match(hide, /guard !config\.statusItem/);
  assert.match(hide, /hidden = true/);
  assert.match(hide, /window\.orderOut\(nil\)/);
  assert.match(hide, /"visible": window\.isVisible/);
  assert.doesNotMatch(hide, /closeAndExit|loadHTML|WKWebView\(|exit\(/);
  const show = swift.split('case "show":')[1].split('case "title":')[0];
  assert.match(show, /if let rawActivate = json\["activate"\]/);
  assert.match(show, /CFGetTypeID\(value\) == CFBooleanGetTypeID\(\)/);
  assert.match(show, /activate = value\.boolValue/);
  assert.match(show, /activate = true/);
  assert.match(show, /log\("show command: activate must be a JSON boolean"\)\s*return/);
  assert.doesNotMatch(show, /as\? Bool \?\? true/);
  assert.match(show, /guard activate else/);
  assert.match(show, /activateOnLoad = activate/);
  const nonactivating = show.split('} else {').at(-1);
  assert.match(nonactivating, /window\.orderFrontRegardless\(\)/);
  assert.doesNotMatch(nonactivating, /activate\(|makeKey|makeFirstResponder|setActivationPolicy|\.level/);
  assert.match(swift, /else if activateOnLoad \{\s*window\.makeFirstResponder\(webView\)/);

  const dir = mkdtempSync(join(tmpdir(), 'glimpse-visibility-mock-'));
  try {
    for (const name of ['glimpse.mjs', 'follow-cursor-support.mjs']) {
      copyFileSync(join(sourceDir, name), join(dir, name));
    }
    const fixture = join(dir, 'glimpse');
    writeFileSync(fixture, `const { createInterface } = require('node:readline');
const emit = msg => process.stdout.write(JSON.stringify(msg) + '\\n');
emit({ type: 'ready' });
const rl = createInterface({ input: process.stdin });
rl.on('line', line => {
  const command = JSON.parse(line);
  switch (command.type) {
    case 'html': emit({ type: 'ready' }); break;
    case 'hide': emit({ type: 'visibility', visible: false }); break;
    case 'show':
      if (command.activate === false) emit({ type: 'visibility', visible: true });
      else emit({ type: 'message', data: { command } });
      break;
    case 'close':
      emit({ type: 'closed' });
      emit({ type: 'closed' });
      process.exit(0);
      break;
    default: throw new Error('Unexpected command: ' + line);
  }
});
rl.on('close', () => process.exit(0));
`);
    for (const platform of ['darwin', 'linux', 'win32']) {
      const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
        env: { ...process.env, GLIMPSE_VISIBILITY_MOCK_DIR: dir, GLIMPSE_VISIBILITY_MOCK_PLATFORM: platform },
        encoding: 'utf8', timeout: 15_000,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr || result.stdout);
    }
    console.log('visibility mock/source checks passed (not native verification)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
