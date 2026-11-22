/** Browser-side feeder for the Loulan prompt library. No workflow or receipt is persisted here. */
const WRITER = "Loulan-prompt";
const WINDOW = 6;
const installed = new WeakMap();
const copy = value => JSON.parse(JSON.stringify(value));
// Also omit library copies carried by third-party workflow metadata.
const copyForImage = value => JSON.parse(JSON.stringify(value, (key, item) => key === "loulanBatch" ? undefined : item));

function liveNodes(graph, prefix = "", result = new Map(), ancestry = new Set()) {
  if (!graph || ancestry.has(graph)) return result;
  const branch = new Set(ancestry).add(graph);
  for (const node of graph.nodes ?? graph._nodes ?? []) {
    const id = prefix + node.id;
    result.set(id, node);
    if (node.subgraph) liveNodes(node.subgraph, id + ":", result, branch);
  }
  return result;
}

function upstream(output, targets) {
  const pending = [...targets].map(String);
  const ids = new Set();
  while (pending.length) {
    const id = pending.pop();
    if (ids.has(id) || !Object.hasOwn(output, id)) continue;
    ids.add(id);
    for (const input of Object.values(output[id].inputs ?? {})) {
      if (Array.isArray(input) && input.length === 2 && Number.isInteger(input[1])) pending.push(String(input[0]));
    }
  }
  return ids;
}

function serializedNodes(workflow) {
  const definitions = new Map((workflow.definitions?.subgraphs ?? []).map(sub => [sub.id, sub]));
  const nodes = new Map();
  function visit(graph, prefix, parents) {
    if (parents.has(graph)) return;
    const seen = new Set(parents).add(graph);
    for (const node of graph.nodes ?? []) {
      const id = prefix + node.id;
      nodes.set(id, node);
      const sub = definitions.get(node.type);
      if (sub) visit(sub, id + ":", seen);
    }
  }
  visit(workflow, "", new Set());
  return nodes;
}

function writerMetadata(node, text) {
  if (node.properties) delete node.properties.loulanBatch;
  node.widgets_values = [text];
  if (node.widgets_values_named) node.widgets_values_named = { prompt: text };
}

// Strip every library, including unused definitions. Each image can be opened
// as a one-row workflow, regardless of the number of rows in the editor.
function stripLibraries(data) {
  for (const graph of [data.workflow, ...(data.workflow.definitions?.subgraphs ?? [])]) {
    for (const node of graph.nodes ?? []) {
      if (node.type === WRITER) writerMetadata(node, "");
    }
  }
  for (const entry of Object.values(data.output)) {
    if (entry.class_type === WRITER) entry.inputs = { prompt: "" };
  }
}

function widgetLocation(id, node, widget) {
  return { id, name: widget.name, index: (node.widgets ?? []).filter(w => w.serialize !== false).indexOf(widget) };
}

function setWidgetValue(nodes, location, value) {
  const node = nodes.get(location.id);
  if (!node) return;
  if (Array.isArray(node.widgets_values) && location.index >= 0) node.widgets_values[location.index] = value;
  if (node.widgets_values_named) node.widgets_values_named[location.name] = value;
}

// Trace promoted input slots from a subgraph instance to their flattened
// consumers. A single host widget can drive several interior nodes.
function destinations(node, input, id, seen = new Set()) {
  const slot = node.subgraph?.inputNode?.slots?.find(slot => slot.name === input.name);
  if (!slot || seen.has(slot)) return [];
  const visited = new Set(seen).add(slot);
  const result = [];
  for (const linkId of slot.linkIds ?? []) {
    const link = node.subgraph.getLink?.(linkId);
    const end = link?.resolve?.(node.subgraph);
    if (!end?.inputNode || !end.input) continue;
    const child = end.inputNode;
    const childId = id + ":" + child.id;
    if (child.subgraph) result.push(...destinations(child, end.input, childId, visited));
    else {
      const widget = child.getWidgetFromSlot?.(end.input) ?? child.widgets?.find(w => w.name === end.input.name);
      if (widget) result.push({ id: childId, node: child, widget });
    }
  }
  return result;
}

