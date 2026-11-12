import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { EventEmitter, once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';

// Mock the process boundary, not GUI placement. No native host or browser is launched.
const originalSpawn = childProcess.spawn;
const originalExistsSync = fs.existsSync;
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const envKeys = ['GLIMPSE_BINARY_PATH', 'GLIMPSE_HOST_PATH', 'GLIMPSE_BACKEND'];
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const calls = [];
const activeHosts = new Set();

function mockSpawn(path, args, options) {
  const proc = new EventEmitter();
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  calls.push({ path, args, options });
  activeHosts.add(proc);

  const ready = () => proc.stdout.write(JSON.stringify({ type: 'ready' }) + '\n');
  proc.stdin.on('data', (chunk) => {
    for (const line of chunk.toString().trim().split('\n')) {
      const command = JSON.parse(line);
      if (command.type === 'html') queueMicrotask(ready);
      if (command.type === 'close') {
        queueMicrotask(() => {
          proc.stdout.write(JSON.stringify({ type: 'closed' }) + '\n');
          proc.stdout.end();
          proc.stdin.end();
          activeHosts.delete(proc);
          proc.emit('exit', 0);
        });
      }
    }
  });
  queueMicrotask(ready);
  return proc;
}

const scenarios = [
  { name: 'macOS native', platform: 'darwin', host: 'darwin', equals: false },
  { name: 'Windows native', platform: 'win32', host: 'win32', equals: false },
  { name: 'Linux native', platform: 'linux', host: 'linux', backend: 'native', equals: true },
  { name: 'Linux Chromium', platform: 'linux', host: 'linux-chromium', backend: 'chromium', equals: false },
  { name: 'macOS binary override', platform: 'darwin', host: 'override', override: 'binary', equals: false },
  { name: 'Windows binary override', platform: 'win32', host: 'override', override: 'binary', equals: false },
  { name: 'Linux binary override', platform: 'linux', host: 'override', override: 'binary', equals: true },
  { name: 'Linux host alias override', platform: 'linux', host: 'override', override: 'alias', equals: true },
  { name: 'Linux override takes precedence over Chromium', platform: 'linux', host: 'override', override: 'binary', backend: 'chromium', equals: true },
];

const cases = [
  { name: 'omitted positions and offsets', options: {}, pairs: [] },
  { name: 'empty offsets', options: { cursorOffset: {} }, pairs: [] },
  { name: 'null positions and offsets', options: { x: null, y: null, cursorOffset: { x: null, y: null } }, pairs: [] },
  { name: 'undefined positions and offsets', options: { x: undefined, y: undefined, cursorOffset: { x: undefined, y: undefined } }, pairs: [] },
];
const fields = [
  { name: 'x', flag: '--x', options: (value) => ({ x: value }) },
  { name: 'y', flag: '--y', options: (value) => ({ y: value }) },
  { name: 'cursorOffset.x', flag: '--cursor-offset-x', options: (value) => ({ cursorOffset: { x: value } }) },
  { name: 'cursorOffset.y', flag: '--cursor-offset-y', options: (value) => ({ cursorOffset: { y: value } }) },
];
for (const value of [0, 123, -123]) {
  for (const field of fields) {
    cases.push({ name: `${field.name}=${value}`, options: field.options(value), pairs: [[field.flag, String(value)]] });
  }
  cases.push({
    name: `all positions and offsets=${value}`,
    options: { x: value, y: value, cursorOffset: { x: value, y: value } },
    pairs: fields.map(({ flag }) => [flag, String(value)]),
  });
}

for (const anchor of ['top-left', 'top-right', 'right', 'bottom-right', 'bottom-left', 'left']) {
  cases.push({
    name: `${anchor} preserves zero offset defaults`,
    options: { cursorAnchor: anchor },
    pairs: [],
    trailing: ['--cursor-anchor', anchor],
  });
}
for (const value of [0, 17, -17]) {
  for (const field of fields.slice(2)) {
    cases.push({
      name: `anchor with explicit ${field.name}=${value} preserves other axis default`,
      options: { cursorAnchor: 'top-right', ...field.options(value) },
      pairs: [[field.flag, String(value)]],
      trailing: ['--cursor-anchor', 'top-right'],
    });
  }
}
cases.push({
  name: 'mixed signs with anchor and other options',
  options: { width: 240, height: 180, title: 'Argument Test', frameless: true, hidden: true,
    x: -300, y: 200, cursorOffset: { x: 30, y: -40 }, cursorAnchor: 'bottom-left', followMode: 'spring' },
  leading: ['--width', '240', '--height', '180', '--title', 'Argument Test', '--frameless', '--hidden'],
  pairs: [['--x', '-300'], ['--y', '200'], ['--cursor-offset-x', '30'], ['--cursor-offset-y', '-40']],
  trailing: ['--cursor-anchor', 'bottom-left', '--follow-mode', 'spring'],
});

try {
  childProcess.spawn = mockSpawn;
  fs.existsSync = () => true;
  syncBuiltinESMExports();
  const { open, getNativeHostInfo } = await import('../src/glimpse.mjs');

  for (const scenario of scenarios) {
    Object.defineProperty(process, 'platform', { ...originalPlatform, value: scenario.platform });
    for (const key of envKeys) delete process.env[key];
    if (scenario.backend) process.env.GLIMPSE_BACKEND = scenario.backend;
    if (scenario.override) {
      process.env[scenario.override === 'alias' ? 'GLIMPSE_HOST_PATH' : 'GLIMPSE_BINARY_PATH'] = '/synthetic/glimpse-host';
    }
    const host = getNativeHostInfo();
    assert.equal(host.platform, scenario.host, scenario.name);

    for (const testCase of cases) {
      const win = open('<body>argument test</body>', testCase.options);
      try {
        await once(win, 'ready', { signal: AbortSignal.timeout(2_000) });
        const call = calls.at(-1);
        const numericArgs = testCase.pairs.flatMap(([flag, value]) =>
          scenario.equals ? [`${flag}=${value}`] : [flag, value]);
        assert.equal(call.path, host.path);
        assert.deepEqual(call.args, [
          ...(host.extraArgs || []), ...(testCase.leading || []), ...numericArgs, ...(testCase.trailing || []),
        ], `${scenario.name}: ${testCase.name}`);
        assert.equal(call.options.windowsHide, scenario.platform === 'win32');
      } finally {
        const closed = once(win, 'closed', { signal: AbortSignal.timeout(2_000) });
        win.close();
        await closed;
      }
    }
    console.log(`  ✓ ${scenario.name}: ${cases.length} mock-host argument cases`);
  }
  assert.equal(activeHosts.size, 0, 'all mock hosts closed');
  console.log(`glimpse argument checks passed (${scenarios.length * cases.length} mock-host cases; no native UI)`);
} finally {
  for (const proc of activeHosts) {
    proc.stdin.destroy();
    proc.stdout.destroy();
  }
  childProcess.spawn = originalSpawn;
  fs.existsSync = originalExistsSync;
  Object.defineProperty(process, 'platform', originalPlatform);
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  syncBuiltinESMExports();
}
