/**
 * Redaction helpers for things that must never reach the logs.
 *
 * JAMBONES_FREESWITCH is `address:port:secret[:advertisedAddress]`, and that
 * secret is the freeswitch event-socket password -- a root-equivalent control
 * channel (originate calls, run arbitrary API commands, read every channel
 * variable). install-srf-locals.js logged the parsed inventory verbatim at
 * startup, so every feature-server boot wrote the ESL password in cleartext into
 * the container logs and from there into whatever ships them:
 *
 *   {"msg":"freeswitch inventory","fsInventory":[
 *     {"address":"127.0.0.1","port":"8021","secret":"<the actual password>"}]}
 *
 * Log lines outlive the credential rotation that is supposed to contain them, so
 * the value never goes in at all. The KEY is kept (operators need to see that a
 * secret is configured, and which entry lacks one).
 */

const REDACTED = '[redacted]';

/**
 * Copy of a freeswitch inventory with every secret replaced.
 *
 * Absent/empty secrets are reported as such rather than as '[redacted]' -- a
 * misconfigured entry is exactly the thing this log line is read to diagnose.
 *
 * @param {Array<object>} inventory - parsed JAMBONES_FREESWITCH entries
 * @returns {Array<object>} the same entries, safe to log
 */
const redactFsInventory = (inventory) => {
  if (!Array.isArray(inventory)) return inventory;
  return inventory.map((entry) => {
    if (!entry || typeof entry !== 'object' || !('secret' in entry)) return entry;
    return {...entry, secret: entry.secret ? REDACTED : entry.secret};
  });
};

module.exports = {redactFsInventory, REDACTED};
