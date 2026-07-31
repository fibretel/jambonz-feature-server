const test = require('tape');
const {
  fsServiceUrlSetName,
  registerFsServiceUrl,
  unregisterFsServiceUrl
} = require('../lib/utils/fs-service-url-registration');

const noop = () => {};
const logger = {error: noop, info: noop, debug: noop, warn: noop};

/**
 * @param {string} serviceUrl
 * @param {number} [writeDelayMs] - how long redis takes to acknowledge a write;
 *   non-zero exposes callers that do not wait for the write to land
 */
const makeSrf = (serviceUrl, writeDelayMs = 0) => {
  const added = [];
  const removed = [];
  /* the set as redis would actually hold it, so ordering bugs are visible */
  const members = new Set();
  const settle = (fn) => new Promise((resolve) => {
    if (!writeDelayMs) return (fn(), resolve(1));
    setTimeout(() => (fn(), resolve(1)), writeDelayMs);
  });
  return {
    added,
    removed,
    members,
    locals: {
      serviceUrl,
      dbHelpers: {
        addToSet: (setName, member) => {
          added.push(`${setName}|${member}`);
          return settle(() => members.add(member));
        },
        removeFromSet: (setName, member) => {
          removed.push(`${setName}|${member}`);
          return settle(() => members.delete(member));
        }
      }
    }
  };
};

test('fs-service-url set name matches what api-server reads', (t) => {
  /* api-server builds this exact string in lib/routes/api/accounts.js and
     lib/routes/api/sms-inbound.js; a mismatch here is an invisible outage */
  t.equal(fsServiceUrlSetName('default'), 'default:fs-service-url', 'default cluster');
  t.equal(fsServiceUrlSetName('mycluster'), 'mycluster:fs-service-url', 'named cluster');
  t.equal(fsServiceUrlSetName(undefined), 'default:fs-service-url', 'unset JAMBONES_CLUSTER_ID defaults');
  t.end();
});

test('registerFsServiceUrl adds our service url immediately', (t) => {
  const srf = makeSrf('http://10.128.70.3:3000');
  const timer = registerFsServiceUrl(srf, logger, {clusterId: 'default', refreshMs: 60000});

  t.deepEqual(srf.added, ['default:fs-service-url|http://10.128.70.3:3000'],
    'registered once the http listener bound');
  clearInterval(timer);
  t.end();
});

test('the member is the bare service url, with no path appended', (t) => {
  /* api-server appends the path itself -- `${f}/v1/createCall` and
     `${f}/v1/messaging/${provider}` -- so a member carrying a path would
     produce http://host:3000/v1/createCall/v1/createCall */
  const srf = makeSrf('http://10.128.70.3:3000');
  const timer = registerFsServiceUrl(srf, logger, {clusterId: 'default', refreshMs: 60000});

  t.deepEqual([...srf.members], ['http://10.128.70.3:3000'], 'no path baked into the member');
  clearInterval(timer);
  t.end();
});

test('registerFsServiceUrl re-asserts membership on the refresh cadence', (t) => {
  /* a redis restart or FLUSHALL must self-heal, exactly as active-fs does */
  const srf = makeSrf('http://10.128.70.3:3000');
  const timer = registerFsServiceUrl(srf, logger, {clusterId: 'default', refreshMs: 25});

  setTimeout(() => {
    clearInterval(timer);
    t.ok(srf.added.length >= 3, `re-registered across refresh cycles (${srf.added.length} writes)`);
    t.ok(srf.added.every((v) => v === 'default:fs-service-url|http://10.128.70.3:3000'),
      'always the same member');
    t.end();
  }, 250);
});

test('registerFsServiceUrl does not stack timers when the listener re-binds', (t) => {
  const srf = makeSrf('http://10.128.70.3:3000');
  registerFsServiceUrl(srf, logger, {clusterId: 'default', refreshMs: 30});
  const timer = registerFsServiceUrl(srf, logger, {clusterId: 'default', refreshMs: 30});

  const afterTwoRegisters = srf.added.length;
  t.equal(afterTwoRegisters, 2, 'two immediate registrations, one per bind');

  setTimeout(() => {
    clearInterval(timer);
    const refreshes = srf.added.length - afterTwoRegisters;
    t.ok(refreshes <= 4, `only one refresh timer is running (${refreshes} refreshes in ~100ms at 30ms)`);
    t.end();
  }, 100);
});

test('registerFsServiceUrl is a no-op before the http listener has bound', (t) => {
  const srf = makeSrf(undefined);
  const timer = registerFsServiceUrl(srf, logger, {clusterId: 'default', refreshMs: 30});

  t.equal(timer, null, 'no timer created');
  t.deepEqual(srf.added, [], 'nothing registered');
  t.end();
});

