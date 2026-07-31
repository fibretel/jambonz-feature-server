/**
 * Fixture for test/shutdown-signal-test.js -- reproduces app.js's shutdown wiring
 * in a real child process, using the REAL ProcessMonitor and the REAL
 * active-fs-registration helper, so the test exercises the actual signal path
 * rather than a mock of it.
 *
 * Mirrors app.js exactly in the two respects that matter:
 *  - ProcessMonitor.setupSignalHandlers() is installed FIRST (app.js does this
 *    before anything else), so a handler in it that exits would preempt ours
 *  - the app's own SIGTERM/SIGINT handler deregisters from redis and only then
 *    calls process.exit(0) when there are no calls in progress
 *
 * The fake redis write resolves after a delay: an unawaited SREM loses the race
 * with process.exit() and the child prints nothing.
 */
const ProcessMonitor = require('../../lib/utils/process-monitor');
const {registerActiveFs, unregisterActiveFs} = require('../../lib/utils/active-fs-registration');

const REDIS_WRITE_DELAY_MS = 150;
const noop = () => {};
const logger = {info: noop, error: noop, warn: noop, debug: noop};

const members = new Set();
const srf = {
  locals: {
    localSipAddress: '127.0.0.1:5070',
    dbHelpers: {
      addToSet: (_s, m) => new Promise((resolve) => setTimeout(() => (members.add(m), resolve(1)), 0)),
      removeFromSet: (_s, m) => new Promise((resolve) =>
        setTimeout(() => (members.delete(m), resolve(1)), REDIS_WRITE_DELAY_MS))
    }
  }
};

const monitor = new ProcessMonitor(logger);
monitor.logStartup = noop;
monitor.setupSignalHandlers();

registerActiveFs(srf, logger, {clusterId: 'default', refreshMs: 20});

async function handle(signal) {
  await unregisterActiveFs(srf, logger, {clusterId: 'default'});
  process.stdout.write(`app-handler-ran signal=${signal} members=${[...members].length}\n`);
  process.exit(0);
}
process.on('SIGTERM', handle);
process.on('SIGINT', handle);

/* let the parent know we are wired up and ready to be signalled */
setTimeout(() => process.stdout.write('ready\n'), 30);

/* safety net so a broken fixture cannot hang the suite */
setTimeout(() => {
  process.stdout.write('no-signal-received\n');
  process.exit(2);
}, 5000);
