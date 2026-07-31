const Task = require('../../task');
const TaskName = 'Llm_OpenAI_s2s';
const {LlmEvents_OpenAI} = require('../../../utils/constants');
const ClientEvent = 'client.event';
const SessionDelete = 'session.delete';
/* how long to wait for the server's session.updated ack before giving up and
   sending response.create anyway -- a missing ack must not hang the call */
const {JAMBONES_S2S_SESSION_UPDATED_TIMEOUT_MS: SESSION_UPDATED_TIMEOUT_MS} = require('../../../config');

const openai_server_events = [
  'error',
  'session.created',
  'session.updated',
  'conversation.created',
  'input_audio_buffer.committed',
  'input_audio_buffer.cleared',
  'input_audio_buffer.speech_started',
  'input_audio_buffer.speech_stopped',
  'conversation.item.created',
  'conversation.item.input_audio_transcription.completed',
  'conversation.item.input_audio_transcription.failed',
  'conversation.item.truncated',
  'conversation.item.deleted',
  'response.created',
  'response.done',
  'response.output_item.added',
  'response.output_item.done',
  'response.content_part.added',
  'response.content_part.done',
  'response.text.delta',
  'response.text.done',
  'response.audio_transcript.delta',
  'response.audio_transcript.done',
  'response.audio.delta',
  'response.audio.done',
  'response.function_call_arguments.delta',
  'response.function_call_arguments.done',
  'rate_limits.updated',
  'output_audio.playback_started',
  'output_audio.playback_stopped',
];

const expandWildcards = (events) => {
  const expandedEvents = [];

  events.forEach((evt) => {
    if (evt.endsWith('.*')) {
      const prefix = evt.slice(0, -2); // Remove the wildcard ".*"
      const matchingEvents = openai_server_events.filter((e) => e.startsWith(prefix));
      expandedEvents.push(...matchingEvents);
    } else {
      expandedEvents.push(evt);
    }
  });

  return expandedEvents;
};

class TaskLlmOpenAI_S2S extends Task {
  constructor(logger, opts, parentTask) {
    super(logger, opts, parentTask);
    this.parent = parentTask;

    this.vendor = this.parent.vendor;
    this.model = this.parent.model || 'gpt-4o-realtime-preview-2024-12-17';
    this.auth = this.parent.auth;
    this.connectionOptions = this.parent.connectOptions;

    const {apiKey} = this.auth || {};
    if (!apiKey) throw new Error('auth.apiKey is required for OpenAI S2S');

    if (['openai', 'microsoft'].indexOf(this.vendor) === -1) {
      throw new Error(`Invalid vendor ${this.vendor} for OpenAI S2S`);
    }

    if ('microsoft' === this.vendor && !this.connectionOptions?.host) {
      throw new Error('connectionOptions.host is required for Microsoft OpenAI S2S');
    }

    this.apiKey = apiKey;
    this.authType = 'microsoft' === this.vendor ? 'query' : 'bearer';
    this.actionHook = this.data.actionHook;
    this.eventHook = this.data.eventHook;
    this.toolHook = this.data.toolHook;
    const {response_create, session_update} = this.data.llmOptions;

    if (typeof response_create !== 'object') {
      throw new Error('llmOptions with an initial response.create is required for OpenAI S2S');
    }

    this.response_create = response_create;
    this.session_update = session_update;

    this.results = {
      completionReason: 'normal conversation end'
    };

    /* session priming state: at most one initializer, and it stands down if the
       session ends while it is waiting for the session.updated ack */
    this._initialMessagePromise = null;
    this._initialMessageCancelled = false;

    /**
     * only one of these will have items,
     * if includeEvents, then these are the events to include
     * if excludeEvents, then these are the events to exclude
     */
    this.includeEvents = [];
    this.excludeEvents = [];

    /* default to all events if user did not specify */
    this._populateEvents(this.data.events || openai_server_events);

    this.addCustomEventListener = parentTask.addCustomEventListener.bind(parentTask);
    this.removeCustomEventListeners = parentTask.removeCustomEventListeners.bind(parentTask);
  }

  get name() { return TaskName; }

  get host() {
    const {host} = this.connectionOptions || {};
    return host || (this.vendor === 'openai' ? 'api.openai.com' : void 0);
  }

  get path() {
    const {path} = this.connectionOptions || {};
    if (path) return path;

    switch (this.vendor) {
      case 'openai':
        return `v1/realtime?model=${this.model}`;
      case 'microsoft':
        return `openai/realtime?api-version=2024-10-01-preview&deployment=${this.model}`;
    }
  }

