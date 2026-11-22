// The workflow owns this state. Selection and import previews do not mutate it.
const textFields = ["prompt", "text", "value", "content", "positive_prompt", "提示词", "提示詞"];
const fileOrder = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
const idPrefix = Math.random().toString(36).slice(2);
let nextId = 0;

function rowId() {
  return globalThis.crypto?.randomUUID?.() ?? `${idPrefix}-${++nextId}`;
}

function integer(value, fallback, minimum = 1) {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  return Number.isSafeInteger(n) ? Math.max(minimum, n) : fallback;
}

export function makeRow(text = "", source = "", sourceRow = 1) {
  return { id: rowId(), text, enabled: true, source, sourceRow };
}

export function createState() {
  return {
    version: 2, language: "cn", trigger: "", presetEnabled: true, presetName: "",
    rows: [],
    selection: {
      mode: "all", start: 1, end: 1, manualIds: [],
      randomCount: 1, sampleSeed: "0", shuffle: false, shuffleSeed: "0",
    },
  };
}

function promptText(value) {
  if (typeof value === "string") return value;
  for (const key of textFields) {
    if (typeof value?.[key] === "string") return value[key];
  }
  return "";
}

export function normalizeState(raw) {
  const state = createState();
  if (!raw || typeof raw !== "object") return state;
  state.language = ["en", "English"].includes(raw.language) ? "en" : "cn";
  state.trigger = typeof raw.trigger === "string" ? raw.trigger : "";
  state.presetEnabled = raw.presetEnabled !== false;
  state.presetName = typeof raw.presetName === "string" ? raw.presetName : "";
  const ids = new Set();
  if (Array.isArray(raw.rows)) {
    state.rows = raw.rows.map((row, index) => {
      let id = row?.id;
      if (typeof id !== "string" || !id || ids.has(id)) id = rowId();
      ids.add(id);
      return {
        id, text: promptText(row), enabled: row?.enabled !== false,
        source: typeof row?.source === "string" ? row.source : "",
        sourceRow: integer(row?.sourceRow, index + 1),
      };
    });
  }
  const s = raw.selection || {};
  state.selection = {
    mode: ["all", "range", "random", "manual"].includes(s.mode) ? s.mode : "all",
    start: integer(s.start, 1), end: integer(s.end, Math.max(1, state.rows.length)),
    manualIds: Array.isArray(s.manualIds) ? [...new Set(s.manualIds.filter(id => ids.has(id)))] : [],
    randomCount: integer(s.randomCount, 1, 0), sampleSeed: String(s.sampleSeed ?? "0"),
    shuffle: s.shuffle === true, shuffleSeed: String(s.shuffleSeed ?? "0"),
  };
  return state;
}

// Hash arbitrary seed text with FNV-1a, then generate uniform fractions with Mulberry32.
function seededRandom(seed) {
  let word = 2166136261;
  const text = String(seed);
  for (let i = 0; i < text.length; i++) word = Math.imul(word ^ text.charCodeAt(i), 16777619);
  return () => {
    word = (word + 0x6d2b79f5) | 0;
    let n = Math.imul(word ^ (word >>> 15), 1 | word);
    n ^= n + Math.imul(n ^ (n >>> 7), 61 | n);
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
  };
}

export function selectRows(state) {
  const s = state.selection;
  const manual = s.mode === "manual" ? new Set(s.manualIds) : null;
  let rows = state.rows.filter((row, index) => {
    if (!row.enabled || !row.text.trim()) return false;
    if (manual) return manual.has(row.id);
    return s.mode !== "range" || (index + 1 >= s.start && index + 1 <= s.end);
  });
  if (s.mode === "random" && s.randomCount < rows.length) {
    const random = seededRandom(s.sampleSeed);
    let remaining = Math.max(0, s.randomCount);
    const total = rows.length;
    rows = rows.filter((_, index) => {
      // Each remaining row has an equal chance of filling the remaining slots.
      if (random() * (total - index) >= remaining) return false;
      remaining--;
      return true;
    });
  }
  if (s.shuffle) {
    const random = seededRandom(s.shuffleSeed);
    for (let i = rows.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [rows[i], rows[j]] = [rows[j], rows[i]];
    }
  }
  return rows;
}

function* csvRecords(text) {
  let fields = [], field = "";
  let quoted = false, closed = false;
  let line = 1, start = 1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const newline = ch === "\n" || ch === "\r";
    if (quoted && ch === '"') {
      if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        quoted = false;
        closed = true;
      }
    } else if (newline) {
      const crlf = ch === "\r" && text[i + 1] === "\n";
      if (quoted) {
        field += crlf ? "\r\n" : ch;
      } else {
        fields.push(field);
        yield { fields, start };
        fields = [];
        field = "";
        closed = false;
        start = line + 1;
      }
      if (crlf) i++;
      line++;
    } else if (quoted) {
      field += ch;
    } else if (ch === ",") {
      fields.push(field);
      field = "";
      closed = false;
    } else if (closed) {
      if (ch !== " " && ch !== "\t") throw new Error(`Unexpected text after CSV quote at line ${line}`);
    } else if (ch === '"' && field === "") {
      quoted = true;
    } else {
      field += ch;
    }
  }
  if (quoted) throw new Error(`Unclosed CSV quote at line ${start}`);
  if (fields.length || field || closed) {
    fields.push(field);
    yield { fields, start };
  }
}

