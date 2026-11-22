import test from "node:test";
import assert from "node:assert/strict";
import { installBatchQueue } from "../web/queue.js";

const writerType = "Loulan-prompt";
const clone = value => JSON.parse(JSON.stringify(value));
const flush = () => new Promise(resolve => setImmediate(resolve));

function makeFixture({ rows = ["A", "B"], mode = "increment", max = 100, prefix = "",
  network, falseFromApp = false, afterCompile } = {}) {
  const requests = [];
  const messages = [];
  const writer = { id: 2, type: writerType, properties: { loulanBatch: { rows: rows.map(text => ({ text })), trigger: prefix, language: "en" } } };
  const unused = { id: 9, type: writerType, properties: { loulanBatch: { rows: [{text:"secret unused library row"}] } } };
  const seed = { name: "seed", value: 4, options: { min: 0, max, step2: 1 },
    linkedWidgets: [{ name: "control_after_generate", value: mode }] };
  const sampler = { id: 3, type: "Sampler", widgets: [seed] };
  const output = { id: 4, type: "Image", constructor: { nodeData: { output_node: true } } };
  const second = { id: 5, type: "Image", constructor: { nodeData: { output_node: true } } };
  const graph = { id: "graph-id", nodes: [writer, unused, sampler, output, second] };
  function documentFor(g) {
    return { workflow: { nodes: g.nodes.map(n => ({ id: n.id, type:n.type, properties:clone(n.properties ?? {}),
      widgets_values: n === sampler ? [seed.value] : [""], widgets_values_named: n === sampler ? { seed:seed.value } : {} })) },
      output: {
        2:{class_type:writerType, inputs:{prompt:"full carrier"}},
        3:{class_type:"Sampler", inputs:{positive:["2",0],seed:seed.value}},
        4:{class_type:"Image", inputs:{data:["3",0]}},
        5:{class_type:"Image", inputs:{}},
        9:{class_type:writerType, inputs:{prompt:"unused carrier"}},
      } };
  }
  const api = new EventTarget();
  api.queuePrompt = async (number, data, options) => {
    requests.push({number, data:clone(data), options});
    if (network) return network(requests.length, api);
    return { prompt_id: "job-" + requests.length, number: number === -1 ? -7 : 10 };
  };
  const app = {
    graph, nativeCalls: [],
    graphToPrompt: async g => documentFor(g ?? app.graph),
    async queuePrompt(number,batch,args) {
      this.nativeCalls.push({number,batch,args});
      for(let i=0;i<batch;i++) {
        const data = await this.graphToPrompt(this.graph);
        if (afterCompile) await afterCompile(this,data);
        const result = await api.queuePrompt(number,data,{partialExecutionTargets:args?.queueNodeIds ?? args});
        if (falseFromApp || !result) return false;
        if (mode === "increment") seed.value = Math.min(seed.value + 1,max);
        else if (mode === "randomize") seed.value = 77;
      }
      return true;
    },
  };
  const controller = installBatchQueue(app,api,{getState:n => n.properties.loulanBatch,
    getSelection:s=>s.rows, notify:s=>messages.push(s)});
  return { requests, writer, sampler, seed, app, api, graph, unused, output, documentFor, controller, messages };
}

function event(api,type,id) {
  api.dispatchEvent(new CustomEvent(type, {detail:{prompt_id:id}}));
}

test("toolbar repetitions stay grouped; PNG and API contain only the selected row and actual seed", async () => {
  const f = makeFixture({prefix:"style",rows:["one\nline","two"]});
  assert.equal(await f.app.queuePrompt(0,2),true);
  assert.deepEqual(f.requests.map(r=>r.data.output[2].inputs.prompt),["style\none\nline","style\none\nline","style\ntwo","style\ntwo"]);
  assert.deepEqual(f.requests.map(r=>r.number),[0,0,0,0]);
  assert.deepEqual(f.requests.map(r=>r.data.output[3].inputs.seed),[4,5,6,7]);
  assert.equal(f.seed.value,8);
  for(const {data} of f.requests) {
    assert.equal(data.workflow.nodes.find(n=>n.id===2).widgets_values_named.prompt,data.output[2].inputs.prompt);
    assert.equal(data.workflow.nodes.find(n=>n.id===3).widgets_values[0],data.output[3].inputs.seed);
    assert.equal(data.output[9].inputs.prompt,"");
    assert.ok(!JSON.stringify(data).includes("loulanBatch"));
  }
  assert.equal((await f.app.graphToPrompt()).workflow.nodes[0].properties.loulanBatch.rows.length,2);
});

