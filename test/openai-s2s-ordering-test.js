const test = require('tape');
const TaskLlmOpenAI_S2S = require('../lib/tasks/llm/llms/openai_s2s');

const noop = () => {};
const logger = {error: noop, info: noop, debug: noop, warn: noop};

/**
 * Build a task with a stubbed _api so we can observe exactly which client events
 * are sent to the freeswitch module, and in what order.
 */
const makeTask = (llmOptions, {ackSessionUpdate = true, failSend = false} = {}) => {
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
  const task = new TaskLlmOpenAI_S2S(logger, {llmOptions}, parentTask);
  const ep = {uuid: 'test-uuid'};

  task._api = (_ep, args) => {
    const obj = JSON.parse(args[2]);
    sent.push({type: obj.type, at: Date.now(), obj});
    if (failSend) return Promise.reject(new Error('send failed'));
    if (obj.type === 'session.update' && ackSessionUpdate) {
      /* server acks asynchronously, as it does on the wire */
      setImmediate(() => task._onServerEvent(ep, {type: 'session.updated', session: {}}));
    }
    return Promise.resolve();
  };

  let taskDone = 0;
  task.notifyTaskDone = () => taskDone++;

  return {task, ep, sent, getTaskDone: () => taskDone};
};

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