export function parseText(input, filename, { lines = false } = {}) {
  const text = String(input ?? "").replace(/^\uFEFF/, "");
  const extension = filename.split(".").pop().toLowerCase();
  const rows = [];
  let skipped = 0;
  function add(value, number, enabled = true) {
    if (!value.trim()) {
      skipped++;
      return;
    }
    const row = makeRow(value, filename, number);
    row.enabled = enabled !== false;
    rows.push(row);
  }
  if (extension === "csv") {
    let column = null;
    for (const { fields, start } of csvRecords(text)) {
      if (column === null) {
        if (fields.every(field => !field.trim())) {
          skipped++;
          continue;
        }
        column = fields.findIndex(field => textFields.includes(field.trim().toLowerCase()));
        if (column >= 0) continue;
        column = 0;
      }
      add(fields[column] || "", start);
    }
  } else if (extension === "json") {
    const data = JSON.parse(text);
    let items = Array.isArray(data) ? data : data?.prompts ?? data?.rows;
    if (typeof data === "string" || textFields.some(key => typeof data?.[key] === "string")) items ??= [data];
    if (!Array.isArray(items)) throw new Error("Expected a prompt string, object or array");
    items.forEach((item, i) => add(promptText(item), i + 1, item?.enabled ?? data?.enabled?.[i]));
  } else if (extension === "txt") {
    if (lines) {
      text.split(/\r\n|\r|\n/).forEach((line, i) => add(line, i + 1));
    } else {
      add(text, 1);
    }
  } else {
    throw new Error(`Unsupported file format: ${extension}`);
  }
  return { rows, skipped };
}

export async function readFiles(files, options) {
  const supported = Array.from(files, file => ({ file, source: file.webkitRelativePath || file.name }))
    .filter(({ source }) => /\.(txt|csv|json)$/i.test(source))
    .sort((a, b) => fileOrder.compare(a.source, b.source) ||
      (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
  const rows = [], errors = [];
  let skipped = 0;
  for (const { file, source } of supported) {
    try {
      const result = parseText(await file.text(), source, options);
      for (const row of result.rows) rows.push(row);
      skipped += result.skipped;
    } catch (error) {
      errors.push({ source, message: String(error.message || error) });
    }
  }
  return { rows, errors, skipped };
}

function applyVisibleCount(state, count) {
  state.selection.end = Math.max(1, count);
  if (state.rows.length > count) state.selection.mode = "range";
}

export function fromPreset(preset) {
  if (Array.isArray(preset?.rows)) return normalizeState(preset);
  const items = Array.isArray(preset) ? preset : preset?.prompts;
  if (!Array.isArray(items)) throw new Error("Preset has no prompt list");
  const state = normalizeState({
    trigger: preset.trigger,
    rows: items.map((item, i) => ({
      text: promptText(item), enabled: item?.enabled ?? preset.enabled?.[i],
      source: typeof preset.name === "string" ? preset.name : "", sourceRow: i + 1,
    })),
  });
  applyVisibleCount(state, Math.min(integer(preset.count, items.length), items.length));
  return state;
}

export function toPreset(state, name) {
  return { ...normalizeState(state), name };
}

// 0.1.1 stored [carrier, language, count, trigger, clear, text0, enabled0, ...].
// Some workflow serializers stored names or omitted the nonserializing buttons.
export function migrateLegacy(widgets) {
  const values = widgets?.widgets_values ?? widgets;
  if (!values || typeof values !== "object") return null;
  let named = values;
  if (Array.isArray(values)) {
    if (values.length === 1 && typeof values[0] === "string") {
      named = { prompt: values[0] };
    } else if (values.length && typeof values[0]?.name === "string") {
      named = Object.fromEntries(values.map(w => [w.name, w.value]));
    } else {
      const languageIndex = [1, 0].find(i => ["中文", "English"].includes(values[i]));
      if (languageIndex === undefined) return null;
      const first = languageIndex + 4;
      named = { langue: values[languageIndex], count: values[languageIndex + 1], trigger: values[languageIndex + 2] };
      for (let i = 0; i < 100; i++) {
        named[`prompt_${i}`] = values[first + i * 2];
        named[`enable_${i}`] = values[first + i * 2 + 1];
      }
      const afterRows = first + 200;
      named.preset_enabled = values[afterRows];
      named.presets = [values[afterRows + 4], values[afterRows + 1]].find(v => typeof v === "string");
    }
  }
  if (!("langue" in named || Object.keys(named).some(k => /^prompt_\d+$/.test(k)))) {
    if (typeof named.prompt !== "string") return null;
    return normalizeState({ rows: named.prompt.trim() ? [named.prompt] : [] });
  }
  const count = Math.min(100, integer(named.count, 1));
  const state = normalizeState({
    trigger: named.trigger, language: named.langue, presetEnabled: named.preset_enabled, presetName: named.presets,
  });
  for (let i = 0; i < 100; i++) {
    const text = typeof named[`prompt_${i}`] === "string" ? named[`prompt_${i}`] : "";
    const enabled = named[`enable_${i}`] !== false;
    if (i >= count && text === "" && enabled) continue;
    state.rows.push({ ...makeRow(text, "", i + 1), enabled });
  }
  applyVisibleCount(state, count);
  return state;
}