  async _api(ep, args) {
    const res = await ep.api('uuid_openai_s2s', `^^|${args.join('|')}`);
    if (!res.body?.startsWith('+OK')) {
      throw new Error({args}, `Error calling uuid_openai_s2s: ${res.body}`);
    }
  }

  async exec(cs, {ep}) {
    await super.exec(cs);

    await this._startListening(cs, ep);

    await this.awaitTaskDone();

    /* note: the parent llm verb started the span, which is why this is necessary */
    await this.parent.performAction(this.results);

    this._unregisterHandlers();
  }

  async kill(cs) {
    super.kill(cs);

    /* don't leave _sendInitialMessage waiting on an ack that can no longer come,
       and make sure it does not go on to create a response on the session we are
       about to delete */
    this._cancelInitialMessage();

    this._api(cs.ep, [cs.ep.uuid, SessionDelete])
      .catch((err) => this.logger.info({err}, 'TaskLlmOpenAI_S2S:kill - error deleting session'));

    this.notifyTaskDone();
  }

  /**
   * Send function call output to the OpenAI server in the form of conversation.item.create
   * per https://platform.openai.com/docs/guides/realtime/function-calls
   */
  async processToolOutput(ep, tool_call_id, data) {
    try {
      this.logger.debug({tool_call_id, data}, 'TaskLlmOpenAI_S2S:processToolOutput');

      if (!data.type || data.type !== 'conversation.item.create') {
        this.logger.info({data},
          'TaskLlmOpenAI_S2S:processToolOutput - invalid tool output, must be conversation.item.create');
      }
      else {
        await this._api(ep, [ep.uuid, ClientEvent, JSON.stringify(data)]);

        // spec also recommends to send immediate response.create
        await this._api(ep, [ep.uuid, ClientEvent, JSON.stringify({type: 'response.create'})]);
      }
    } catch (err) {
      this.logger.info({err}, 'TaskLlmOpenAI_S2S:processToolOutput');
    }
  }

  /**
   * Send a session.update to the OpenAI server
   * Note: creating and deleting conversation items also supported as well as interrupting the assistant
   */
  async processLlmUpdate(ep, data, _callSid) {
    try {
      this.logger.debug({data, _callSid}, 'TaskLlmOpenAI_S2S:processLlmUpdate');

      if (!data.type || ![
        'session.update',
        'conversation.item.create',
        'conversation.item.delete',
        'response.cancel'
      ].includes(data.type)) {
        this.logger.info({data}, 'TaskLlmOpenAI_S2S:processLlmUpdate - invalid mid-call request');
      }
      else {
        await this._api(ep, [ep.uuid, ClientEvent, JSON.stringify(data)]);
      }
    } catch (err) {
      this.logger.info({err}, 'TaskLlmOpenAI_S2S:processLlmUpdate');
    }
  }

  async _startListening(cs, ep) {
    this._registerHandlers(ep);

    try {
      const args = [ep.uuid, 'session.create', this.host, this.path, this.authType, this.apiKey];
      await this._api(ep, args);
    } catch (err) {
      this.logger.error({err}, 'TaskLlmOpenAI_S2S:_startListening');
      this.notifyTaskDone();
    }
  }

  async _sendClientEvent(ep, obj) {
    let ok = true;
    this.logger.debug({obj}, 'TaskLlmOpenAI_S2S:_sendClientEvent');
    try {
      const args = [ep.uuid, ClientEvent, JSON.stringify(obj)];
      await this._api(ep, args);
    } catch (err) {
      ok = false;
      this.logger.error({err}, 'TaskLlmOpenAI_S2S:_sendClientEvent - Error');
    }
    return ok;
  }

  /**
   * Resolves when the server acknowledges our session.update with session.updated,
   * or when SESSION_UPDATED_TIMEOUT_MS elapses -- a missing ack must never wedge the call.
   * Arm this BEFORE sending session.update so the ack cannot be missed in the gap.
   */
  _awaitSessionUpdated(timeoutMs = SESSION_UPDATED_TIMEOUT_MS) {
    /* never leave an earlier wait's timer running: it would resolve a stale
       initializer that then sends a second response.create on this session */
    if (this._sessionUpdatedTimer) clearTimeout(this._sessionUpdatedTimer);
    return new Promise((resolve) => {
      this._sessionUpdatedTimer = setTimeout(() => {
        this._sessionUpdatedResolver = null;
        this._sessionUpdatedTimer = null;
        this.logger.info(
          // eslint-disable-next-line max-len
          `TaskLlmOpenAI_S2S: no session.updated after ${timeoutMs}ms, sending response.create without confirmation`);
        resolve(false);
      }, timeoutMs);
      this._sessionUpdatedResolver = () => {
        clearTimeout(this._sessionUpdatedTimer);
        this._sessionUpdatedTimer = null;
        this._sessionUpdatedResolver = null;
        resolve(true);
      };
    });
  }