test("partial selection forwards an unrelated output to native execution without splitting", async()=>{
  const f=makeFixture({rows:["A","B","C"]});
  await f.app.queuePrompt(0,2,{queueNodeIds:["5"]});
  assert.equal(f.requests.length,2);
  assert.deepEqual(f.app.nativeCalls,[{number:0,batch:2,args:{queueNodeIds:["5"]}}]);
  assert.ok(!JSON.stringify(f.requests).includes("secret unused library row"));
});

test("front priorities preserve natural order even when execution begins immediately",async()=>{
  const f=makeFixture({rows:["A","B","C"]});
  await f.app.queuePrompt(-1,1);
  assert.deepEqual(f.requests.map(r=>r.number),[-1,-6.75,-6.5]);
});

test("the six-job window resumes from the cursor after tab switch and ignores live edits",async()=>{
  const f=makeFixture({rows:Array.from({length:10},(_,i)=>String(i))});
  assert.equal(await f.app.queuePrompt(0,1),true);
  assert.equal(f.requests.length,6);
  f.controller.pause(f.writer);
  f.writer.properties.loulanBatch.rows = [{text:"edited"}];
  f.seed.value=88;
  f.app.graph={id:"other",nodes:[]};
  event(f.api,"execution_success","job-1");
  await flush();
  assert.equal(f.requests.length,6);
  f.controller.resume(f.writer);
  await flush();
  assert.equal(f.requests[6].data.output[2].inputs.prompt,"6");
  assert.equal(f.requests[6].data.output[3].inputs.seed,10);
  assert.equal(f.seed.value,88);
  assert.equal(f.controller.getStatus(f.writer).completed,1);
});

test("a core false after a receipt stops the feeder without duplicating the accepted job",async()=>{
  const f=makeFixture({falseFromApp:true});
  assert.equal(await f.app.queuePrompt(0,1),false);
  assert.equal(f.requests.length,1);
  assert.equal(f.controller.getStatus(f.writer).submitted,1);
  assert.equal(f.controller.getStatus(f.writer).canRetry,true);
  f.controller.retry(f.writer);
  await flush();
  assert.deepEqual(f.requests.map(r=>r.data.output[2].inputs.prompt),["A","B"]);
});

test("an ambiguous transport failure does not repeat a possibly accepted item",async()=>{
  const f=makeFixture({network(i){if(i===2)throw new TypeError("offline");return {prompt_id:"job-"+i,number:10};}});
  assert.equal(await f.app.queuePrompt(0,2),false);
  assert.equal(f.controller.getStatus(f.writer).submitted,1);
  assert.equal(f.controller.getStatus(f.writer).canRetry,false);
  f.controller.retry(f.writer);
  await flush();
  assert.equal(f.requests.length,2);
});

test("retrying an execution error reuses its exact row and seed and preserves successful jobs",async()=>{
  const f=makeFixture({rows:["A","B","C"]});
  await f.app.queuePrompt(0,1);
  event(f.api,"execution_success","job-3");
  event(f.api,"execution_error","job-2");
  event(f.api,"execution_success","job-1");
  assert.equal(f.controller.getStatus(f.writer).failed,1);
  assert.equal(f.controller.getStatus(f.writer).canRetry,true);
  f.controller.retry(f.writer);
  await flush();
  assert.deepEqual(f.requests[3].data,f.requests[1].data);
  event(f.api,"execution_success","job-4");
  const s=f.controller.getStatus(f.writer);
  assert.equal(s.submitted,3);
  assert.equal(s.attempts,4);
  assert.equal(s.completed,3);
  assert.equal(s.failed,0);
  assert.equal(s.phase,"done");
});

test("a flattened subgraph writer and promoted seed update API and workflow values together",async()=>{
  const f=makeFixture({rows:["first","next"]});
  f.sampler.inputs=[{name:"seed",widget:{name:"seed"},link:77}];
  const slot={name:"noise",widgetId:"widget",link:null};
  const subgraph={nodes:[f.writer,f.sampler],inputNode:{slots:[{name:"noise",linkIds:[77]}]},
    getLink:()=>({resolve:()=>({inputNode:f.sampler,input:f.sampler.inputs[0]})})};
  const host={id:10,type:"sub-def",subgraph,inputs:[slot],getWidgetFromSlot:()=>f.seed};
  f.graph.nodes=[host,f.output,f.unused];
  f.app.graphToPrompt=async()=>({
    workflow:{nodes:[{id:10,type:"sub-def",widgets_values:[f.seed.value],widgets_values_named:{noise:f.seed.value}},
      {id:4,type:"Image"}],definitions:{subgraphs:[{id:"sub-def",nodes:[
        {id:2,type:writerType,properties:{loulanBatch:f.writer.properties.loulanBatch}},
        {id:3,type:"Sampler",widgets_values:[f.seed.value],widgets_values_named:{seed:f.seed.value}}
      ]}]}},
    output:{
      "10:2":{class_type:writerType,inputs:{prompt:""}},
      "10:3":{class_type:"Sampler",inputs:{seed:f.seed.value,positive:["10:2",0]}},
      "4":{class_type:"Image",inputs:{data:["10:3",0]}},
    },
  });
  assert.equal(await f.app.queuePrompt(0,1,["4"]),true);
  assert.deepEqual(f.requests.map(r=>r.data.output["10:2"].inputs.prompt),["first","next"]);
  assert.deepEqual(f.requests.map(r=>r.data.output["10:3"].inputs.seed),[4,5]);
  assert.deepEqual(f.requests.map(r=>r.data.workflow.nodes[0].widgets_values_named.noise),[4,5]);
  assert.deepEqual(f.requests.map(r=>r.data.workflow.definitions.subgraphs[0].nodes[0].widgets_values),[["first"],["next"]]);
  assert.equal(f.seed.value,6);
});

