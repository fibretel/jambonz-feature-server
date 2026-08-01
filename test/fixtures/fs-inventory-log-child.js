/**
 * Fixture for the redaction end-to-end assertion in test/redact-test.js.
 *
 * Drives the REAL installSrfLocals() far enough to emit its startup
 * "freeswitch inventory" log line, capturing what the logger was handed. That
 * line used to carry the freeswitch event-socket password in cleartext on every
 * boot; asserting on the redact helper alone would not notice someone logging
 * the raw inventory object again, so this exercises the actual call site.
 *
 * The inventory is parsed and logged SYNCHRONOUSLY, in the async IIFE's body
 * before its first await, so the line exists by the time installSrfLocals()
 * returns -- which is why this prints and exits immediately instead of waiting.
 * It has to: installSrfLocals also builds the mysql pool, and with no database
 * behind it (this is the unit tier) that pool raises an uncaught error a moment
 * later and would take the process down before any deferred assertion ran.
 *
 * Nothing here connects on purpose. sbc-pinger lazily require()s the package
 * root on a 1s timer, which would boot the whole feature server -- so, as in
 * drain-child.js, the module cache is seeded with a stub. NODE_ENV=test also
 * short-circuits its OPTIONS pings.
 */
process.env.NODE_ENV = 'test';
process.env.JAMBONES_SBCS = process.env.JAMBONES_SBCS || '127.0.0.1:5060';
delete process.env.K8S;
delete process.env.AWS_SNS_TOPIC_ARN;

const Module = require('module');

const lines = [];
const capture = (obj, msg) => {
  /* pino's shape: logger.info({fields}, 'message') */
  lines.push(typeof obj === 'string' ? obj : `${JSON.stringify(obj)} ${msg || ''}`);
};
const logger = {info: capture, error: capture, warn: capture, debug: capture};

const rootPath = require.resolve('../..');
const stub = new Module(rootPath, null);
stub.filename = rootPath;
stub.loaded = true;
stub.exports = {srf: {locals: {}}, logger};
require.cache[rootPath] = stub;

const srf = {locals: {otel: {tracer: {}}}};

const installSrfLocals = require('../../lib/utils/install-srf-locals');
installSrfLocals(srf, logger, {});

process.stdout.write(lines.join('\n') + '\n');
process.exit(0);
