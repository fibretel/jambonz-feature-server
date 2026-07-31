const test = require('tape');
const TaskLlmOpenAI_S2S = require('../lib/tasks/llm/llms/openai_s2s');

const noop = () => {};
const logger = {error: noop, info: noop, debug: noop, warn: noop};

/**
 * Build a task with a stubbed _api so we can observe exactly which client events
 * are sent to the freeswitch module, and in what order.
 */
const makeTask = (llmOptions, {ackSessionUpdate = true, failSend = false, mcpTools = null} = {}) => {
  const sent = [];
  const parentTask = {
    vendor: 'openai',
    auth: {apiKey: 'sk-test'},
    connectOptions: {},
    isMcpEnabled: !!mcpTools,
    mcpService: {getAvailableMcpTools: () => (typeof mcpTools === 'function' ? mcpTools() : Promise.resolve([]))},
    sendEventHook: () => Promise.resolve(),
    addCustomEventListener: noop,
    removeCustomEventListeners: noop
  };
  const task = new TaskLlmOpenAI_S2S(logger, {llmOptions}, parentTask);
  const ep = {uuid: 'test-uuid'};

  task._api = (_ep, args) => {
    /* kill() sends a bare session.delete verb rather than a client.event payload */
    if (args[2] === undefined) {
      sent.push({type: args[1], at: Date.now(), obj: null});
      return Promise.resolve();
    }
    const obj = JSON.parse(args[2]);
    sent.push({type: obj.type, at: Date.now(), obj});
    if (failSend) return Promise.reject(new Error('send failed'));
    if (obj.type === 'session.update' && ackSessionUpdate) {
      /* server acks asynchronously, as it does on the wire */
      setImmediate(() => task._onServerEvent(ep, {type: 'session.updated', session: {}}));
    }
    return Promise.resolve();
  };

  /* count completions WITHOUT replacing the method: the class overrides
     notifyTaskDone to stand down a pending initializer, and stubbing it out
     would hide exactly the behaviour these tests are here to pin */
  let taskDone = 0;
  const notifyTaskDone = task.notifyTaskDone.bind(task);
  task.notifyTaskDone = () => {
    taskDone++;
    notifyTaskDone();
  };

  return {task, ep, sent, getTaskDone: () => taskDone};
};

const types = (sent) => sent.map((s) => s.type);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const response_create = {instructions: 'say hello'};
const session_update = {instructions: 'You are FibreTel\'s assistant. Always respond in English.'};

test('openai s2s: session.update is sent before response.create', async(t) => {
  const {task, ep, sent} = makeTask({response_create, session_update});

  await task._sendInitialMessage(ep);

  t.deepEqual(sent.map((s) => s.type), ['session.update', 'response.create'],
    'session.update precedes response.create');
  t.deepEqual(sent[0].obj.session, session_update, 'session.update carries the supplied session');
  t.deepEqual(sent[1].obj.response, response_create, 'response.create carries the supplied response');
  t.end();
});

test('openai s2s: response.create waits for the session.updated ack', async(t) => {
  const sent = [];
  const parentTask = {
    vendor: 'openai',
    auth: {apiKey: 'sk-test'},
    connectOptions: {},
    isMcpEnabled: false,
    sendEventHook: () => Promise.resolve(),
    addCustomEventListener: noop,
    removeCustomEventListeners: noop
  };
  const task = new TaskLlmOpenAI_S2S(logger, {llmOptions: {response_create, session_update}}, parentTask);
  const ep = {uuid: 'test-uuid'};
  let ackSent = false;

  task.notifyTaskDone = noop;
  task._api = (_ep, args) => {
    const obj = JSON.parse(args[2]);
    sent.push(obj.type);
    if (obj.type === 'response.create') {
      t.ok(ackSent, 'response.create was not sent until session.updated arrived');
    }
    if (obj.type === 'session.update') {
      /* hold the ack back for a while, then send it */
      setTimeout(() => {
        ackSent = true;
        task._onServerEvent(ep, {type: 'session.updated', session: {}});
      }, 250);
    }
    return Promise.resolve();
  };

  await task._sendInitialMessage(ep);
  t.deepEqual(sent, ['session.update', 'response.create'], 'both events sent, in order');
  t.end();
});

test('openai s2s: a missing session.updated ack does not hang the call', async(t) => {
  const {task, ep, sent} = makeTask({response_create, session_update}, {ackSessionUpdate: false});

  /* shorten the ack timeout so the test does not depend on wall clock over the real 2s bound */
  const awaitSessionUpdated = task._awaitSessionUpdated.bind(task);
  task._awaitSessionUpdated = () => awaitSessionUpdated(120);

  const start = Date.now();
  await task._sendInitialMessage(ep);
  const elapsed = Date.now() - start;

  t.deepEqual(sent.map((s) => s.type), ['session.update', 'response.create'],
    'response.create is still sent after the timeout fires');
  t.ok(elapsed >= 100, `waited for the ack before giving up (${elapsed}ms)`);
  t.end();
});

