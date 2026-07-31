/**
 * Self-registration of this feature server into the redis set that sbc-inbound
 * consults when it needs to select a feature server for an inbound call.
 *
 * sbc-inbound (lib/fs-tracking.js) reads `${JAMBONES_CLUSTER_ID}:active-fs` and
 * rejects the call with a 480 when the set is empty -- that set is the only
 * feature-server discovery mechanism it has outside of kubernetes. Nothing in
 * the feature server ever wrote to it: app.js has always had the symmetric
 * removeFromSet() on SIGTERM/SIGINT, but no addToSet() on startup.
 *
 * The shape here deliberately mirrors sbc-inbound's own self-registration
 * (sbc-inbound/app.js, srf.on('connect') -> addToSet(`...:active-sip`, hostport)):
 * register on a successful drachtio connect, using the address drachtio itself
 * advertises, and re-assert it periodically so a redis restart or flush
 * self-heals -- the same reason sbc-pinger.js re-inserts its fsUUID key every
 * 30s. Members are plain set members with no per-member TTL, so the refresh is
 * about recovering lost state, not about keeping a lease alive.
 */

/* same cadence sbc-pinger.js uses to re-assert its own redis key */
const REFRESH_INTERVAL_MS = 30000;

const activeFsSetName = (clusterId) => `${clusterId || 'default'}:active-fs`;

/**
 * Add this feature server's SIP address to the active-fs set and keep it there.
 *
 * @param {Srf} srf - the srf instance; srf.locals.localSipAddress must be set
 * @param {object} logger
 * @param {object} opts
 * @param {string} opts.clusterId - JAMBONES_CLUSTER_ID
 * @param {number} [opts.refreshMs] - refresh cadence, for tests
 * @returns {Timeout|null} the refresh timer, or null if we could not register
 */
function registerActiveFs(srf, logger, {clusterId, refreshMs = REFRESH_INTERVAL_MS} = {}) {
  const {addToSet} = srf.locals.dbHelpers || {};
  const setName = activeFsSetName(clusterId);
  const hostport = srf.locals.localSipAddress;

  if (!addToSet) {
    logger.error(`registerActiveFs: dbHelpers not installed, cannot register in ${setName}`);
    return null;
  }
  if (!hostport) {
    logger.error(`registerActiveFs: no local sip address known, cannot register in ${setName}`);
    return null;
  }

  const add = () => {
    try {
      addToSet(setName, hostport)
        .catch((err) => logger.info({err}, `Error adding ${hostport} to set ${setName}`));
    } catch (err) {
      logger.info({err}, `Error adding ${hostport} to set ${setName}`);
    }
  };

  /* a drachtio reconnect re-runs this; never leave the previous timer running */
  unregisterActiveFs(srf, logger, {clusterId, remove: false});

  logger.info(`registering ${hostport} in set ${setName}`);
  add();
  const timer = setInterval(add, refreshMs);
  srf.locals.activeFsRefreshTimer = timer;
  return timer;
}

/**
 * Stop refreshing and (by default) remove ourselves from the active-fs set.
 *
 * Clearing the timer is not optional: on SIGTERM the process lingers until
 * in-progress calls end, and a still-running refresh would put us straight back
 * into the set that sbc-inbound routes NEW calls from, defeating the drain.
 *
 * @param {Srf} srf
 * @param {object} logger
 * @param {object} opts
 * @param {string} opts.clusterId - JAMBONES_CLUSTER_ID
 * @param {boolean} [opts.remove] - also SREM ourselves (default true)
 */
function unregisterActiveFs(srf, logger, {clusterId, remove = true} = {}) {
  if (srf.locals.activeFsRefreshTimer) {
    clearInterval(srf.locals.activeFsRefreshTimer);
    srf.locals.activeFsRefreshTimer = null;
  }
  if (!remove) return;

  const {removeFromSet} = srf.locals.dbHelpers || {};
  const setName = activeFsSetName(clusterId);
  const hostport = srf.locals.localSipAddress;
  if (!removeFromSet || !hostport) return;

  logger.info(`removing ${hostport} from set ${setName}`);
  try {
    removeFromSet(setName, hostport)
      .catch((err) => logger.info({err}, `Error removing ${hostport} from set ${setName}`));
  } catch (err) {
    logger.info({err}, `Error removing ${hostport} from set ${setName}`);
  }
}

module.exports = {
  activeFsSetName,
  registerActiveFs,
  unregisterActiveFs,
  REFRESH_INTERVAL_MS
};