test('unregisterFsServiceUrl removes us and stops the refresh (so a drain stays drained)', async(t) => {
  const srf = makeSrf('http://10.128.70.3:3000');
  registerFsServiceUrl(srf, logger, {clusterId: 'default', refreshMs: 20});
  const afterRegister = srf.added.length;

  await unregisterFsServiceUrl(srf, logger, {clusterId: 'default'});
  t.deepEqual(srf.removed, ['default:fs-service-url|http://10.128.70.3:3000'], 'removed from the set');

  await new Promise((resolve) => setTimeout(resolve, 80));
  t.equal(srf.added.length, afterRegister,
    'refresh timer stopped, we were not re-added while draining');
  t.end();
});

test('unregisterFsServiceUrl resolves only once redis has acknowledged the removal', async(t) => {
  /* the signal handler calls process.exit(0) the moment this returns; a
     fire-and-forget SREM loses that race and api-server keeps dispatching REST
     calls to a dead feature server */
  const srf = makeSrf('http://10.128.70.3:3000', 60);
  registerFsServiceUrl(srf, logger, {clusterId: 'default', refreshMs: 10000});
  await new Promise((resolve) => setTimeout(resolve, 80));
  t.deepEqual([...srf.members], ['http://10.128.70.3:3000'], 'we are in the set to begin with');

  const p = unregisterFsServiceUrl(srf, logger, {clusterId: 'default'});
  t.ok(p && typeof p.then === 'function', 'unregisterFsServiceUrl returns a promise to wait on');
  t.deepEqual([...srf.members], ['http://10.128.70.3:3000'], 'redis has not acknowledged yet');

  await p;
  t.deepEqual([...srf.members], [], 'awaiting it guarantees the removal landed');
  t.end();
});

test('unregisterFsServiceUrl removes nothing when we never registered', async(t) => {
  /* under kubernetes we skip registration entirely; teardown must not SREM a
     url we never advertised. This is why it keys off what we recorded rather
     than off srf.locals.serviceUrl, which is set regardless. */
  const srf = makeSrf('http://10.128.70.3:3000');

  await unregisterFsServiceUrl(srf, logger, {clusterId: 'default'});
  t.deepEqual(srf.removed, [], 'no spurious removal');
  t.end();
});

test('a re-bind on a different port drops the url we advertised before', async(t) => {
  /* http-listener.js walks the port forward on EADDRINUSE up to HTTP_PORT_MAX,
     so this is a real path, not a hypothetical. Set members carry no TTL: a url
     left behind here stays selectable for ever and api-server round-robins REST
     dials into a dead port. */
  const srf = makeSrf('http://10.128.70.3:3000');
  registerFsServiceUrl(srf, logger, {clusterId: 'default', refreshMs: 10000});
  await new Promise((resolve) => setTimeout(resolve, 20));

  srf.locals.serviceUrl = 'http://10.128.70.3:3001';
  registerFsServiceUrl(srf, logger, {clusterId: 'default', refreshMs: 10000});
  await new Promise((resolve) => setTimeout(resolve, 40));

  t.deepEqual([...srf.members], ['http://10.128.70.3:3001'], 'only the current url is in the set');
  t.deepEqual(srf.removed, ['default:fs-service-url|http://10.128.70.3:3000'],
    'the previous url was removed');

  clearInterval(srf.locals.fsServiceUrlRefreshTimer);
  t.end();
});

test('active-fs and fs-service-url registrations do not share timer state', async(t) => {
  /* they run on the same srf.locals and are started from different callbacks
     (srf.on('connect') vs the http listener); a shared key would have one
     silently cancel the other's refresh */
  const {registerActiveFs, unregisterActiveFs} = require('../lib/utils/active-fs-registration');
  const srf = makeSrf('http://10.128.70.3:3000');
  srf.locals.localSipAddress = '127.0.0.1:5070';

  registerActiveFs(srf, logger, {clusterId: 'default', refreshMs: 10000});
  registerFsServiceUrl(srf, logger, {clusterId: 'default', refreshMs: 10000});
  await new Promise((resolve) => setTimeout(resolve, 20));
  t.deepEqual([...srf.members].sort(), ['127.0.0.1:5070', 'http://10.128.70.3:3000'],
    'both advertisements are live at once');

  await unregisterActiveFs(srf, logger, {clusterId: 'default'});
  t.deepEqual([...srf.members], ['http://10.128.70.3:3000'],
    'deregistering active-fs leaves the service url advertised');
  t.ok(srf.locals.fsServiceUrlRefreshTimer, 'the service-url refresh timer is still running');

  await unregisterFsServiceUrl(srf, logger, {clusterId: 'default'});
  t.deepEqual([...srf.members], [], 'both gone');
  t.end();
});
