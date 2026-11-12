import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') {
  console.log('visibility native checks skipped (ordinary macOS windows only)');
  process.exit(0);
}

// Run serially with other native UI checks. No Accessibility or screen-capture grants.
const binary = fileURLToPath(new URL('../src/glimpse', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'glimpse-visibility-native-'));
const children = new Set();
const nativePids = new Set();
const hosts = new Set();
const waitFor = (emitter, event, stage = event) => once(emitter, event, { signal: AbortSignal.timeout(10_000) }).catch(error => {
  const context = [...hosts].map(host => ({
    pid: host.proc.pid, stdout: host.stdout().slice(-2_000), stderr: host.stderr().slice(-2_000),
  }));
  throw new Error(`Waiting for ${event} at ${stage}: ${JSON.stringify(context)}`, { cause: error });
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function finite(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Timeout waiting for process teardown')), 10_000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}
const HTML = `<!doctype html><meta charset="utf-8">
<input id="draft" value="retained input">
<button id="first" onclick="report('first')">First</button>
<button id="second" onclick="report('second')">Second</button>
<div id="list" style="height:150px; overflow:auto">${Array.from({ length: 40 }, (_, i) => `<div id="row-${i}" style="height:30px"${i === 12 ? ' class="selected"' : ''}>Row ${i}</div>`).join('')}</div>
<div id="update">initial</div>
<script>
// A document-retention token, not a security or request identity.
window.sentinel = String(Math.random());
window.originalDocument = document;
window.originalInput = document.getElementById('draft');
window.messageCount = 0;
function report(action) {
  window.glimpse.send({ action, count: ++messageCount, sentinel,
    sameDocument: originalDocument === document,
    sameInput: originalInput === document.getElementById('draft'),
    input: originalInput.value,
    selected: document.querySelector('.selected').id,
    scroll: document.getElementById('list').scrollTop,
    rows: document.getElementById('list').children.length,
    update: document.getElementById('update').textContent });
}
</script>`;

function harness(proc, extraTypes = []) {
  children.add(proc);
  const events = new EventEmitter();
  const lines = [];
  const errors = [];
  let stdout = '';
  let stderr = '';
  const exited = once(proc, 'exit');
  const drained = once(proc, 'close');
  proc.on('error', error => events.emit('error', error));
  events.on('error', error => errors.push(error));
  proc.stdout.on('data', chunk => { stdout += chunk; });
  proc.stderr?.on('data', chunk => { stderr += chunk; });
  createInterface({ input: proc.stdout }).on('line', line => {
    try {
      const msg = JSON.parse(line);
      assert.ok(['ready', 'visibility', 'message', 'info', 'closed', ...extraTypes].includes(msg.type), line);
      if (msg.type === 'visibility') {
        assert.deepEqual(Object.keys(msg).sort(), ['type', 'visible']);
        assert.equal(typeof msg.visible, 'boolean');
      }
      lines.push(msg);
      events.emit(msg.type, msg);
    } catch (error) {
      events.emit('error', error);
    }
  });
  const host = {
    proc, events, lines, errors, exited, drained,
    stdout: () => stdout,
    stderr: () => stderr,
    write: command => proc.stdin.write(JSON.stringify(command) + '\n'),
  };
  hosts.add(host);
  return host;
}

async function commandResult(host, command, event) {
  const result = waitFor(host.events, event, JSON.stringify(command));
  host.write(command);
  return (await result)[0];
}

async function start(args) {
  const host = harness(spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] }));
  nativePids.add(host.proc.pid);
  await waitFor(host.events, 'ready', `startup ${JSON.stringify(args)}`);
  await commandResult(host, { type: 'html', html: Buffer.from(HTML).toString('base64') }, 'ready');
  return host;
}

async function finish(host, eof = false, expectedStderr = '') {
  const closed = waitFor(host.events, 'closed', eof ? 'stdin EOF' : 'close command');
  if (eof) host.proc.stdin.end();
  else host.write({ type: 'close' });
  await closed;
  const [code, signal] = await finite(host.exited);
  await finite(host.drained);
  assert.equal(code, 0);
  assert.equal(signal, null);
  assert.equal(host.lines.filter(line => line.type === 'closed').length, 1);
  assert.equal(host.stderr(), expectedStderr);
  assert.deepEqual(host.errors, []);
  assert.ok(host.stdout().endsWith('\n'), 'stdout ends with a JSONL newline');
  nativePids.delete(host.proc.pid);
  children.delete(host.proc);
  hosts.delete(host);
}

