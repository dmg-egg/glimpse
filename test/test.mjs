import { open } from '../src/glimpse.mjs';

const TIMEOUT_MS = 10_000;

const HTML = `<!DOCTYPE html>
<html>
  <body>
    <button id="btn" onclick="window.glimpse.send({action:'clicked'})">Click</button>
  </body>
</html>`;

function pass(msg) {
  console.log(`  ✓ ${msg}`);
}

function fail(msg) {
  console.error(`  ✗ ${msg}`);
  process.exit(1);
}

function waitFor(emitter, event, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for '${event}' after ${timeoutMs}ms`));
    }, timeoutMs);

    emitter.once(event, (...args) => {
      clearTimeout(timer);
      resolve(args);
    });

    emitter.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

console.log('glimpse integration test\n');

let win;
try {
  // Step 1: Open window
  win = open(HTML, {
    title: 'Glimpse Test',
    width: 400,
    height: 300,
    openLinks: true,
  });
  pass('Window opened');

  // Step 2: Wait for ready (open() internally sets HTML on ready, then emits ready to us)
  await waitFor(win, 'ready');
  pass('ready event received');

  // Step 3: Programmatically click the button via eval
  const message = waitFor(win, 'message');
  win.send(`document.getElementById('btn').click()`);
  pass('Sent eval: btn.click()');

  // Step 4: Wait for message and assert payload
  const [data] = await message;
  if (data?.action !== 'clicked') {
    fail(`Expected data.action === 'clicked', got: ${JSON.stringify(data)}`);
  }
  pass(`message received: ${JSON.stringify(data)}`);

  // Step 5: Close window
  const closed = waitFor(win, 'closed');
  win.close();
  pass('Sent close');

  // Step 6: Wait for closed
  await closed;
  pass('closed event received');

  console.log('\nAll tests passed');
  process.exit(0);
} catch (err) {
  console.error(`\n  ✗ ${err.message}`);
  win?.close();
  process.exit(1);
}