test("a validation rejection retries the first unaccepted item only",async()=>{
  const f=makeFixture({rows:["A","B","C"],network(i){
    if(i===2)throw Object.assign(new Error("invalid"),{status:400});
    return {prompt_id:"job-"+i,number:1};
  }});
  assert.equal(await f.app.queuePrompt(0,1),false);
  assert.equal(f.controller.getStatus(f.writer).canRetry,true);
  f.controller.retry(f.writer);
  await flush();
  assert.deepEqual(f.requests.map(r=>r.data.output[2].inputs.prompt),["A","B","B","C"]);
  assert.equal(f.controller.getStatus(f.writer).submitted,3);
});

test("early cached completion can arrive before a receipt",async()=>{
  const f=makeFixture({network(i,api){
    event(api,"execution_success","job-"+i);
    return {prompt_id:"job-"+i,number:1};
  }});
  await f.app.queuePrompt(0,1);
  assert.equal(f.controller.getStatus(f.writer).phase,"done");
  assert.equal(f.controller.getStatus(f.writer).completed,2);
});

test("a lost retry receipt cannot be retried again",async()=>{
  const f=makeFixture({rows:["only"],network(i){
    if(i===2)throw new TypeError("connection lost");
    return {prompt_id:"first",number:1};
  }});
  await f.app.queuePrompt(0,1);
  event(f.api,"execution_error","first");
  f.controller.retry(f.writer);
  await flush();
  assert.equal(f.controller.getStatus(f.writer).canRetry,false);
  assert.equal(f.controller.getStatus(f.writer).unknown,1);
  f.controller.retry(f.writer);
  await flush();
  assert.equal(f.requests.length,2);
});

test("a manual export during native queueing cannot take the batch receipt",async()=>{
  let exported;
  const f=makeFixture({afterCompile:async (app)=>{
    exported=await f.app.graphToPrompt();
    await assert.rejects(f.api.queuePrompt(0,exported), /Overlapping queue call/);
  }});
  assert.equal(await f.app.queuePrompt(0,1),true);
  assert.deepEqual(f.requests.map(r=>r.data.output[2].inputs.prompt),["A","B"]);
  assert.equal(exported.workflow.nodes[0].properties.loulanBatch.rows.length,2);
});

test("a removed job frees its window slot and a missed start event is reconciled",async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  const f=makeFixture({rows:Array.from({length:8},(_,i)=>String(i))});
  f.api.getJobDetail=async()=>{};
  f.api.fetchApi=async path=>path.endsWith("job-1") ? {status:404} :
    {status:200,ok:true,json:async()=>({status:"in_progress"})};
  f.api.getQueue=async()=>({Running:[],Pending:[]});
  await f.app.queuePrompt(0,1);
  assert.equal(f.requests.length,6);
  t.mock.timers.tick(20001);
  await flush();
  const s=f.controller.getStatus(f.writer);
  assert.equal(s.unknown,1);
  assert.equal(s.phase,"paused");
  assert.equal(s.running,5);
  f.controller.resume(f.writer);
  await flush();
  assert.equal(f.requests.length,7);
  assert.equal(f.requests[6].data.output[2].inputs.prompt,"6");
});

test("fixed seeds stay fixed and randomized seeds use the native first advancement",async()=>{
  const fixed=makeFixture({mode:"fixed",rows:["A","B","C"]});
  await fixed.app.queuePrompt(0,1);
  assert.deepEqual(fixed.requests.map(r=>r.data.output[3].inputs.seed),[4,4,4]);
  const random=makeFixture({mode:"randomize",rows:["A","B","C"]});
  await random.app.queuePrompt(0,1);
  const seeds=random.requests.map(r=>r.data.output[3].inputs.seed);
  assert.deepEqual(seeds.slice(0,2),[4,77]);
  assert.equal(Number.isInteger(seeds[2]) && seeds[2]>=0 && seeds[2]<100,true);
});