// A connected text widget can still carry an older prompt in the PNG workflow.
// Use the compiled connection to distinguish it from intentional static text.
function stripPromptFallbacks(workflow, live, output, writerId) {
  const nodes = serializedNodes(workflow);
  const fields = new Map();
  function fedByWriter(id, name) {
    const ref = output[id]?.inputs?.[name];
    return Array.isArray(ref) && String(ref[0]) === writerId && ref[1] === 0;
  }
  for (const [id, node] of live) {
    const serialized = nodes.get(id);
    if (!serialized) continue;
    const promoted = node.subgraph ? (node.inputs ?? []).filter(input => input.widgetId) : null;
    for (const input of promoted ?? node.inputs ?? []) {
      if (input.type !== "STRING") continue;
      const widget = node.getWidgetFromSlot?.(input)
        ?? node.widgets?.find(w => w.name === (input.widget?.name ?? input.name));
      if (!widget) continue;
      const index = promoted ? promoted.indexOf(input) : widgetLocation(id, node, widget).index;
      const name = promoted ? input.name : widget.name;
      let connected = fedByWriter(id, input.name);
      if (promoted) {
        const ends = destinations(node, input, id);
        connected = input.link != null && ends.length > 0 && ends.every(t => fedByWriter(t.id, t.widget.name));
      }
      // Multiple instances share the same serialized subgraph definition.
      // Preserve a default still used by another instance of that definition.
      if (!fields.has(serialized)) fields.set(serialized, new Map());
      const byName = fields.get(serialized);
      byName.set(name, { index, clear: connected && byName.get(name)?.clear !== false });
    }
  }
  for (const [node, byName] of fields) {
    for (const [name, {index, clear}] of byName) {
      if (!clear) continue;
      if (Array.isArray(node.widgets_values) && typeof node.widgets_values[index] === "string") node.widgets_values[index] = "";
      if (typeof node.widgets_values_named?.[name] === "string") node.widgets_values_named[name] = "";
    }
  }
}

function controlMode(widget) {
  return widget.linkedWidgets?.find(w =>
    ["randomize", "increment", "decrement", "increment-wrap"].includes(w.value)
    && (typeof w.beforeQueued === "function" || /control_after_generate/.test(w.name))
  )?.value;
}

function collectControls(live, output) {
  const controls = [];
  function add(targets, liveWidget, locations) {
    const first = targets[0];
    if (!first) return;
    const mode = controlMode(first.widget);
    const keys = targets.filter(({ id, widget }) => {
      const inputs = output[id]?.inputs;
      return inputs && Object.hasOwn(inputs, widget.name) && !Array.isArray(inputs[widget.name]);
    }).map(({ id, widget }) => ({ id, name: widget.name }));
    if (!mode || !keys.length) return;
    const options = first.widget.options ?? {};
    const filter = first.widget.linkedWidgets?.find(w => w.type === "string")?.value;
    let choices = Array.isArray(options.values) ? [...options.values] : null;
    if (choices && filter) {
      let match = s => String(s).toLowerCase().includes(String(filter).toLowerCase());
      if (filter.startsWith("/") && filter.endsWith("/")) {
        try { const re = new RegExp(filter.slice(1, -1)); match = s => re.test(String(s)); } catch { /* use literal */ }
      }
      choices = choices.filter(match);
    }
    controls.push({ mode, keys, locations, liveWidget, choices, source: first,
      min: Math.max(-(2 ** 50), options.min ?? 0), max: Math.min(2 ** 50, options.max ?? 1),
      step: options.step2 ?? 1, value: output[keys[0].id].inputs[keys[0].name] });
  }
  for (const [id, node] of live) {
    if (node.subgraph) {
      const promoted = (node.inputs ?? []).filter(input => input.widgetId);
      for (const [index, input] of promoted.entries()) {
        if (input.link != null || node.isInputConnected?.(node.inputs.indexOf(input))) continue;
        const targets = destinations(node, input, id);
        const hostWidget = node.getWidgetFromSlot?.(input);
        if (hostWidget) add(targets, hostWidget, [{ id, name: input.name, index },
          ...targets.map(t => widgetLocation(t.id, t.node, t.widget))]);
      }
    } else {
      for (const widget of node.widgets ?? []) {
        if (!controlMode(widget)) continue;
        if ((node.inputs ?? []).some(input => input.link != null && (input.widget?.name ?? input.name) === widget.name)) continue;
        add([{ id, node, widget }], widget, [widgetLocation(id, node, widget)]);
      }
    }
  }
  return controls;
}

