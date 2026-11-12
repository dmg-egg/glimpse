import assert from 'node:assert/strict';
import childProcess, { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const testPath = fileURLToPath(import.meta.url);
const diagnostic = Buffer.from('[glimpse] synthetic diagnostic\nCocoa: synthetic input-method log\n');
const promptFailureDiagnostic = Buffer.from('[glimpse] synthetic diagnostic during prompt cleanup\n');
const burst = Buffer.concat([Buffer.alloc(2 * 1024 * 1024, 120), Buffer.from('\nsynthetic unicode: ☀️\n')]);
const timeoutMs = 10_000;

function waitFor(emitter, event) {
  return once(emitter, event, { signal: AbortSignal.timeout(timeoutMs) });
}

async function runMockHost() {
  const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
  process.stderr.write(diagnostic);
  const promptCallbackError = process.argv.includes('--prompt-callback-error');
  if (!promptCallbackError) send({ type: 'ready' });
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const msg = JSON.parse(line);
    if (msg.type === 'html') {
      send({ type: 'ready' });
      if (process.argv.includes('--auto-close')) {
        process.stdout.write(JSON.stringify({ type: 'closed' }) + '\n', () => process.exit(0));
      }
    }
    if (msg.type === 'eval') {
      process.stderr.write(burst, () => send({ type: 'message', data: { drained: true } }));
    }
    if (msg.type === 'hide') send({ type: 'visibility', visible: false });
    if (msg.type === 'show') send({ type: 'visibility', visible: true });
    if (msg.type === 'close') {
      const close = () => process.stdout.write(JSON.stringify({ type: 'closed' }) + '\n', () => process.exit(0));
      if (promptCallbackError) {
        // The close command proves the first chunk was delivered before this one.
        process.stderr.write(promptFailureDiagnostic, close);
      } else {
        close();
      }
    }
  });
}

