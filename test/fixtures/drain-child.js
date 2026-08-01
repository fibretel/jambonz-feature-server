/**
 * Fixture for test/drain-signal-test.js.
 *
 * Loads the REAL sbc-pinger and drives its real SIGUSR1 scale-in path. Drying up
 * calls has to mean leaving `<cluster>:active-fs`: the OPTIONS ping that sbc-pinger
 * sends advertises X-FS-Status: closed, but sbc-inbound picks a feature server
 * straight out of that redis set (sbc-inbound/lib/fs-tracking.js) and never looks
 * at the ping, so a drain that only pings keeps taking new calls.
 *
 * The same is true of `<cluster>:fs-service-url`, and for the same reason: that is
 * where api-server picks a feature server for REST-originated calls
 * (POST /v1/Accounts/:sid/Calls) and for messaging. It never sees the OPTIONS ping
 * either, so a drain that leaves only active-fs keeps taking new REST work -- and
 * the fs-service-url refresh timer re-asserts membership every 30s for as long as
 * the process lives.
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

/* keyed by set name: active-fs and fs-service-url are independent advertisements
   and a fixture that collapses them into one set cannot see one of them survive */
const sets = new Map();
const setOf = (name) => {
  if (!sets.has(name)) sets.set(name, new Set());
  return sets.get(name);
};
const sizeOf = (name) => (sets.get(name)?.size ?? 0);

const srf = {
  locals: {
    localSipAddress: '127.0.0.1:5070',
    serviceUrl: 'http://127.0.0.1:3000',
    sessionTracker: {count: 0},
    dbHelpers: {
      addToSet: (s, m) => Promise.resolve(setOf(s).add(m)),
      removeFromSet: (s, m) => Promise.resolve(setOf(s).delete(m))
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
const {registerFsServiceUrl} = require('../../lib/utils/fs-service-url-registration');
registerActiveFs(srf, logger, {clusterId: 'default', refreshMs: 20});
registerFsServiceUrl(srf, logger, {clusterId: 'default', refreshMs: 20});

require('../../lib/utils/sbc-pinger')(logger);

setTimeout(() => process.kill(process.pid, 'SIGUSR1'), 60);
setTimeout(() => {
  process.stdout.write([
    `members=${sizeOf('default:active-fs')}`,
    `timer=${!!srf.locals.activeFsRefreshTimer}`,
    `svcUrlMembers=${sizeOf('default:fs-service-url')}`,
    `svcUrlTimer=${!!srf.locals.fsServiceUrlRefreshTimer}`
  ].join(' ') + '\n');
  process.exit(0);
}, 400);