  /**
   * Release a pending session.updated wait AND make sure the initializer does not
   * go on to send response.create.
   *
   * Resolving the ack promise on its own is not enough: the awaiting initializer
   * cannot tell "the server confirmed" from "this wait was cancelled", so it
   * carried on and created a response on a session that had already been deleted
   * (caller hung up during the ack window) or abandoned (server error, ws
   * disconnect). Every completion path funnels through here.
   */
  _cancelInitialMessage() {
    this._initialMessageCancelled = true;
    this._sessionUpdatedResolver?.();
  }

  /**
   * Any completion -- error, disconnect, connect failure, kill -- must also close
   * the door on a late initial response.create.
   */
  notifyTaskDone() {
    this._cancelInitialMessage();
    super.notifyTaskDone();
  }

  /**
   * Prime the session, then ask for the first response.
   *
   * Ordering matters and was wrong: this used to send response.create FIRST and
   * session.update second, so the model generated turn 1 against the stock OpenAI
   * persona -- our instructions (persona, language) and our tools were not yet in
   * effect. Observed symptom: identical configs greeting callers in Portuguese or
   * Chinese, and tools declared in session_update being unavailable on turn 1.
   * We now send session.update first and wait for the server's session.updated
   * ack before response.create, with a short timeout so a missing ack degrades to
   * the old behaviour instead of hanging the call.
   */
  async _sendInitialMessage(ep) {
    if (this._initialMessageCancelled || this.killed) return;

    /* send session.update first, if present, and wait for it to take effect */
    if (this.session_update) {
      if (this.parent.isMcpEnabled) {
        this.logger.debug('TaskLlmOpenAI_S2S:_sendInitialMessage - mcp enabled');
        try {
          const tools = await this.parent.mcpService.getAvailableMcpTools();
          if (tools && tools.length > 0 && this.session_update) {
            const convertedTools = tools.map((tool) => ({
              name: tool.name,
              type: 'function',
              description: tool.description,
              parameters: tool.inputSchema
            }));

            this.session_update.tools = [
              ...convertedTools,
              ...(this.session_update.tools || [])
            ];
          }
        } catch (err) {
          /* an mcp server being down must not cost the caller their greeting:
             degrade to the tools the application declared and carry on */
          this.logger.info({err},
            'TaskLlmOpenAI_S2S:_sendInitialMessage - error retrieving mcp tools, continuing without them');
        }
      }
      const sessionUpdated = this._awaitSessionUpdated();
      const obj = {type: 'session.update', session: this.session_update};
      this.logger.debug({obj}, 'TaskLlmOpenAI_S2S:_sendInitialMessage - sending session.update');
      if (!await this._sendClientEvent(ep, obj)) {
        return this.notifyTaskDone();
      }
      await sessionUpdated;

      /* the call may have been killed, or the session torn down by a server error
         or a ws disconnect, while we were waiting for the ack: never create a
         response on a session that is already gone */
      if (this._initialMessageCancelled || this.killed) {
        this.logger.info(
          'TaskLlmOpenAI_S2S:_sendInitialMessage - session ended while awaiting session.updated, not responding');
        return;
      }
    }

    const obj = {type: 'response.create', response: this.response_create};
    if (!await this._sendClientEvent(ep, obj)) {
      this.notifyTaskDone();
    }
  }

  _registerHandlers(ep) {
    this.addCustomEventListener(ep, LlmEvents_OpenAI.Connect, this._onConnect.bind(this, ep));
    this.addCustomEventListener(ep, LlmEvents_OpenAI.ConnectFailure, this._onConnectFailure.bind(this, ep));
    this.addCustomEventListener(ep, LlmEvents_OpenAI.Disconnect, this._onDisconnect.bind(this, ep));
    this.addCustomEventListener(ep, LlmEvents_OpenAI.ServerEvent, this._onServerEvent.bind(this, ep));
  }

  _unregisterHandlers() {
    this.removeCustomEventListeners();
  }

  _onError(ep, evt) {
    this.logger.info({evt}, 'TaskLlmOpenAI_S2S:_onError');
    this.notifyTaskDone();
  }

