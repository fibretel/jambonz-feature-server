const test = require('tape');
const path = require('path');
const {spawn} = require('child_process');

/**
 * Deregistering on SIGTERM only counts if it actually runs, and only if the redis
 * write completes before the process exits. Both were broken:
 *
 *  - ProcessMonitor.setupSignalHandlers() is installed before app.js's own
 *    SIGTERM/SIGINT handler and used to call process.exit(0) from inside its
 *    logging handler. node runs listeners in registration order, so the process
 *    was gone before app.js's handler -- and the SREM in it -- ever ran. A dead
 *    feature server stayed in `<cluster>:active-fs` and sbc-inbound kept picking it.
 *  - even once it runs, the SREM is a round trip to redis and process.exit(0)
 *    happily beats it.
 *
 * Run in a real child process: this is a property of process-level signal
 * dispatch and cannot be asserted in-process.
 */
const runChild = (signal) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [path.join(__dirname, 'fixtures', 'shutdown-child.js')]);
  let out = '';
  let signalled = false;
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    reject(new Error('child did not exit'));
  }, 10000);

  child.stdout.on('data', (data) => {
    out += data.toString();
    if (!signalled && out.includes('ready')) {
      signalled = true;
      child.kill(signal);
    }
  });
  child.on('exit', (code) => {
    clearTimeout(timer);
    resolve({out, code});
  });
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  test(`${signal} reaches the application shutdown handler and the SREM completes`, async(t) => {
    const {out, code} = await runChild(signal);

    t.ok(out.includes('app-handler-ran'),
      `the application ${signal} handler ran (it was preempted by ProcessMonitor's process.exit)`);
    t.ok(out.includes(`signal=${signal}`), `handler saw ${signal}`);
    t.ok(out.includes('members=0'),
      'redis acknowledged the removal before the process exited (SREM is awaited, not fire-and-forget)');
    t.notOk(out.includes('no-signal-received'), 'the signal was delivered');
    t.equal(code, 0, 'exited cleanly');
    t.end();
  });
}