function nextValue(c) {
  if (c.choices) {
    if (!c.choices.length) return c.value;
    const size = c.choices.length;
    let i = c.choices.indexOf(c.value);
    if (c.mode === "randomize") i = Math.floor(Math.random() * size);
    else if (c.mode === "increment-wrap") i = (i + 1) % size;
    else i += c.mode === "decrement" ? -1 : 1;
    return c.choices[Math.min(size - 1, Math.max(0, i))];
  }
  if (typeof c.value !== "number") return c.value;
  if (c.mode === "randomize") return Math.floor(Math.random() * ((c.max - c.min) / c.step)) * c.step + c.min;
  return Math.max(c.min, Math.min(c.max, c.value + (c.mode === "decrement" ? -c.step : c.step)));
}

function makePayload(run, item) {
  const payload = copy(run.template);
  const row = run.rows[Math.floor(item.index / run.repeat)];
  payload.output[run.writerId].inputs = { prompt: row };
  const nodes = serializedNodes(payload.workflow);
  writerMetadata(nodes.get(run.writerId), row);
  for (const [index, control] of run.controls.entries()) {
    const value = item.values[index];
    for (const { id, name } of control.keys) payload.output[id].inputs[name] = value;
    for (const location of control.locations) setWidgetValue(nodes, location, value);
  }
  return payload;
}

function status(run) {
  return { phase: run.phase, total: run.total, submitted: run.submitted,
    queued: run.pending.size - run.running.size, running: run.running.size,
    completed: run.completed, failed: run.failedItems.size + run.cancelledFailures + Number(run.rejected),
    attempts: run.attempts, unknown: run.unknown,
    canRetry: run.canRetry, message: run.message };
}

function failure(message, safe = false) {
  return Object.assign(new Error(message), { safe });
}

