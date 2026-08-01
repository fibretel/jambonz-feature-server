const test = require('tape');
const path = require('path');
const {spawn} = require('child_process');
const {redactFsInventory, REDACTED} = require('../lib/utils/redact');

const SECRET = 'OCvXGlEbuEAQEN358wU7P13VTSk51sfF1F2K596G';

test('redactFsInventory removes the ESL secret and keeps everything else', (t) => {
  const inventory = [{address: '127.0.0.1', port: '8021', secret: SECRET, advertisedAddress: 'docker-host'}];
  const redacted = redactFsInventory(inventory);

  t.equal(redacted[0].secret, REDACTED, 'the secret is gone');
  t.equal(redacted[0].address, '127.0.0.1', 'address kept');
  t.equal(redacted[0].port, '8021', 'port kept');
  t.equal(redacted[0].advertisedAddress, 'docker-host', 'advertisedAddress kept');
  t.notEqual(JSON.stringify(redacted).indexOf(SECRET), 0, 'sanity');
  t.equal(JSON.stringify(redacted).includes(SECRET), false, 'the secret appears nowhere in the serialized form');
  t.end();
});

test('redactFsInventory does not mutate the inventory the app actually connects with', (t) => {
  /* the same array is iterated straight after the log line to build the mrf
     connections; redacting in place would break every ESL connection */
  const inventory = [{address: '127.0.0.1', port: '8021', secret: SECRET}];
  redactFsInventory(inventory);

  t.equal(inventory[0].secret, SECRET, 'the original entry still carries the real secret');
  t.end();
});

test('redactFsInventory distinguishes a missing secret from a redacted one', (t) => {
  /* a misconfigured entry is exactly what this log line gets read to diagnose */
  const redacted = redactFsInventory([{address: '127.0.0.1', port: '8021', secret: ''}]);

  t.equal(redacted[0].secret, '', 'an empty secret stays visibly empty, not "[redacted]"');
  t.end();
});

test('redactFsInventory handles multiple media servers and odd input', (t) => {
  const redacted = redactFsInventory([
    {address: '10.0.0.1', port: '8021', secret: 'aaa'},
    {address: '10.0.0.2', port: '8021', secret: 'bbb'}
  ]);
  t.deepEqual(redacted.map((e) => e.secret), [REDACTED, REDACTED], 'every entry redacted');
  t.equal(redactFsInventory(undefined), undefined, 'non-array passes through');
  t.deepEqual(redactFsInventory([null]), [null], 'null entry passes through');
  t.deepEqual(redactFsInventory([{address: 'x'}]), [{address: 'x'}], 'entry with no secret passes through');
  t.end();
});

/**
 * End-to-end on the real log line: install-srf-locals.js logs the freeswitch
 * inventory on every boot, and before this change that line carried the event
 * socket password in cleartext into the container logs (and from there into
 * whatever ships them). Asserting on the helper alone would not catch someone
 * logging the raw object again, so this drives the real module.
 */
test('the startup "freeswitch inventory" log line never contains the ESL secret', async(t) => {
  const {out, code} = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'fixtures', 'fs-inventory-log-child.js')], {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        JAMBONES_FREESWITCH: `127.0.0.1:8021:${SECRET}:docker-host`
      }
    });
    let out = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('inventory fixture did not exit'));
    }, 10000);
    child.stdout.on('data', (d) => out += d.toString());
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({out, code});
    });
  });

  t.equal(code, 0, 'fixture exited cleanly');
  t.ok(out.includes('freeswitch inventory'), 'the inventory line was logged (the fixture reached it)');
  t.equal(out.includes(SECRET), false, 'the ESL secret does not appear in the startup log');
  t.ok(out.includes(REDACTED), 'it was redacted rather than dropped');
  t.end();
});