test("two reachable writers are refused but an unrelated reachable output can still run",async()=>{
  const f=makeFixture();
  f.unused.properties.loulanBatch.language="en";
  const compile=f.app.graphToPrompt;
  f.app.graphToPrompt=async(...args)=>{
    const data=await compile(...args);
    data.output[4].inputs.second=["9",0];
    return data;
  };
  assert.equal(await f.app.queuePrompt(0,1),false);
  assert.equal(f.requests.length,0);
  assert.match(f.messages.at(-1),/Multiple prompt writers/);
  assert.equal(await f.app.queuePrompt(0,1,["5"]),true);
  assert.equal(f.requests.length,1);
});

test("a writer connection clears only its STRING widget fallback in generated workflows", async () => {
  const f = makeFixture();
  const inputs = [
    { name: "positive", type: "STRING", link: 1 },
    { name: "negative", type: "STRING", link: null },
    { name: "numeric", type: "INT", link: null },
  ];
  f.sampler.inputs = inputs;
  f.sampler.widgets.push(...inputs.map(({name}) => ({ name })));
  const compile = f.app.graphToPrompt;
  f.app.graphToPrompt = async (...args) => {
    const data = await compile(...args);
    const n = data.workflow.nodes.find(n => n.id === f.sampler.id);
    n.widgets_values.push("previous positive", "fixed negative", 42);
    Object.assign(n.widgets_values_named, { positive: "previous positive", negative: "fixed negative", numeric: 42 });
    Object.assign(data.output[3].inputs, { negative: "fixed negative", numeric: 42 });
    return data;
  };
  assert.equal(await f.app.queuePrompt(0, 1), true);
  for (const {data} of f.requests) {
    const n = data.workflow.nodes.find(n => n.id === f.sampler.id);
    assert.deepEqual(n.widgets_values.slice(1), ["", "fixed negative", 42]);
    assert.deepEqual(n.widgets_values_named, { seed: data.output[3].inputs.seed, positive: "", negative: "fixed negative", numeric: 42 });
    assert.deepEqual(data.output[3].inputs.positive, ["2", 0]);
  }
  const manual = await f.app.graphToPrompt();
  assert.equal(manual.workflow.nodes.find(n => n.id === 3).widgets_values_named.positive, "previous positive");
});

test("promoted STRING fallbacks omit earlier prompts and preserve defaults used by another instance", async () => {
  for (const shared of [false, true]) {
    const f = makeFixture();
    const input = { name: "text", type: "STRING", link: 41 };
    const leaf = { id: 19, type: "Text", inputs: [input], widgets: [{ name: "text" }] };
    const subgraph = { nodes: [leaf], inputNode: { slots: [{ name: "value", linkIds: [41] }] },
      getLink: () => ({ resolve: () => ({ inputNode: leaf, input }) }) };
    function host(id, link) {
      return { id, type: "sub-def", subgraph, inputs: [{ name: "value", type: "STRING", widgetId: "v", link }], widgets: [{name:"value"}] };
    }
    f.graph.nodes = [f.writer, host(30, 85), f.output];
    if (shared) f.graph.nodes.push(host(31, null));
    const textNode = (id, type, name, value) => ({ id, type, widgets_values: [value], widgets_values_named: { [name]: value } });
    f.app.graphToPrompt = async () => {
      const workflow = { nodes: [{id:2,type:writerType}, textNode(30, "sub-def", "value", "old host"), {id:4,type:"Image"}],
        definitions: { subgraphs: [{id:"sub-def", nodes:[textNode(19, "Text", "text", "inner default")]}] } };
      const output = {2:{class_type:writerType,inputs:{prompt:""}}, "30:19":{class_type:"Text",inputs:{text:["2",0]}},
        4:{class_type:"Image",inputs:{data:["30:19",0]}} };
      if (shared) {
        workflow.nodes.push(textNode(31, "sub-def", "value", "other host"));
        output["31:19"] = {class_type:"Text", inputs:{text:"other host"}};
      }
      return {workflow, output};
    };
    assert.equal(await f.app.queuePrompt(0, 1), true);
    for (const {data} of f.requests) {
      const [ , main] = data.workflow.nodes;
      const inner = data.workflow.definitions.subgraphs[0].nodes[0];
      assert.deepEqual(main.widgets_values, [""]);
      assert.equal(main.widgets_values_named.value, "");
      assert.deepEqual(inner.widgets_values, [shared ? "inner default" : ""]);
      assert.equal(inner.widgets_values_named.text, inner.widgets_values[0]);
      assert.deepEqual(data.output["30:19"].inputs.text, ["2", 0]);
      if (shared) assert.deepEqual(data.workflow.nodes.at(-1).widgets_values, ["other host"]);
    }
  }
});
