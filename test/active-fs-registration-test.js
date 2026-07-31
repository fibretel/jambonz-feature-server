const test = require('tape');
const {
  activeFsSetName,
  registerActiveFs,
  unregisterActiveFs
} = require('../lib/utils/active-fs-registration');

const noop = () => {};
const logger = {error: noop, info: noop, debug: noop, warn: noop};

const makeSrf = (localSipAddress) => {
  const added = [];
  const removed = [];
  return {
    added,
    removed,
    locals: {
      localSipAddress,
      dbHelpers: {
        addToSet: (setName, member) => {
          added.push(`${setName}|${member}`);
          return Promise.resolve(1);
        },
        removeFromSet: (setName, member) => {
          removed.push(`${setName}|${member}`);
          return Promise.resolve(1);
        }
      }
    }
  };
};

test('active-fs set name matches what sbc-inbound reads', (t) => {
  t.equal(activeFsSetName('default'), 'default:active-fs', 'default cluster');
  t.equal(activeFsSetName('mycluster'), 'mycluster:active-fs', 'named cluster');
  t.equal(activeFsSetName(undefined), 'default:active-fs', 'unset JAMBONES_CLUSTER_ID defaults');
  t.end();
});

test('registerActiveFs adds our sip address immediately', (t) => {
  const srf = makeSrf('127.0.0.1:5070');
  const timer = registerActiveFs(srf, logger, {clusterId: 'default', refreshMs: 60000});

  t.deepEqual(srf.added, ['default:active-fs|127.0.0.1:5070'], 'registered on connect');
  clearInterval(timer);
  t.end();
});

test('registerActiveFs re-asserts membership on the refresh cadence', (t) => {
  const srf = makeSrf('127.0.0.1:5070');
  const timer = registerActiveFs(srf, logger, {clusterId: 'default', refreshMs: 25});

  setTimeout(() => {
    clearInterval(timer);
    t.ok(srf.added.length >= 3, `re-registered across refresh cycles (${srf.added.length} writes)`);
    t.ok(srf.added.every((v) => v === 'default:active-fs|127.0.0.1:5070'), 'always the same member');
    t.end();
  }, 250);
});

test('registerActiveFs does not stack timers when drachtio reconnects', (t) => {
  const srf = makeSrf('127.0.0.1:5070');
  registerActiveFs(srf, logger, {clusterId: 'default', refreshMs: 30});
  const timer = registerActiveFs(srf, logger, {clusterId: 'default', refreshMs: 30});

  const afterTwoRegisters = srf.added.length;
  t.equal(afterTwoRegisters, 2, 'two immediate registrations, one per connect');

  setTimeout(() => {
    clearInterval(timer);
    const refreshes = srf.added.length - afterTwoRegisters;
    t.ok(refreshes <= 4, `only one refresh timer is running (${refreshes} refreshes in ~100ms at 30ms)`);
    t.end();
  }, 100);
});

test('registerActiveFs is a no-op when we have no sip address yet', (t) => {
  const srf = makeSrf(undefined);
  const timer = registerActiveFs(srf, logger, {clusterId: 'default', refreshMs: 30});

  t.equal(timer, null, 'no timer created');
  t.deepEqual(srf.added, [], 'nothing registered');
  t.end();
});

test('unregisterActiveFs removes us and stops the refresh (so a drain stays drained)', (t) => {
  const srf = makeSrf('127.0.0.1:5070');
  registerActiveFs(srf, logger, {clusterId: 'default', refreshMs: 20});
  const afterRegister = srf.added.length;

  unregisterActiveFs(srf, logger, {clusterId: 'default'});
  t.deepEqual(srf.removed, ['default:active-fs|127.0.0.1:5070'], 'removed from the set');

  setTimeout(() => {
    t.equal(srf.added.length, afterRegister, 'refresh timer stopped, we were not re-added while draining');
    t.end();
  }, 80);
});