try {
  const observerSource = join(dir, 'observe.swift');
  const observer = join(dir, 'observe');
  writeFileSync(observerSource, `import Cocoa
import CoreGraphics
let pid = Int(CommandLine.arguments[1])!
let windows = (CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []).filter {
    ($0[kCGWindowOwnerPID as String] as? Int) == pid && ($0[kCGWindowLayer as String] as? Int) == 0
}.compactMap { $0[kCGWindowNumber as String] as? Int }
let result: [String: Any] = ["frontmost": Int(NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0), "windows": windows.sorted()]
print(String(data: try! JSONSerialization.data(withJSONObject: result), encoding: .utf8)!)
`);
  execFileSync('swiftc', [observerSource, '-o', observer], { timeout: 60_000 });
  const observe = pid => JSON.parse(execFileSync(observer, [String(pid)], { encoding: 'utf8', timeout: 5_000 }));

  for (const hidden of [true, false]) {
    const host = await start(['--width', '400', '--height', '300', '--title', 'Visibility Test', ...(hidden ? ['--hidden'] : [])]);
    const pid = host.proc.pid;
    await commandResult(host, { type: 'eval', js: `originalInput.focus(); document.getElementById('list').scrollTop = 270; report('baseline')` }, 'message');
    const baseline = host.lines.at(-1).data;
    assert.equal(baseline.scroll, 270);
    assert.equal(baseline.selected, 'row-12');
    let messageCount = baseline.count;
    const invalidActivateValues = [null, 0, 1, 'false', 'true', {}, []];
    const beforeInvalid = observe(pid);
    if (hidden) assert.notEqual(beforeInvalid.frontmost, pid);
    const visibilityCount = host.lines.filter(line => line.type === 'visibility').length;
    for (const activate of invalidActivateValues) {
      host.write({ type: 'show', activate });
      // get-info is an existing command; its receipt confirms this ordered batch was handled.
      await commandResult(host, { type: 'get-info' }, 'info');
      assert.equal(host.lines.filter(line => line.type === 'visibility').length, visibilityCount,
        'malformed native show has no visibility receipt');
    }
    await delay(150);
    if (hidden) assert.equal(observe(pid).frontmost, beforeInvalid.frontmost,
      'malformed native show does not activate');
    const expectedStderr = invalidActivateValues.map(() => '[glimpse] show command: activate must be a JSON boolean\n').join('');
    let windowIds;
    if (!hidden) {
      windowIds = observe(pid).windows;
      assert.ok(windowIds.length > 0, 'ordinary window ID is observable without screen capture');
    }
    const report = async (action, rows, update) => {
      const msg = await commandResult(host, { type: 'eval', js: action === 'first' || action === 'second' ? `document.getElementById('${action}').click()` : `report('${action}')` }, 'message');
      assert.deepEqual(msg.data, { ...baseline, action, count: ++messageCount, rows, update });
      assert.equal(host.proc.pid, pid);
      assert.equal(host.proc.exitCode, null);
      assert.equal(host.lines.filter(line => line.type === 'closed').length, 0);
    };
    for (let cycle = 0; cycle < 3; cycle++) {
      for (let repeat = 0; repeat < 2; repeat++) {
        assert.equal((await commandResult(host, { type: 'hide' }, 'visibility')).visible, false);
      }
      await report('first', 40 + cycle, cycle ? `hidden-${cycle - 1}` : 'initial');
      await report('second', 40 + cycle, cycle ? `hidden-${cycle - 1}` : 'initial');
      await commandResult(host, { type: 'eval', js: `(() => { const row = document.createElement('div'); row.textContent = 'Appended'; document.getElementById('list').append(row); document.getElementById('update').textContent = 'hidden-${cycle}'; report('updated'); })()` }, 'message').then(msg => {
        assert.deepEqual(msg.data, { ...baseline, action: 'updated', count: ++messageCount, rows: 41 + cycle, update: `hidden-${cycle}` });
      });
      for (let repeat = 0; repeat < 2; repeat++) {
        const before = observe(pid);
        assert.ok(before.frontmost > 0);
        if (hidden) assert.notEqual(before.frontmost, pid, 'each startup-hidden reveal starts with another app frontmost');
        assert.equal((await commandResult(host, { type: 'show', activate: false, title: 'Retained' }, 'visibility')).visible, true);
        await delay(150);
        const after = observe(pid);
        assert.equal(after.frontmost, before.frontmost, 'nonactivating show preserves observed foreground app');
        assert.ok(after.windows.length > 0);
        if (windowIds) assert.deepEqual(after.windows, windowIds, 'same native window IDs across hide/show');
        else windowIds = after.windows;
      }
      await report('first', 41 + cycle, `hidden-${cycle}`);
      await report('second', 41 + cycle, `hidden-${cycle}`);
    }
    // Omission still takes the legacy activation path and returns a visibility receipt.
    assert.equal((await commandResult(host, { type: 'show' }, 'visibility')).visible, true);
    await report('legacy-show', 43, 'hidden-2');
    assert.equal((await commandResult(host, { type: 'show', activate: true }, 'visibility')).visible, true);
    await commandResult(host, { type: 'hide' }, 'visibility');
    await finish(host, !hidden, expectedStderr);
    console.log('native show: malformed activation diagnosed/ignored; boolean true/false and omission accepted');
    console.log(`native ${hidden ? 'startup hidden / close' : 'startup shown / EOF'}: retained PID/window/document/input/selection/scroll, hidden eval, independent repeated messages, JSONL, one terminal event`);
    console.log(hidden
      ? 'startup hidden: settled external foreground PID preserved for all 6 nonactivating reveals (not responder-focus proof)'
      : 'startup shown: retention/state coverage only, not external-app nonactivation proof');
  }

  // A controller dying closes its pipe; the native process must finish on EOF.
  const parentScript = `const { spawn } = require('node:child_process');
const child = spawn(process.argv[1], ['--hidden'], { stdio: ['pipe', 'inherit', 'inherit'] });
process.stdout.write(JSON.stringify({ type: 'parent', pid: child.pid }) + '\\n');
process.stdin.once('data', () => process.exit(0));`;
  const parent = harness(spawn(process.execPath, ['-e', parentScript, binary], { stdio: ['pipe', 'pipe', 'pipe'] }), ['parent']);
  const parentMarker = waitFor(parent.events, 'parent', 'controller spawn marker');
  const ready = waitFor(parent.events, 'ready', 'controller child startup');
  const nativePid = (await parentMarker)[0].pid;
  nativePids.add(nativePid);
  await ready;
  const closed = waitFor(parent.events, 'closed', 'controller teardown EOF');
  parent.proc.stdin.write('exit\n');
  await closed;
  assert.equal((await finite(parent.exited))[0], 0);
  await finite(parent.drained);
  assert.equal(parent.lines.filter(line => line.type === 'closed').length, 1);
  assert.equal(parent.stderr(), '');
  assert.deepEqual(parent.errors, []);
  assert.ok(parent.stdout().endsWith('\n'));
  for (let i = 0; i < 100; i++) {
    try { process.kill(nativePid, 0); } catch (error) {
      if (error.code !== 'ESRCH') throw error;
      nativePids.delete(nativePid);
      break;
    }
    await delay(20);
  }
  assert.ok(!nativePids.has(nativePid), 'native process exits finitely after controller teardown');
  children.delete(parent.proc);
  hosts.delete(parent);
  console.log('native parent teardown: EOF, one closed JSONL event, finite process exit');
  console.log('No Accessibility/Focus/Spaces changes. Foreground PID samples do not prove responder focus, occlusion/Spaces visibility, or Focus/DND compliance; manual checks remain necessary.');
} finally {
  // Register exit waiters before signals, then wait finitely for our own children.
  const exits = [...children].map(proc => proc.exitCode !== null || proc.signalCode !== null
    ? Promise.resolve() : once(proc, 'exit', { signal: AbortSignal.timeout(10_000) }));
  for (const proc of children) {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
  }
  for (const pid of nativePids) {
    try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  try {
    await Promise.all(exits);
    for (const pid of nativePids) {
      let exited = false;
      for (let i = 0; i < 100; i++) {
        try { process.kill(pid, 0); } catch (error) {
          if (error.code !== 'ESRCH') throw error;
          exited = true;
          break;
        }
        await delay(20);
      }
      assert.ok(exited, `cleanup waits for native PID ${pid} to exit`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