test('openai s2s: the default ack timeout is bounded and eventually sends response.create', async(t) => {
  const {task, ep, sent} = makeTask({response_create, session_update}, {ackSessionUpdate: false});

  const start = Date.now();
  await task._sendInitialMessage(ep);
  const elapsed = Date.now() - start;

  t.deepEqual(sent.map((s) => s.type), ['session.update', 'response.create'],
    'response.create is still sent on the default (2s) timeout path');
  t.ok(elapsed < 5000, `bounded wait, did not hang (${elapsed}ms)`);
  t.end();
});

test('openai s2s: behaviour is unchanged when no session_update is supplied', async(t) => {
  const {task, ep, sent} = makeTask({response_create});

  const start = Date.now();
  await task._sendInitialMessage(ep);
  const elapsed = Date.now() - start;

  t.deepEqual(sent.map((s) => s.type), ['response.create'], 'only response.create is sent');
  t.ok(elapsed < 1000, `sent immediately, no ack wait (${elapsed}ms)`);
  t.end();
});

test('openai s2s: a failed session.update does not go on to send response.create', async(t) => {
  const {task, ep, sent, getTaskDone} = makeTask({response_create, session_update}, {failSend: true});

  await task._sendInitialMessage(ep);

  t.deepEqual(sent.map((s) => s.type), ['session.update'], 'response.create suppressed after send failure');
  t.equal(getTaskDone(), 1, 'task was notified done');
  t.end();
});

/**
 * Everything below is about the ack window opened by holding response.create until
 * session.updated arrives. Anything that ends the session while we are in that
 * window must stop the initializer, not merely release it: releasing it alone let
 * it carry on and create a response on a session that was already gone.
 */

test('openai s2s: a kill during the ack window does not create a response', async(t) => {
  const {task, ep, sent} = makeTask({response_create, session_update}, {ackSessionUpdate: false});
  const awaitSessionUpdated = task._awaitSessionUpdated.bind(task);
  task._awaitSessionUpdated = () => awaitSessionUpdated(2000);

  const p = task._sendInitialMessage(ep);
  await sleep(30);
  /* caller hangs up mid-window: kill() deletes the session */
  task.kill({ep});
  await p;
  await sleep(30);

  t.deepEqual(types(sent), ['session.update', 'session.delete'],
    'no response.create after the session was deleted');
  t.ok(task.killed, 'task is killed');
  t.end();
});

test('openai s2s: a server error during the ack window does not create a response', async(t) => {
  const {task, ep, sent, getTaskDone} = makeTask({response_create, session_update}, {ackSessionUpdate: false});
  const awaitSessionUpdated = task._awaitSessionUpdated.bind(task);
  task._awaitSessionUpdated = () => awaitSessionUpdated(150);

  const p = task._sendInitialMessage(ep);
  await sleep(30);
  await task._onServerEvent(ep, {type: 'error', error: {message: 'rate limit exceeded'}});
  await p;
  await sleep(200);

  t.deepEqual(types(sent), ['session.update'], 'the ack timeout cannot resurrect a completed task');
  t.equal(getTaskDone(), 1, 'task completed once');
  t.end();
});

test('openai s2s: a disconnect during the ack window does not create a response', async(t) => {
  const {task, ep, sent, getTaskDone} = makeTask({response_create, session_update}, {ackSessionUpdate: false});
  const awaitSessionUpdated = task._awaitSessionUpdated.bind(task);
  task._awaitSessionUpdated = () => awaitSessionUpdated(150);

  const p = task._sendInitialMessage(ep);
  await sleep(30);
  task._onDisconnect(ep, {});
  await p;
  await sleep(200);

  t.deepEqual(types(sent), ['session.update'], 'no response.create after the ws went away');
  t.equal(getTaskDone(), 1, 'task completed once');
  t.end();
});

test('openai s2s: a repeated connect primes the session only once', async(t) => {
  const {task, ep, sent} = makeTask({response_create, session_update}, {ackSessionUpdate: false});
  const awaitSessionUpdated = task._awaitSessionUpdated.bind(task);
  task._awaitSessionUpdated = () => awaitSessionUpdated(150);

  task._onConnect(ep);
  task._onConnect(ep);
  await sleep(20);
  await task._onServerEvent(ep, {type: 'session.updated', session: {}});
  await sleep(300);

  t.deepEqual(types(sent), ['session.update', 'response.create'],
    'one session.update and one response.create, not two of each');
  t.end();
});

test('openai s2s: mcp discovery failure does not strand the call', async(t) => {
  const {task, ep, sent} = makeTask({response_create, session_update},
    {mcpTools: () => Promise.reject(new Error('MCP unavailable'))});

  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);
  process.on('unhandledRejection', onRejection);

  task._onConnect(ep);
  await sleep(200);
  process.removeListener('unhandledRejection', onRejection);

  t.deepEqual(rejections, [], 'no unhandled rejection');
  t.deepEqual(types(sent), ['session.update', 'response.create'],
    'the caller still gets a greeting, just without the mcp tools');
  t.end();
});
