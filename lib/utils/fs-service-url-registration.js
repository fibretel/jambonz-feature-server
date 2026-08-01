/**
 * Self-registration of this feature server's HTTP service URL into the redis set
 * that api-server consults when it needs a feature server for an API-originated
 * request.
 *
 * Same defect shape as active-fs-registration.js, same upstream blind spot:
 * app.js has always had the removeFromSet() on SIGTERM/SIGINT, but nothing ever
 * wrote the set. The teardown half of a lifecycle was implemented and the setup
 * half was not, so the set is permanently empty outside kubernetes.
 *
 * What that breaks (api-server, verified against 0.9.8 on the island):
 *   - POST /v1/Accounts/:sid/Calls  (accounts.js getFsUrl -> retrieveSet)
 *     -> 480 {"msg":"no available feature servers at this time"}
 *   - POST /v1/Accounts/:sid/Messages (outbound SMS) -> same 480
 *   - inbound SMS dispatch (sms-inbound.js) -> no feature server selected
 * i.e. ALL REST-originated dial and ALL messaging, permanently, on any non-k8s
 * deployment. Reproduced before the fix: `scard default:fs-service-url` = 0
 * while `default:active-fs` had a member, and the REST dial above returned 480.
 *
 * MEMBER FORMAT: the bare serviceUrl (`http://<ip>:<port>`). api-server appends
 * the path itself (`${f}/v1/createCall`, `${f}/v1/messaging/${provider}`), so a
 * member with a path baked in would produce a double-pathed URL. This matches
 * what app.js already removes on shutdown, which is the only evidence upstream
 * left of the intended format.
 *
 * WHY REGISTRATION HANGS OFF THE HTTP LISTENER, not srf.on('connect') like
 * active-fs: srf.locals.serviceUrl is only TRUSTWORTHY after the express server
 * has bound. install-srf-locals.js seeds it optimistically from config
 * (`http://${localIp}:${PORT}`) before anything has listened, and then
 * http-listener.js OVERWRITES it in the listen callback with the port actually
 * bound -- which is not necessarily PORT, because that listener walks the port
 * forward on EADDRINUSE up to HTTP_PORT_MAX. Registering from srf.on('connect')
 * would therefore read the seeded guess and could advertise a port nothing is
 * listening on; the bound value can also legitimately differ between restarts,
 * which is why the changed-address handling below is not theoretical here.
 *
 * Corollary, and the reason unregister keys off what we recorded rather than off
 * srf.locals.serviceUrl: that field is non-null even when registration never
 * happened, so recomputing it at teardown can SREM a url we never advertised.
 *
 * Not under kubernetes: api-server's getFsUrl() short-circuits to
 * K8S_FEATURE_SERVER_SERVICE_NAME and never reads the set, so a member written
 * there would be a stray key nobody removes -- the same reasoning, and the same
 * K8S guard, as active-fs registration.
 */

/* same cadence as active-fs registration and sbc-pinger's own key refresh */
const REFRESH_INTERVAL_MS = 30000;

const fsServiceUrlSetName = (clusterId) => `${clusterId || 'default'}:fs-service-url`;

const clearRefreshTimer = (srf) => {
  if (srf.locals.fsServiceUrlRefreshTimer) {
    clearInterval(srf.locals.fsServiceUrlRefreshTimer);
    srf.locals.fsServiceUrlRefreshTimer = null;
  }
};

const removeMember = async(srf, logger, setName, member) => {
  const {removeFromSet} = srf.locals.dbHelpers || {};
  if (!removeFromSet || !member) return;

  logger.info(`removing ${member} from set ${setName}`);
  try {
    await removeFromSet(setName, member);
  } catch (err) {
    logger.info({err}, `Error removing ${member} from set ${setName}`);
  }
};

/**
 * Add this feature server's HTTP service URL to the fs-service-url set and keep
 * it there.
 *
 * @param {Srf} srf - the srf instance; call this only after the HTTP listener has
 *   bound, so srf.locals.serviceUrl carries the port actually in use
 * @param {object} logger
 * @param {object} opts
 * @param {string} opts.clusterId - JAMBONES_CLUSTER_ID
 * @param {number} [opts.refreshMs] - refresh cadence, for tests
 * @returns {Timeout|null} the refresh timer, or null if we could not register
 */
function registerFsServiceUrl(srf, logger, {clusterId, refreshMs = REFRESH_INTERVAL_MS} = {}) {
  const {addToSet} = srf.locals.dbHelpers || {};
  const setName = fsServiceUrlSetName(clusterId);
  const serviceUrl = srf.locals.serviceUrl;

  if (!addToSet) {
    logger.error(`registerFsServiceUrl: dbHelpers not installed, cannot register in ${setName}`);
    return null;
  }
  if (!serviceUrl) {
    logger.error(`registerFsServiceUrl: no service url known, cannot register in ${setName}`);
    return null;
  }

  const add = () => {
    try {
      addToSet(setName, serviceUrl)
        .catch((err) => logger.info({err}, `Error adding ${serviceUrl} to set ${setName}`));
    } catch (err) {
      logger.info({err}, `Error adding ${serviceUrl} to set ${setName}`);
    }
  };

  /* a freeswitch reconnect re-runs createHttpListener; never leave the previous
     timer running */
  const previous = srf.locals.fsServiceUrlRegistered;
  clearRefreshTimer(srf);

  logger.info(`registering ${serviceUrl} in set ${setName}`);
  srf.locals.fsServiceUrlRegistered = serviceUrl;
  if (previous && previous !== serviceUrl) {
    /* the listener bound a different port this time (EADDRINUSE walk-forward).
       The set has no TTL, so the URL we advertised before would otherwise stay
       selectable for ever and api-server would round-robin REST dials into a
       dead port; drop it before the new one goes live. */
    removeMember(srf, logger, setName, previous)
      .then(add)
      .catch((err) => logger.info({err}, `Error replacing ${previous} with ${serviceUrl} in set ${setName}`));
  }
  else add();
  const timer = setInterval(add, refreshMs);
  srf.locals.fsServiceUrlRefreshTimer = timer;
  return timer;
}

/**
 * Stop refreshing and (by default) remove ourselves from the fs-service-url set.
 *
 * Clearing the timer is not optional: on SIGTERM the process lingers until
 * in-progress calls end, and a still-running refresh would put us straight back
 * into the set api-server dispatches NEW REST calls from, defeating the drain.
 *
 * Awaiting the returned promise is not optional either on the shutdown path: the
 * SREM is a network round trip to redis, and process.exit() will happily beat it.
 *
 * @param {Srf} srf
 * @param {object} logger
 * @param {object} opts
 * @param {string} opts.clusterId - JAMBONES_CLUSTER_ID
 * @param {boolean} [opts.remove] - also SREM ourselves (default true)
 * @returns {Promise<void>} resolves once redis has acknowledged the removal
 */
async function unregisterFsServiceUrl(srf, logger, {clusterId, remove = true} = {}) {
  clearRefreshTimer(srf);
  if (!remove) return;

  /* only ever remove what we actually registered, so this is a no-op when
     registration was skipped (e.g. under kubernetes) */
  const member = srf.locals.fsServiceUrlRegistered;
  srf.locals.fsServiceUrlRegistered = null;
  await removeMember(srf, logger, fsServiceUrlSetName(clusterId), member);
}

module.exports = {
  fsServiceUrlSetName,
  registerFsServiceUrl,
  unregisterFsServiceUrl,
  REFRESH_INTERVAL_MS
};
