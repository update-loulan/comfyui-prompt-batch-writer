import assert from "node:assert/strict";
import test from "node:test";
import {
  createState, fromPreset, makeRow, migrateLegacy, normalizeState,
  parseText, readFiles, selectRows, toPreset,
} from "../web/library.js";

test("CSV reads a named column, quotes and original physical row numbers", () => {
  const csv = '\ufeffid, Prompt ,comment\r\n1,"a, ""quoted""\r\nline",ok\r\n2,,skip\r3,"b\rc\nd",ok\n4,z,end';
  const result = parseText(csv, "a.csv");
  assert.deepEqual(result.rows.map(row => [row.text, row.source, row.sourceRow]), [
    ['a, "quoted"\r\nline', "a.csv", 2], ["b\rc\nd", "a.csv", 5], ["z", "a.csv", 8],
  ]);
  assert.equal(result.skipped, 1);
  assert.deepEqual(parseText("a,10\nb,11", "A.CSV").rows.map(row => row.text), ["a", "b"]);
  assert.throws(() => parseText('prompt\none\n"unfinished', "broken.csv"), /line 3/);
});

test("TXT preserves the whole file, JSON accepts lists, named objects and scalar text", () => {
  assert.equal(parseText("  A\r\n\nB  ", "a.txt").rows[0].text, "  A\r\n\nB  ");
  assert.deepEqual(parseText("a\n\nb", "paste.txt", { lines: true }).rows.map(r => r.sourceRow), [1, 3]);
  const entries = ["alpha", "", { content: "A\nB", enabled: false }, { text: "third" }];
  const result = parseText(JSON.stringify({ prompts: entries }), "test.json");
  assert.deepEqual(result.rows.map(r => [r.text, r.enabled, r.sourceRow]), [
    ["alpha", true, 1], ["A\nB", false, 3], ["third", true, 4],
  ]);
  assert.equal(parseText('{"value":"x"}', "a.json").rows[0].text, "x");
  assert.equal(parseText('"x"', "a.json").rows[0].text, "x");
  assert.throws(() => parseText('{"x":3}', "a.json"));
});

test("file preview sorts relative paths naturally, reports failures, keeps large files intact", async () => {
  function file(path, content) {
    return { webkitRelativePath: path, name: path.split("/").pop(), text: async () => content };
  }
  const count = 10010;
  const csv = "id,text\n" + Array.from({ length: count }, (_, i) => `${i},text${i}`).join("\n");
  const preview = await readFiles([
    file("set/10/file.txt", "end"), file("set/2/data.csv", csv),
    file("set/1/malformed.json", "{"), file("set/1/image.png", "ignored"),
  ]);
  assert.equal(preview.rows.length, count + 1);
  assert.equal(preview.rows[0].source, "set/2/data.csv");
  assert.equal(preview.rows[count - 1].sourceRow, count + 1);
  assert.equal(preview.rows[count].text, "end");
  assert.equal(preview.errors.length, 1);
  assert.equal(preview.errors[0].source, "set/1/malformed.json");
});

test("inclusive range and stable manual IDs survive gaps, editing and serialization", () => {
  const state = createState();
  state.rows = ["A", "", "B", "C", "D"].map(s => makeRow(s));
  state.rows[2].enabled = false;
  Object.assign(state.selection, { mode: "range", start: 2, end: 4 });
  assert.deepEqual(selectRows(state).map(r => r.text), ["C"]);
  state.selection.mode = "manual";
  state.selection.manualIds = [state.rows[4].id, state.rows[0].id];
  state.rows.unshift(makeRow("insert"));
  state.rows[1].text = "edited";
  const restored = normalizeState(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(selectRows(restored).map(r => r.text), ["edited", "D"]);
  assert.deepEqual(restored.rows.map(r => r.id), state.rows.map(r => r.id));
});

test("sampling and shuffling use independent seeds and never reorder the library", () => {
  const state = createState();
  state.rows = Array.from({ length: 5000 }, (_, i) => makeRow(String(i)));
  Object.assign(state.selection, { mode: "random", randomCount: 90, sampleSeed: "A", shuffleSeed: "B" });
  const selected = () => selectRows(state).map(r => Number(r.text));
  const sample = selected();
  assert.equal(new Set(sample).size, 90);
  assert.deepEqual([...sample].sort((a, b) => a - b), sample);
  assert.deepEqual(selected(), sample);
  state.selection.shuffle = true;
  const shuffled = selected();
  assert.notDeepEqual(shuffled, sample);
  assert.deepEqual(new Set(shuffled), new Set(sample));
  state.selection.shuffleSeed = "C";
  assert.notDeepEqual(selected(), shuffled);
  assert.deepEqual(new Set(selected()), new Set(sample));
  state.selection.shuffle = false;
  state.selection.sampleSeed = "D";
  assert.notDeepEqual(selected(), sample);
  assert.deepEqual(state.rows.map(r => Number(r.text)), Array.from({ length: 5000 }, (_, i) => i));
  state.selection.randomCount = 10000;
  assert.equal(selected().length, 5000);
  state.selection.randomCount = 0;
  assert.equal(selected().length, 0);
});

test("legacy workflow migration retains all active settings and hidden 100th-slot history", () => {
  const pairs = Array.from({ length: 100 }, () => ["", true]);
  pairs[0] = ["first", true];
  pairs[1] = ["disabled", false];
  pairs[99] = ["last\nline", true];
  const values = ["old carrier", "English", 2, "tag", false, ...pairs.flat(), false, 0, 0, 0, "Old"];
  const state = migrateLegacy(values);
  assert.equal(state.language, "en");
  assert.equal(state.trigger, "tag");
  assert.equal(state.presetEnabled, false);
  assert.equal(state.presetName, "Old");
  assert.equal(state.rows.at(-1).sourceRow, 100);
  assert.equal(state.rows.at(-1).text, "last\nline");
  assert.deepEqual(selectRows(state).map(row => row.text), ["first"]);
  state.selection.mode = "all";
  assert.deepEqual(selectRows(state).map(row => row.text), ["first", "last\nline"]);
  const named = migrateLegacy({ count: 100, prompt_99: "last", enable_99: false });
  assert.equal(named.rows[99].enabled, false);
  assert.equal(named.rows[99].text, "last");
  assert.equal(migrateLegacy(["current carrier"]).rows[0].text, "current carrier");
  assert.equal(migrateLegacy({ prompt: "queued\ntext" }).rows[0].text, "queued\ntext");
  assert.equal(migrateLegacy(undefined), null);
});

test("old named presets and current presets round trip selection, IDs and trigger", () => {
  const old = { name: "2026", trigger: "global", prompts: ["A", "", "B"], enabled: [false, true, true] };
  const state = fromPreset(old);
  assert.deepEqual(selectRows(state).map(row => row.text), ["B"]);
  Object.assign(state.selection, { mode: "manual", manualIds: [state.rows[2].id] });
  assert.deepEqual(fromPreset(toPreset(state, "saved")), state);
  assert.equal(state.trigger, "global");
});