export function installBatchQueue(app, api, { getState, getSelection, notify = () => {}, onStatus = () => {} }) {
  if (installed.has(app)) return installed.get(app);
  const nativeQueue = app.queuePrompt;
  const originalApp = nativeQueue.bind(app);
  const originalApi = api.queuePrompt.bind(api);
  const firstPayloads = new WeakMap();
  const outbound = new WeakSet();
  const byNode = new WeakMap();
  const byWorkflow = new Map();
  const receipts = new Map();
  const earlyEvents = new Map();
  let firstCall = null;
  let preparing = null;
  let inFlight = 0;

  const root = () => app.rootGraph ?? app.graph;
  const lang = (run, cn, en) => run.language === "en" ? en : cn;
  function publish(run) {
    if (byNode.get(run.node) !== run) return;
    try { onStatus(run.node, status(run)); } catch (e) { console.error("[Loulan-prompt]", e); }
  }
  const hasWork = run => run.retryItems.size || (!run.blocked && run.submitted < run.total);
  function settle(run) {
    if (["feeding", "paused"].includes(run.phase) && !hasWork(run)) run.phase = run.blocked ? "failed" : "submitted";
    if (run.phase === "submitted" && run.pending.size === 0) run.phase = "done";
    if (run.phase === "failed") run.canRetry = (!run.blocked && run.submitted < run.total) || run.failedItems.size > 0;
    const finished = ["done", "cancelled"].includes(run.phase) && !run.busy;
    if (finished || (run.phase === "failed" && !run.canRetry && !run.pending.size)) {
      run.template = null;
      run.rows = [];
      run.controls = [];
      if (byWorkflow.get(run.key) === run) byWorkflow.delete(run.key);
    }
    publish(run);
  }
  function stop(run, error, retryable) {
    if (run.phase === "cancelled") return;
    run.phase = "failed";
    run.blocked = !retryable;
    run.rejected = retryable && !error.accepted && !run.retryItems.size;
    const reason = error?.response?.error?.message ?? error?.message ?? String(error);
    run.message = lang(run, "已停止提交", "Submission stopped") + " (" + run.submitted + "/" + run.total + "). " + reason;
    notify(run.message);
    settle(run);
  }

  function eventFor(id, kind) {
    const run = receipts.get(id);
    if (!run) {
      // A very quick cached job can finish before its HTTP receipt arrives.
      if (inFlight && id) {
        if (earlyEvents.size >= 128) earlyEvents.delete(earlyEvents.keys().next().value);
        earlyEvents.set(id, kind);
      }
      return;
    }
    if (kind === "running") run.running.add(id);
    else {
      receipts.delete(id);
      const item = run.pending.get(id);
      run.pending.delete(id);
      run.running.delete(id);
      if (kind === "completed") run.completed++;
      else if (kind === "missing") {
        run.unknown++;
        run.message = lang(run, "任务已从队列和历史记录中移除，请核对结果。", "Job removed from queue and history. Check its result.") + " " + id;
        if (run.phase === "feeding") run.phase = "paused";
        else if (run.phase === "submitted") run.phase = "failed";
      } else if (run.phase !== "cancelled") {
        run.failedItems.set(item.index, item);
        run.phase = "failed";
        run.message = lang(run, "执行失败或中断。重试将使用该任务原来的提示词和种子。", "Execution failed or was interrupted. Retry uses the original prompt and seed.") + " " + id;
      } else run.cancelledFailures++;
    }
    settle(run);
    schedule(run);
  }
  for (const [type, kind] of [["execution_start", "running"], ["execution_success", "completed"],
    ["execution_interrupted", "failed"], ["execution_error", "failed"]]) {
    api.addEventListener?.(type, e => eventFor(e.detail?.prompt_id, kind));
  }

  async function reconcile(run) {
    // The jobs endpoint recovers missed websocket events after reconnect.
    try {
      for (const id of [...run.pending.keys()]) {
        if (!run.pending.has(id)) continue;
        let detail;
        if (api.fetchApi) {
          const response = await api.fetchApi("/jobs/" + encodeURIComponent(id));
          if (response.status === 404 && run.pending.has(id)) {
            // The new jobs API is present on 1.59.6. A missing job is
            // authoritative only after confirming neither queue contains it.
            const queue = await api.getQueue({ throwOnError: true });
            const present = [...queue.Pending, ...queue.Running].some(x => (x.prompt?.[1] ?? x.id ?? x[1]) === id);
            if (!present && run.pending.has(id)) eventFor(id, "missing");
            continue;
          }
          if (!response.ok) continue;
          detail = await response.json();
        } else detail = await api.getJobDetail(id);
        if (!run.pending.has(id)) continue;
        const phase = detail?.status;
        if (["completed", "success"].includes(phase)) eventFor(id, "completed");
        else if (["cancelled", "canceled", "failed", "error"].includes(phase)) eventFor(id, "failed");
        else if (phase === "running" || phase === "in_progress") eventFor(id, "running");
      }
    } catch { /* the next poll or websocket event will reconcile */ }
    run.poll = null;
    schedule(run);
  }
  function schedule(run) {
    if (run.pending.size && !run.poll && api.getJobDetail) {
      run.poll = setTimeout(() => void reconcile(run), 20000);
      run.poll?.unref?.();
    }
    if (run.phase === "feeding" && !run.busy && hasWork(run) && run.pending.size < WINDOW) {
      void pump(run);
    }
  }

  function accepted(run, response, item, retry) {
    const id = response?.prompt_id;
    if (!id) {
      const explicit = response === false || !!response?.error || !!Object.keys(response?.node_errors ?? {}).length;
      throw failure(response?.error?.message ?? lang(run, "没有收到任务 ID，请检查队列。", "No job ID received. Check the queue."), explicit);
    }
    if (run.seen.has(id) || receipts.has(id)) throw failure("Duplicate prompt_id: " + id);
    run.seen.add(id);
    if (run.attempts === 0) run.priority = response.number;
    run.attempts++;
    if (retry) {
      run.retryItems.delete(item.index);
      run.failedItems.delete(item.index);
    } else run.submitted++;
    receipts.set(id, run);
    run.pending.set(id, item);
    if (earlyEvents.has(id)) {
      const kind = earlyEvents.get(id);
      earlyEvents.delete(id);
      eventFor(id, kind);
    }
    publish(run);
  }
  function numberFor(run) {
    if (run.number !== -1 || !run.submitted) return run.number;
    // Comfy's /prompt returns an integer priority for front=true and accepts
    // floating priorities. Reserve the gap before the preceding integer job.
    if (!Number.isFinite(run.priority)) throw failure("Missing queue-front priority.");
    const index = run.retryItems.size ? run.retryItems.keys().next().value : run.submitted;
    return run.priority + (index + (index === 0 ? 0.5 : 0)) / (run.total + 1);
  }

  async function send(run, options, nativeData) {
    if (run.phase !== "feeding") throw failure("Submission paused.", true);
    if (nativeData && !run.submitted) {
      for (const control of run.controls) {
        const { id, name } = control.keys[0];
        control.value = nativeData.output[id]?.inputs?.[name] ?? control.value;
      }
    }
    const retry = !!run.retryItems.size;
    const item = retry ? run.retryItems.values().next().value :
      { index: run.submitted, values: run.controls.map(control => control.value) };
    const payload = makePayload(run, item);
    const number = numberFor(run);
    if (nativeData) Object.assign(nativeData, payload);
    outbound.add(payload);
    inFlight++;
    try {
      const response = nativeData ? await originalApi(number, payload, options) : await api.queuePrompt(number, payload, options);
      accepted(run, response, item, retry);
      if (!retry) {
        const live = liveNodes(root());
        const origin = byNode.get(run.node) === run && live.get(run.writerId) === run.node;
        for (const [i, control] of run.controls.entries()) {
          control.value = nextValue(control);
          if (!nativeData && origin && control.sync && live.get(control.source.id) === control.source.node &&
              controlMode(control.source.widget) === control.mode && Object.is(control.liveWidget.value, control.lastLive)) {
            const next = run.beforeMode ? item.values[i] : control.value;
            try {
              control.liveWidget.value = next;
              control.liveWidget.callback?.(next);
              control.lastLive = next;
            } catch (error) {
              control.sync = false;
              console.warn("[Loulan-prompt] Updating live widget", error);
            }
          } else if (!nativeData) control.sync = false;
        }
      }
      if (Object.keys(response.node_errors ?? {}).length || response.error) {
        const error = failure(lang(run, "服务器接受了部分输出，但报告了节点错误。", "Server accepted the job with node errors."), true);
        error.accepted = true;
        throw error;
      }
      return response;
    } catch (error) {
      // If the response to a retry was lost, its former execution failure is
      // no longer proof that it is safe to submit that logical item again.
      if (!safeToRetry(error) && !error.accepted) {
        if (retry) {
          run.failedItems.delete(item.index);
          run.retryItems.delete(item.index);
        }
        run.unknown++;
      }
      throw error;
    } finally {
      inFlight--;
      if (!inFlight) earlyEvents.clear();
    }
  }

  api.queuePrompt = async function (number, data, options, ...args) {
    if (outbound.has(data)) return originalApi(number, data, options, ...args);
    const ctx = firstPayloads.get(data);
    if (ctx && ctx === firstCall && !ctx.called) {
      ctx.called = true;
      const run = ctx.run;
      try {
        if (liveNodes(root()).get(run.writerId) !== run.node) throw failure(lang(run, "工作流已切换，请重新运行。", "Workflow changed before submission. Run it again."), true);
        run.options = options;
        return await send(run, options, data);
      } catch (error) {
        ctx.error = error;
        throw error;
      }
    }
    if (firstCall && !firstCall.called) {
      throw failure("Overlapping queue call or incompatible ComfyUI queue wrapper. No job submitted.", true);
    }
    // A non-batch execution with an unused/disabled writer still embeds its
    // graph in the PNG. Preserve its API values, but remove dormant libraries.
    if (data?.workflow && [data.workflow, ...(data.workflow.definitions?.subgraphs ?? [])]
      .some(g => g.nodes?.some(n => n.type === WRITER))) {
      data = copyForImage(data);
      const nodes = serializedNodes(data.workflow);
      for (const graph of [data.workflow, ...(data.workflow.definitions?.subgraphs ?? [])]) {
        for (const node of graph.nodes ?? []) if (node.type === WRITER) writerMetadata(node, "");
      }
      for (const [id, entry] of Object.entries(data.output)) {
        if (entry.class_type === WRITER && nodes.has(id)) writerMetadata(nodes.get(id), entry.inputs.prompt ?? "");
      }
    }
    return originalApi(number, data, options, ...args);
  };

  async function nativeItem(run) {
    if (firstCall || app.processingQueue) throw failure(lang(run, "ComfyUI 正在提交另一个任务。", "ComfyUI is submitting another job."), true);
    const verifyOrigin = () => {
      const graph = root();
      if (liveNodes(graph).get(run.writerId) !== run.node) {
        throw failure(lang(run, "请返回原工作流后重试。", "Return to the original workflow and retry."), true);
      }
      return graph;
    };
    verifyOrigin();
    const initial = !run.attempts;
    const previousAttempts = run.attempts;
    const ctx = { run, called: false };
    // Only the native method's own compilation receives the receipt marker.
    // A concurrent workflow export or direct API caller cannot claim it.
    const receiver = new Proxy(app, {
      get(target, name) {
        if (name === "rootGraph") return verifyOrigin();
        if (name === "graphToPrompt") return async (...args) => {
          const data = await target.graphToPrompt(...args);
          firstPayloads.set(data, ctx);
          return data;
        };
        return Reflect.get(target, name, target);
      },
      set(target, name, value) { return Reflect.set(target, name, value, target); },
    });
    firstCall = ctx;
    try {
      const result = await nativeQueue.call(receiver, numberFor(run), 1, ...run.args);
      if (ctx.error) throw ctx.error;
      if (!ctx.called || result === false) {
        const error = failure(lang(run, "ComfyUI 停止了提交。", "ComfyUI stopped submission."), true);
        error.accepted = run.attempts !== previousAttempts;
        throw error;
      }
      if (initial) {
        for (const control of run.controls) {
          control.lastLive = control.liveWidget.value;
          control.sync = true;
          if (!run.beforeMode) control.value = control.lastLive;
        }
      }
    } finally { firstCall = null; }
  }
  function safeToRetry(error) {
    return error?.safe === true || (error?.status >= 400 && error.status < 500 && error.status !== 408);
  }
  async function pump(run) {
    run.busy = true;
    try {
      while (run.phase === "feeding" && hasWork(run) && run.pending.size < WINDOW) {
        if (!run.submitted || run.partner) await nativeItem(run);
        else await send(run, run.options);
        // Finish each complete request before reserving the next cursor.
      }
    } catch (error) {
      if (run.phase !== "paused") stop(run, error, safeToRetry(error));
    } finally {
      run.busy = false;
      settle(run);
      schedule(run);
    }
  }

  function keyFor(node) {
    const graph = root();
    if (!graph?.id) return null;
    const entry = [...liveNodes(graph)].find(([, n]) => n === node);
    return entry ? graph.id + "/" + entry[0] : null;
  }
  function runFor(node) {
    const existing = byNode.get(node);
    if (existing) return existing;
    const restored = byWorkflow.get(keyFor(node));
    if (restored) {
      byNode.set(node, restored);
      restored.node = node;
    }
    return restored;
  }
  const controller = {
    getStatus(node) { const run = runFor(node); return run ? status(run) : null; },
    pause(node) {
      const run = runFor(node);
      if (run?.phase === "feeding") { run.phase = "paused"; publish(run); }
    },
    resume(node) {
      const run = runFor(node);
      if (run?.phase === "paused") { run.phase = "feeding"; settle(run); schedule(run); }
    },
    retry(node) {
      const run = runFor(node);
      if (run?.phase === "failed" && run.canRetry) {
        run.retryItems = new Map(run.failedItems);
        run.phase = "feeding"; run.rejected = false; run.canRetry = false; run.message = "";
        settle(run); schedule(run);
      }
    },
    cancel(node) {
      const run = runFor(node);
      if (run && ["feeding", "paused", "failed"].includes(run.phase)) {
        run.phase = "cancelled"; run.canRetry = false; settle(run);
      }
    },
  };
  app.queuePrompt = async function (number = 0, batchCount = 1, ...args) {
    if (preparing || firstCall) { notify("Loulan-prompt · 正在提交 / Submission in progress"); return false; }
    const graph = root();
    const live = liveNodes(graph);
    if (![...live.values()].some(n => (n.comfyClass ?? n.type) === WRITER)) return originalApp(number, batchCount, ...args);
    const ticket = {};
    preparing = ticket;
    try {
      const data = await app.graphToPrompt(graph);
      const partial = Array.isArray(args[0]) ? args[0] : args[0]?.queueNodeIds;
      const outputs = Object.keys(data.output).filter(id => live.get(id)?.constructor?.nodeData?.output_node === true);
      const selected = partial?.length ? new Set(partial.map(String)) : null;
      const targets = selected ? outputs.filter(id => selected.has(id)) : outputs;
      const active = upstream(data.output, targets);
      const writers = [...active].filter(id => data.output[id].class_type === WRITER);
      if (!writers.length) return originalApp(number, batchCount, ...args);
      const writerId = writers[0];
      const node = live.get(writerId);
      const state = getState(node);
      const run = { node, writerId, language: state.language };
      if (writers.length !== 1) {
        notify(lang(run, "有多个提示词节点参与本次执行，请每次选择一个。", "Multiple prompt writers feed these outputs. Select one per run."));
        return false;
      }
      const previous = runFor(node);
      if (previous && (["feeding", "paused"].includes(previous.phase) || previous.busy)) {
        notify(lang(run, "此批次仍在提交。", "This batch is already being submitted."));
        return false;
      }
      const rows = getSelection(state).map(row => state.trigger ? state.trigger + "\n" + row.text : row.text);
      if (!rows.length) { notify(lang(run, "没有选中有效提示词。", "No eligible prompts selected.")); return false; }
      const repeat = Math.max(1, Math.trunc(Number(batchCount) || 1));
      if (!Number.isSafeInteger(rows.length * repeat)) { notify(lang(run, "批次数无效。", "Invalid batch count.")); return false; }
      const template = copyForImage(data);
      stripLibraries(template);
      stripPromptFallbacks(template.workflow, live, data.output, writerId);
      if (!serializedNodes(template.workflow).has(writerId)) throw failure("Cannot locate Loulan-prompt in workflow metadata.");
      Object.assign(run, { template, controls: collectControls(live, data.output), rows, repeat, total: rows.length * repeat,
        args, number, partner: [...active].some(id => live.get(id)?.constructor?.nodeData?.api_node),
        beforeMode: app.ui?.settings?.getSettingValue?.("Comfy.WidgetControlMode") === "before",
        submitted: 0, completed: 0, attempts: 0, unknown: 0, cancelledFailures: 0,
        pending: new Map(), running: new Set(), seen: new Set(),
        failedItems: new Map(), retryItems: new Map(), phase: "feeding",
        rejected: false, canRetry: false, message: "" });
      byNode.set(node, run);
      const key = keyFor(node);
      run.key = key;
      if (key) byWorkflow.set(key, run);
      publish(run);
      preparing = null;
      await pump(run);
      return !["failed", "cancelled"].includes(run.phase);
    } catch (error) {
      notify(String(error?.message ?? error));
      return false;
    } finally { if (preparing === ticket) preparing = null; }
  };
  installed.set(app, controller);
  return controller;
}
