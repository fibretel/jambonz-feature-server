/**
 * Fixture for test/drain-signal-test.js.
 *
 * Loads the REAL sbc-pinger and drives its real SIGUSR1 scale-in path. Drying up
 * calls has to mean leaving `<cluster>:active-fs`: the OPTIONS ping that sbc-pinger
 * sends advertises X-FS-Status: closed, but sbc-inbound picks a feature server
 * straight out of that redis set (sbc-inbound/lib/fs-tracking.js) and never looks
 * at the ping, so a drain that only pings keeps taking new calls.
 *
 * sbc-pinger reaches the srf instance with a lazy require('../..'), i.e. the
 * package root; we seed the module cache with a stub so requiring it does not boot
 * the whole feature server.
 */
process.env.NODE_ENV = 'test';
process.env.JAMBONES_SBCS = process.env.JAMBONES_SBCS || '127.0.0.1:5060';
delete process.env.K8S;
delete process.env.AWS_SNS_TOPIC_ARN;

const Module = require('module');
const noop = () => {};
const logger = {info: noop, error: noop, warn: noop, debug: noop};

const members = new Set();
const srf = {
  locals: {
    localSipAddress: '127.0.0.1:5070',
    sessionTracker: {count: 0},
    dbHelpers: {
      addToSet: (_s, m) => Promise.resolve(members.add(m)),
      removeFromSet: (_s, m) => Promise.resolve(members.delete(m))
    }
  }
};

const rootPath = require.resolve('../..');
const stub = new Module(rootPath, null);
stub.filename = rootPath;
stub.loaded = true;
stub.exports = {srf, logger};
require.cache[rootPath] = stub;

const {registerActiveFs} = require('../../lib/utils/active-fs-registration');
registerActiveFs(srf, logger, {clusterId: 'default', refreshMs: 20});

require('../../lib/utils/sbc-pinger')(logger);

setTimeout(() => process.kill(process.pid, 'SIGUSR1'), 60);
setTimeout(() => {
  process.stdout.write(`members=${members.size} timer=${!!srf.locals.activeFsRefreshTimer}\n`);
  process.exit(0);
}, 400);