async function runScenario(scenario) {
  // Exercise real child pipes using a synthetic Node host, never a native UI.
  const originalSpawn = childProcess.spawn;
  const originalExistsSync = fs.existsSync;
  const spawnOptions = [];
  const children = [];
  const childClosures = [];
  childProcess.spawn = (_path, args, options) => {
    spawnOptions.push(options);
    const mockArgs = scenario === 'prompt-callback-error' ? ['--prompt-callback-error'] : [];
    const child = originalSpawn(process.execPath, [testPath, '--mock-host', ...mockArgs, ...args], options);
    children.push(child);
    childClosures.push(waitFor(child, 'close'));
    return child;
  };
  fs.existsSync = () => true;
  syncBuiltinESMExports();
  if (process.platform === 'linux') process.env.GLIMPSE_BACKEND = 'chromium';
  delete process.env.GLIMPSE_BINARY_PATH;
  delete process.env.GLIMPSE_HOST_PATH;

  let win;
  try {
    const { open, prompt, statusItem } = await import('../src/glimpse.mjs');
    if (scenario === 'invalid') {
      for (const stderr of [null, false, 0, 'ignore', 'pipe', {}, []]) {
        assert.throws(() => open('', { stderr }), TypeError);
        assert.throws(() => statusItem('', { stderr }), TypeError);
        await assert.rejects(prompt('', { stderr }), TypeError);
      }
      assert.equal(spawnOptions.length, 0, 'invalid options must not spawn a host');
      return;
    }

    if (scenario === 'prompt-callback-error') {
      const failure = new Error('synthetic prompt capture failure');
      const failedChunks = [];
      const result = prompt('<body>synthetic</body>', {
        stderr: (chunk) => { failedChunks.push(chunk); throw failure; },
        timeout: timeoutMs,
      });
      await assert.rejects(result, (error) => error === failure);
      assert.equal(children.length, 1);
      assert.deepEqual(await childClosures[0], [0, null], 'prompt must close the host without fixture cleanup');
      assert.ok(failedChunks.length >= 2, 'both diagnostic writes must trigger handled failures, including after rejection');
      assert.deepEqual(Buffer.concat(failedChunks), Buffer.concat([diagnostic, promptFailureDiagnostic]));
      return;
    }

    const chunks = [];
    const errors = [];
    const callbackError = new Error('synthetic capture failure');
    let expectedLength = diagnostic.length;
    let resolveCaptured;
    const captured = new Promise((resolve) => { resolveCaptured = resolve; });
    let length = 0;
    let shouldThrow = scenario === 'callback-error';
    const capture = (chunk) => {
      assert.ok(Buffer.isBuffer(chunk));
      if (shouldThrow) {
        shouldThrow = false;
        throw callbackError;
      }
      chunks.push(chunk);
      length += chunk.length;
      if (length >= expectedLength) resolveCaptured();
    };

    if (scenario === 'prompt') {
      const result = await prompt('<body>synthetic</body>', { stderr: capture, timeout: timeoutMs });
      assert.equal(result, null);
      assert.equal(spawnOptions[0].stdio[2], 'pipe');
      await captured;
      assert.deepEqual(Buffer.concat(chunks), diagnostic);
      return;
    }

    const options = scenario === 'default' ? {}
      : scenario === 'inherit' ? { stderr: 'inherit' }
      : { stderr: capture };
    if (scenario === 'burst') expectedLength += burst.length;
    win = scenario === 'status-item'
      ? statusItem('<body>synthetic</body>', options)
      : open('<body>synthetic</body>', options);
    win.on('error', (error) => errors.push(error));
    // Expected callback errors must not reject the independently awaited ready event.
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ready timeout')), timeoutMs);
      win.once('ready', () => { clearTimeout(timer); resolve(); });
    });
    assert.equal(spawnOptions[0].stdio[2], ['default', 'inherit'].includes(scenario) ? 'inherit' : 'pipe');

    if (scenario === 'burst' || scenario === 'callback-error') {
      if (scenario === 'callback-error') {
        expectedLength = burst.length;
        assert.deepEqual(errors, [callbackError]);
      }
      const message = waitFor(win, 'message');
      win.send('synthetic drain check');
      assert.deepEqual((await message)[0], { drained: true });
    }
    if (!['default', 'inherit'].includes(scenario)) {
      await Promise.race([captured, new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('stderr capture timeout')), timeoutMs);
        timer.unref();
      })]);
      const expected = scenario === 'burst' ? Buffer.concat([diagnostic, burst])
        : scenario === 'callback-error' ? burst : diagnostic;
      assert.deepEqual(Buffer.concat(chunks), expected);
    }
    if (scenario !== 'callback-error') assert.deepEqual(errors, []);
    if (scenario === 'capture-visibility') {
      const hidden = waitFor(win, 'visibility');
      win.hide();
      assert.deepEqual(await hidden, [{ visible: false }]);
      const shown = waitFor(win, 'visibility');
      win.show({ activate: false });
      assert.deepEqual(await shown, [{ visible: true }]);
    }
    if (scenario === 'status-item') {
      assert.throws(() => win.hide(), /ordinary macOS windows/);
      assert.throws(() => win.show({ activate: false }), /ordinary macOS windows/);
    }
    if (scenario === 'read-error') {
      const readError = new Error('synthetic stderr read failure');
      children[0].stderr.emit('error', readError);
      assert.deepEqual(errors, [readError]);
    }
    const closed = waitFor(win, 'closed');
    win.close();
    await closed;
    win = null;
  } finally {
    win?.close();
    for (const child of children) {
      if (child.exitCode === null) {
        const exited = once(child, 'exit');
        child.kill();
        await exited;
      }
    }
    childProcess.spawn = originalSpawn;
    fs.existsSync = originalExistsSync;
    syncBuiltinESMExports();
  }
}

if (process.argv[2] === '--mock-host') {
  await runMockHost();
} else if (process.argv[2] === '--scenario') {
  await runScenario(process.argv[3]);
} else {
  const scenarios = ['default', 'inherit', 'capture', 'burst', 'callback-error', 'read-error', 'prompt', 'prompt-callback-error', 'invalid'];
  if (process.platform !== 'win32') scenarios.push('status-item');
  if (process.platform === 'darwin') scenarios.push('capture-visibility');
  for (const scenario of scenarios) {
    const result = spawnSync(process.execPath, [testPath, '--scenario', scenario], {
      encoding: 'utf8', timeout: 15_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${scenario}: ${result.stderr}`);
    assert.equal(result.stdout, '', `${scenario}: protocol must stay inside the wrapper`);
    const expectedStderr = scenario === 'prompt-callback-error'
      ? Buffer.concat([diagnostic, promptFailureDiagnostic]).toString()
      : ['default', 'inherit', 'callback-error'].includes(scenario) ? diagnostic.toString() : '';
    assert.equal(result.stderr, expectedStderr);
    console.log(`  ✓ synthetic stderr routing: ${scenario}`);
  }
}