  _onConnect(ep) {
    this.logger.debug('TaskLlmOpenAI_S2S:_onConnect');

    /* prime the session exactly once. A second Connect while the first initializer
       is still holding response.create for its ack would send a duplicate
       session.update and a duplicate response.create on the same session. */
    if (this._initialMessagePromise) {
      this.logger.info('TaskLlmOpenAI_S2S:_onConnect - session already primed, ignoring duplicate connect');
      return;
    }
    this._initialMessagePromise = this._sendInitialMessage(ep)
      .catch((err) => {
        /* nothing awaits this promise, so an unhandled rejection here used to strand
           the call: no greeting, no completion, just a logged rejection */
        this.logger.info({err}, 'TaskLlmOpenAI_S2S:_onConnect - error priming session');
        this.results = {completionReason: 'client error', error: err};
        this.notifyTaskDone();
      });
  }
  _onConnectFailure(_ep, evt) {
    this.logger.info(evt, 'TaskLlmOpenAI_S2S:_onConnectFailure');
    this.results = {completionReason: 'connection failure'};
    this.notifyTaskDone();
  }
  _onDisconnect(_ep, evt) {
    this.logger.info(evt, 'TaskLlmOpenAI_S2S:_onConnectFailure');
    this.results = {completionReason: 'disconnect from remote end'};
    this.notifyTaskDone();
  }
  async _onServerEvent(ep, evt) {
    let endConversation = false;
    const type = evt.type;
    this.logger.info({evt}, 'TaskLlmOpenAI_S2S:_onServerEvent');

    /* release _sendInitialMessage, which is holding response.create until our session.update lands */
    if (type === 'session.updated') this._sessionUpdatedResolver?.();

    /* check for failures, such as rate limit exceeded, that should terminate the conversation */
    if (type === 'response.done' && evt.response.status === 'failed') {
      endConversation = true;
      this.results = {
        completionReason: 'server failure',
        error: evt.response.status_details?.error
      };
    }

    /* server errors of some sort */
    else if (type === 'error') {
      endConversation = true;
      this.results = {
        completionReason: 'server error',
        error: evt.error
      };
    }

    /* tool calls */
    else if (type === 'response.output_item.done' && evt.item?.type === 'function_call') {
      this.logger.debug({evt}, 'TaskLlmOpenAI_S2S:_onServerEvent - function_call');
      const {name, call_id} = evt.item;
      const args = JSON.parse(evt.item.arguments);

      const mcpTools = this.parent.isMcpEnabled ? await this.parent.mcpService.getAvailableMcpTools() : [];
      if (mcpTools.some((tool) => tool.name === name)) {
        this.logger.debug({call_id, name, args}, 'TaskLlmOpenAI_S2S:_onServerEvent - calling mcp tool');
        try {
          const res = await this.parent.mcpService.callMcpTool(name, args);
          this.logger.debug({res}, 'TaskLlmOpenAI_S2S:_onServerEvent - function_call - mcp result');
          this.processToolOutput(ep, call_id, {
            type: 'conversation.item.create',
            item: {
              type: 'function_call_output',
              call_id,
              output: res.content[0]?.text || 'There is no output from the function call',
            }
          });
          return;
        } catch (err) {
          this.logger.info({err, evt}, 'TaskLlmOpenAI_S2S - error calling function');
          this.results = {
            completionReason: 'client error calling mcp function',
            error: err
          };
          endConversation = true;
        }
      }
      else if (!this.toolHook) {
        this.logger.warn({evt}, 'TaskLlmOpenAI_S2S:_onServerEvent - no toolHook defined!');
      }
      else {
        try {
          await this.parent.sendToolHook(call_id, {name, args});
        } catch (err) {
          this.logger.info({err, evt}, 'TaskLlmOpenAI - error calling function');
          this.results = {
            completionReason: 'client error calling function',
            error: err
          };
          endConversation = true;
        }
      }
    }

    /* check whether we should notify on this event */
    if (this.includeEvents.length > 0 ? this.includeEvents.includes(type) : !this.excludeEvents.includes(type)) {
      this.parent.sendEventHook(evt)
        .catch((err) => this.logger.info({err}, 'TaskLlmOpenAI_S2S:_onServerEvent - error sending event hook'));
    }

    if (endConversation) {
      this.logger.info({results: this.results}, 'TaskLlmOpenAI_S2S:_onServerEvent - ending conversation due to error');
      this.notifyTaskDone();
    }
  }

  _populateEvents(events) {
    if (events.includes('all')) {
      /* work by excluding specific events */
      const exclude = events
        .filter((evt) => evt.startsWith('-'))
        .map((evt) => evt.slice(1));
      if (exclude.length === 0) this.includeEvents = openai_server_events;
      else this.excludeEvents = expandWildcards(exclude);
    }
    else {
      /* work by including specific events */
      const include = events
        .filter((evt) => !evt.startsWith('-'));
      this.includeEvents = expandWildcards(include);
    }

    this.logger.debug({
      includeEvents: this.includeEvents,
      excludeEvents: this.excludeEvents
    }, 'TaskLlmOpenAI_S2S:_populateEvents');
  }
}

module.exports = TaskLlmOpenAI_S2S;
