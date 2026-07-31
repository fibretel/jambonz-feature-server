const test = require('tape');
const path = require('path');
const {spawn} = require('child_process');

/**
 * SIGUSR1 asks this feature server to dry up for scale-in. That has to give up
 * membership of `<cluster>:active-fs`: sbc-inbound selects a feature server from
 * that set and pays no attention to the X-FS-Status header on our OPTIONS ping,
 * so a "drain" that only pings keeps being handed new calls -- and the refresh
 * timer keeps re-asserting membership for as long as the process lives.
 */
test('SIGUSR1 scale-in deregisters us from the active-fs set', async(t) => {
  const {out, code} = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'fixtures', 'drain-child.js')]);
    let out = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('drain fixture did not exit'));
    }, 10000);
    child.stdout.on('data', (d) => out += d.toString());
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({out, code});
    });
  });

  t.equal(code, 0, 'fixture exited cleanly');
  t.ok(out.includes('members=0'), 'we left the active-fs set when we started drying up');
  t.ok(out.includes('timer=false'), 'the refresh timer stopped, so nothing re-adds us while draining');
  t.end();
});
