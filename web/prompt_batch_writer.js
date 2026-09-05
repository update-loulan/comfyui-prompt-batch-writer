import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_CLASS = "Loulan-prompt";
const MAX_PROMPTS = 100;

const I18N = {
  cn: {
    langue: "语言",
    count: "提示词框数量",
    trigger: "全局TAG/触发词",
    clear_on_shrink: "清理历史输入记录",
    preset_enabled: "启用预设",
    presets: "预设",
    import: "输入文件",
    clear: "全部清理",
    open_presets: "打开预设文件夹",
    preset_apply: "应用预设",
    preset_save: "保存为预设",
    enable: "启用",
    on: "开",
    off: "关",
    clear_on: "清除",
    clear_off: "保留",
    import_folder: "输入文件夹",
    no_files: "没有找到 txt/csv/json 文件",
    no_prompts: "未能解析出提示词",
    imported: "已导入 {0} 条提示词（共解析 {1} 条，忽略 {2} 条）",
    import_errors: "{0} 个文件解析失败：{1}",
    no_valid_prompts: "没有有效的提示词（全部为空或已禁用），已取消本次排队",
    multiple_nodes: "检测到多个 Loulan-prompt 节点参与执行，暂不支持多节点，已取消本次排队（请只保留一个节点）",
    submitting: "正在提交批处理，请稍候",
    submit_start: "批量提交 {0} 条提示词 × {1} 次 = {2} 条任务",
    submit_failed: "提交到第 {0} 条时失败，已停止（成功提交 {1} 条）",
    preset_empty: "请先选择一个预设",
    preset_invalid: "预设无效或为空",
    preset_applied: "已应用预设",
    no_prompts_to_save: "当前没有可保存的提示词",
    preset_save_failed: "保存预设失败：{0}",
    preset_saved: "已保存预设「{0}」",
    open_presets_failed: "打开预设文件夹失败：{0}",
    reset_done: "已恢复到节点初始状态",
  },
  en: {
    langue: "Language",
    count: "Prompt Count",
    trigger: "Global TAG / Trigger",
    clear_on_shrink: "Clear History",
    preset_enabled: "Enable Presets",
    presets: "Presets",
    import: "Import File",
    clear: "Clear All",
    open_presets: "Open Presets Folder",
    preset_apply: "Apply Preset",
    preset_save: "Save as Preset",
    enable: "Enable",
    on: "On",
    off: "Off",
    clear_on: "Clear",
    clear_off: "Keep",
    import_folder: "Import Folder",
    no_files: "No txt/csv/json files found",
    no_prompts: "No prompts could be parsed",
    imported: "Imported {0} prompts (parsed {1}, ignored {2})",
    import_errors: "{0} files failed to parse: {1}",
    no_valid_prompts: "No valid prompts (all empty or disabled), queue cancelled",
    multiple_nodes: "Multiple Loulan-prompt nodes detected; multi-node is not supported yet, queue cancelled (keep only one node)",
    submitting: "Batch submit in progress, please wait",
    submit_start: "Submitting {0} prompts × {1} = {2} tasks",
    submit_failed: "Failed at prompt {0}, stopped (submitted {1})",
    preset_empty: "Select a preset first",
    preset_invalid: "Preset is invalid or empty",
    preset_applied: "Preset applied",
    no_prompts_to_save: "No prompts to save",
    preset_save_failed: "Failed to save preset: {0}",
    preset_saved: "Preset \"{0}\" saved",
    open_presets_failed: "Failed to open the presets folder: {0}",
    reset_done: "Restored to initial state",
  },
};

function t(lang, key) {
  return (I18N[lang] && I18N[lang][key]) || I18N.en[key] || key;
}

function tf(lang, key, ...args) {
  let s = t(lang, key);
  args.forEach((a, i) => {
    s = s.split("{" + i + "}").join(a == null ? "" : String(a));
  });
  return s;
}

function widgetByName(node, name) {
  return (node.widgets || []).find((w) => w.name === name);
}

function widgetByKey(node, key) {
  return (node.widgets || []).find((w) => w._pbKey === key);
}

function getLang(node) {
  const w = widgetByName(node, "langue");
  if (!w) return "cn";
  return String(w.value || "").indexOf("中") !== -1 ? "cn" : "en";
}

function getCount(node) {
  const w = widgetByName(node, "count");
  const n = w ? parseInt(w.value, 10) : 1;
  return Math.min(Math.max(Number.isNaN(n) ? 1 : n, 1), MAX_PROMPTS);
}

function getTrigger(node) {
  const w = widgetByName(node, "trigger");
  return w ? String(w.value || "") : "";
}

function getPrompt(node, i) {
  const w = widgetByName(node, "prompt_" + i);
  return w ? String(w.value || "") : "";
}

function setPrompt(node, i, v) {
  const w = widgetByName(node, "prompt_" + i);
  if (w) {
    w.value = v;
    if (w.inputEl) w.inputEl.title = String(v == null ? "" : v);
  }
}

function setEnabled(node, i, v) {
  const w = widgetByName(node, "enable_" + i);
  if (w) w.value = !!v;
}

function isEnabled(node, i) {
  const w = widgetByName(node, "enable_" + i);
  return w ? w.value !== false : true;
}

function notify(message) {
  try {
    const toast = app.extensionManager && app.extensionManager.toast;
    if (toast && toast.add) {
      toast.add({ severity: "info", summary: message, life: 3000 });
      return;
    }
  } catch (e) {
    /* ignore */
  }
  console.info("[Loulan-prompt]", message);
}

function refreshNodeSize(node) {
  if (node.setSize && node.computeSize) {
    const size = node.computeSize();
    size[0] = Math.max(size[0], (node.size && node.size[0]) || 0, 300);
    node.setSize(size);
  }
  node.setDirtyCanvas && node.setDirtyCanvas(true, true);
}

/** Whether the node actually participates in the current execution. */
function isNodeActive(node) {
  // mode 2 = muted (NEVER), mode 4 = bypassed (BYPASS)
  if (node.mode === 2 || node.mode === 4) return false;
  const outs = node.outputs || [];
  return outs.some((o) => o.links && o.links.length > 0);
}

function applyI18n(node) {
  const lang = getLang(node);
  for (const [name, key] of Object.entries({
    langue: "langue",
    count: "count",
    trigger: "trigger",
    clear_on_shrink: "clear_on_shrink",
    preset_enabled: "preset_enabled",
    presets: "presets",
  })) {
    const w = widgetByName(node, name);
    if (w) w.label = t(lang, key);
  }
  for (const w of node.widgets || []) {
    if (w._pbKey) w.name = t(lang, w._pbKey);
  }
  const pLabel = lang === "cn" ? "提示词 " : "Prompt ";
  const eLabel = t(lang, "enable");
  for (let i = 0; i < MAX_PROMPTS; i++) {
    const p = widgetByName(node, "prompt_" + i);
    if (p) p.label = pLabel + (i + 1);
    const e = widgetByName(node, "enable_" + i);
    if (e) e.label = eLabel + " " + (i + 1);
  }
  const presetW = widgetByName(node, "preset_enabled");
  if (presetW && presetW.options) {
    presetW.options.on = t(lang, "on");
    presetW.options.off = t(lang, "off");
  }
  const clearW = widgetByName(node, "clear_on_shrink");
  if (clearW && clearW.options) {
    clearW.options.on = t(lang, "clear_on");
    clearW.options.off = t(lang, "clear_off");
  }
  node.setDirtyCanvas && node.setDirtyCanvas(true, true);
}

function applyVisibility(node) {
  const count = getCount(node);
  for (let i = 0; i < MAX_PROMPTS; i++) {
    const hide = i >= count;
    const p = widgetByName(node, "prompt_" + i);
    if (p) p.hidden = hide;
    const e = widgetByName(node, "enable_" + i);
    if (e) e.hidden = hide;
  }
  refreshNodeSize(node);
}

function resetEnables(node) {
  for (let i = 0; i < MAX_PROMPTS; i++) setEnabled(node, i, true);
}

function applyFeatureToggles(node) {
  const presetOn = widgetByName(node, "preset_enabled");
  const showPreset = !presetOn || !!presetOn.value;

  const presetCombo = widgetByName(node, "presets");
  if (presetCombo) presetCombo.hidden = !showPreset;
  for (const k of ["preset_apply", "preset_save", "open_presets"]) {
    const w = widgetByKey(node, k);
    if (w) w.hidden = !showPreset;
  }

  refreshNodeSize(node);
}

function activePrompts(node) {
  const trigger = getTrigger(node);
  const count = getCount(node);
  const items = [];
  for (let i = 0; i < count; i++) {
    if (!isEnabled(node, i)) continue;
    const line = getPrompt(node, i).trim();
    if (!line) continue;
    items.push(trigger ? trigger + "\n" + line : line);
  }
  return items;
}

// ---------------------------------------------------------------------------
// File import (folder of txt/csv/json)
// ---------------------------------------------------------------------------

/** Parse the first field of a CSV line, handling quoted fields with commas. */
function parseFirstCsvField(line) {
  const s = String(line || "").trim();
  if (!s.startsWith('"')) {
    return s.split(",")[0].trim();
  }
  let out = "";
  let i = 1;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '"') {
      if (s[i + 1] === '"') {
        out += '"';
        i += 2;
      } else {
        i++;
        break;
      }
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

function parsePromptFile(text, filename) {
  const ext = (filename || "").split(".").pop().toLowerCase();
  const out = [];
  let error = null;

  if (ext === "json") {
    try {
      const data = JSON.parse(text);
      const arr = Array.isArray(data) ? data : Array.isArray(data && data.prompts) ? data.prompts : null;
      if (!arr) {
        error = "unsupported JSON structure";
      } else {
        for (const item of arr) {
          if (typeof item === "string") out.push(item);
          else if (item && typeof item === "object") {
            const v = item.prompt ?? item.text ?? item.value ?? item.content ?? "";
            if (v !== "") out.push(v);
          }
        }
      }
    } catch (e) {
      error = "invalid JSON";
    }
  } else if (ext === "csv") {
    const lines = text.split(/\r?\n/);
    let first = true;
    for (const raw of lines) {
      if (!raw.trim()) continue;
      const field = parseFirstCsvField(raw);
      if (first && /^(prompt|text|value|content)$/i.test(field)) {
        first = false;
        continue;
      }
      first = false;
      if (field) out.push(field);
    }
  } else {
    // txt: one file = one prompt (whole content, trimmed)
    const p = String(text || "").trim();
    if (p) out.push(p);
  }

  return {
    prompts: out.map((s) => String(s == null ? "" : s)).filter((s) => s.trim() !== ""),
    error,
  };
}

async function handleImportFiles(node, files) {
  const filtered = files
    .filter((f) => /\.(txt|csv|json)$/i.test(f.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (!filtered.length) {
    notify(t(getLang(node), "no_files"));
    return;
  }
  const prompts = [];
  const failed = [];
  for (const f of filtered) {
    let text = null;
    try {
      text = await f.text();
    } catch (e) {
      failed.push(f.name);
      continue;
    }
    const r = parsePromptFile(text, f.name);
    if (r.error) failed.push(f.name);
    else prompts.push(...r.prompts);
  }
  if (!prompts.length) {
    notify(t(getLang(node), "no_prompts"));
    if (failed.length) notify(tf(getLang(node), "import_errors", failed.length, failed.slice(0, 5).join(", ")));
    return;
  }
  const total = prompts.length;
  const count = Math.min(total, MAX_PROMPTS);
  const countWidget = widgetByName(node, "count");
  if (countWidget) countWidget.value = count;
  node._pbLastCount = count;
  for (let i = 0; i < MAX_PROMPTS; i++) {
    setPrompt(node, i, i < count ? prompts[i] : "");
  }
  resetEnables(node);
  applyVisibility(node);
  notify(tf(getLang(node), "imported", count, total, total - count));
  if (failed.length) notify(tf(getLang(node), "import_errors", failed.length, failed.slice(0, 5).join(", ")));
}

function importFiles(node) {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.accept = ".txt,.csv,.json,text/plain,text/csv,application/json";
  input.style.display = "none";
  input.onchange = () => {
    const files = Array.from(input.files || []);
    input.remove();
    if (files.length) handleImportFiles(node, files);
  };
  document.body.appendChild(input);
  input.click();
}

function importFolder(node) {
  const input = document.createElement("input");
  input.type = "file";
  input.webkitdirectory = true;
  input.style.display = "none";
  input.onchange = () => {
    const files = Array.from(input.files || []);
    input.remove();
    if (files.length) handleImportFiles(node, files);
  };
  document.body.appendChild(input);
  input.click();
}

function clearPrompts(node) {
  for (let i = 0; i < MAX_PROMPTS; i++) setPrompt(node, i, "");
  const trigger = widgetByName(node, "trigger");
  if (trigger) trigger.value = "";
  const countWidget = widgetByName(node, "count");
  if (countWidget) countWidget.value = 1;
  node._pbLastCount = 1;
  resetEnables(node);
  applyVisibility(node);
  notify(t(getLang(node), "reset_done"));
}

// ---------------------------------------------------------------------------
// Presets (bundled presets.json + user-dir folder via backend)
// ---------------------------------------------------------------------------

let bundledPresets = [];
let folderPresets = [];

async function loadBundledPresets() {
  try {
    const url = new URL("presets.json", import.meta.url);
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      bundledPresets = Array.isArray(data) ? data : [];
    }
  } catch (e) {
    bundledPresets = [];
  }
}

async function loadFolderPresets() {
  try {
    const res = await api.fetchApi("/loulan/presets");
    if (res.ok) {
      const data = await res.json();
      folderPresets = Array.isArray(data) ? data : [];
    }
  } catch (e) {
    folderPresets = [];
  }
}

function allPresets() {
  return [...bundledPresets, ...folderPresets];
}

function refreshPresetsCombo(node) {
  const combo = widgetByName(node, "presets");
  if (!combo) return;
  combo.options.values = allPresets().map((p) => p.name);
  if (!combo.options.values.includes(combo.value)) {
    combo.value = combo.options.values[0] || "";
  }
}

function refreshAllPresetCombos() {
  for (const n of app.graph._nodes || []) {
    if (n.comfyClass === NODE_CLASS || n.type === NODE_CLASS) {
      refreshPresetsCombo(n);
    }
  }
}

function uniqueName(base, existing) {
  let name = base;
  let n = 2;
  while (existing.includes(name)) {
    name = `${base} (${n++})`;
  }
  return name;
}

function applyPreset(node) {
  const combo = widgetByName(node, "presets");
  const preset = allPresets().find((p) => p.name === combo.value);
  if (!preset) {
    notify(t(getLang(node), "preset_empty"));
    return;
  }
  const rawPrompts = Array.isArray(preset.prompts) ? preset.prompts : [];
  if (!rawPrompts.some((p) => typeof p === "string" && p.trim())) {
    notify(t(getLang(node), "preset_invalid"));
    return;
  }
  let count = typeof preset.count === "number" ? preset.count : rawPrompts.length;
  count = Math.min(Math.max(count, 1), MAX_PROMPTS);
  const countWidget = widgetByName(node, "count");
  if (countWidget) countWidget.value = count;
  node._pbLastCount = count;
  const enabled = Array.isArray(preset.enabled) ? preset.enabled : null;
  for (let i = 0; i < MAX_PROMPTS; i++) {
    setPrompt(node, i, i < count ? String(rawPrompts[i] || "") : "");
    setEnabled(node, i, enabled ? enabled[i] !== false : true);
  }
  applyVisibility(node);
  notify(t(getLang(node), "preset_applied"));
}

async function savePreset(node) {
  const trigger = getTrigger(node);
  const count = getCount(node);
  const prompts = [];
  const enabled = [];
  for (let i = 0; i < count; i++) {
    prompts.push(getPrompt(node, i));
    enabled.push(isEnabled(node, i));
  }
  if (!prompts.some((p) => p.trim())) {
    notify(t(getLang(node), "no_prompts_to_save"));
    return;
  }
  const name = uniqueName("Preset " + (folderPresets.length + 1), allPresets().map((p) => p.name));
  const preset = { name, trigger, count, prompts, enabled };
  try {
    const res = await api.fetchApi("/loulan/save_preset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, preset }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      notify(tf(getLang(node), "preset_save_failed", (data && data.error) || res.status));
      return;
    }
    await loadFolderPresets();
    refreshAllPresetCombos();
    notify(tf(getLang(node), "preset_saved", name));
  } catch (e) {
    notify(tf(getLang(node), "preset_save_failed", (e && e.message) || e));
  }
}

async function openPresetsFolder(node) {
  try {
    const res = await api.fetchApi("/loulan/open_presets", { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      notify(tf(getLang(node), "open_presets_failed", (data && data.error) || res.status));
    }
  } catch (e) {
    notify(tf(getLang(node), "open_presets_failed", (e && e.message) || e));
  }
}

// ---------------------------------------------------------------------------
// Node construction
// ---------------------------------------------------------------------------

function addButton(node, key, callback) {
  const w = node.addWidget("button", t(getLang(node), key), 0, () => callback(node));
  w._pbKey = key;
  if (w.inputEl) w.inputEl.classList.add("loulan-prompt-btn");
  return w;
}

function addPromptWidget(node, i) {
  const w = node.addWidget("text", "prompt_" + i, "", null, {});
  if (w.inputEl) {
    w.inputEl.title = "";
    w.inputEl.addEventListener("input", () => {
      w.inputEl.title = w.value;
    });
  }
  return w;
}

function buildNode(node) {
  const carrier = widgetByName(node, "prompt");
  if (carrier) {
    carrier.hidden = true;
    carrier.computeSize = () => [0, -4];
    if (carrier.inputEl) {
      carrier.inputEl.style.display = "none";
    }
  }

  if (!widgetByName(node, "langue")) {
    node.addWidget("combo", "langue", "中文", () => applyI18n(node), { values: ["中文", "English"] });
  }
  if (!widgetByName(node, "count")) {
    node.addWidget("number", "count", 1, () => onCountChange(node), { min: 1, max: MAX_PROMPTS, step: 1, precision: 0 });
  }
  if (!widgetByName(node, "trigger")) {
    node.addWidget("text", "trigger", "", null, {});
  }
  if (!widgetByName(node, "clear_on_shrink")) {
    node.addWidget("toggle", "clear_on_shrink", false, null, { on: "清除", off: "保留" });
  }

  for (let i = 0; i < MAX_PROMPTS; i++) {
    if (!widgetByName(node, "prompt_" + i)) {
      addPromptWidget(node, i);
    }
    if (!widgetByName(node, "enable_" + i)) {
      node.addWidget("toggle", "enable_" + i, true, null, {});
    }
  }

  if (!widgetByName(node, "preset_enabled")) {
    node.addWidget("toggle", "preset_enabled", true, () => applyFeatureToggles(node), { on: "开", off: "关" });
  }

  if (!widgetByKey(node, "import")) addButton(node, "import", importFiles);
  if (!widgetByKey(node, "import_folder")) addButton(node, "import_folder", importFolder);
  if (!widgetByKey(node, "clear")) addButton(node, "clear", clearPrompts);

  if (!widgetByName(node, "presets")) {
    node.addWidget("combo", "presets", "", null, { values: [] });
  }
  if (!widgetByKey(node, "preset_apply")) addButton(node, "preset_apply", applyPreset);
  if (!widgetByKey(node, "preset_save")) addButton(node, "preset_save", savePreset);
  if (!widgetByKey(node, "open_presets")) addButton(node, "open_presets", openPresetsFolder);

  refreshPresetsCombo(node);
  applyI18n(node);
  applyVisibility(node);
  applyFeatureToggles(node);
}

function onCountChange(node) {
  const newCount = getCount(node);
  const lastCount = typeof node._pbLastCount === "number" ? node._pbLastCount : newCount;
  if (newCount < lastCount) {
    const clearWidget = widgetByName(node, "clear_on_shrink");
    if (clearWidget && clearWidget.value) {
      for (let i = newCount; i < lastCount; i++) setPrompt(node, i, "");
    }
  }
  node._pbLastCount = newCount;
  applyVisibility(node);
}

// ---------------------------------------------------------------------------
// Queue splitting: one active prompt => one queue item (× batchCount)
// ---------------------------------------------------------------------------

let queuePromptWrapped = false;
let batchSubmitting = false;

function wrapQueuePrompt() {
  if (queuePromptWrapped) return;
  queuePromptWrapped = true;

  const originalQueuePrompt = app.queuePrompt.bind(app);

  app.queuePrompt = async function (number, batchCount, ...args) {
    const nodes = (app.graph._nodes || []).filter((n) => n.comfyClass === NODE_CLASS || n.type === NODE_CLASS);
    const activeNodes = nodes.filter(isNodeActive);

    if (activeNodes.length === 0) {
      return originalQueuePrompt(number, batchCount, ...args);
    }

    if (batchSubmitting) {
      notify(t(getLang(activeNodes[0]), "submitting"));
      return;
    }

    const multi = activeNodes.filter((n) => activePrompts(n).length > 0);

    if (multi.length === 0) {
      notify(t(getLang(activeNodes[0]), "no_valid_prompts"));
      return;
    }

    if (multi.length > 1) {
      notify(t(getLang(multi[0]), "multiple_nodes"));
      return;
    }

    const node = multi[0];
    const items = activePrompts(node);
    const carrier = widgetByName(node, "prompt");
    if (!carrier) {
      return originalQueuePrompt(number, batchCount, ...args);
    }

    const times = Math.max(1, batchCount || 1);
    if (items.length > 1 || times > 1) {
      notify(tf(getLang(node), "submit_start", items.length, times, items.length * times));
    }

    batchSubmitting = true;
    let successCount = 0;
    const saved = carrier.value;
    // number semantics (ComfyUI): 0 or missing = queue to front, -1 = append to
    // back. Enqueueing to the front prepends, so reverse to keep prompt order.
    const toFront = number === 0 || number === undefined || number === null;
    const ordered = toFront ? items.slice().reverse() : items;

    try {
      for (const text of ordered) {
        carrier.value = text;
        try {
          const res = await originalQueuePrompt(number, times, ...args);
          // Some ComfyUI versions report validation failures in the response
          // instead of throwing.
          if (res && typeof res === "object" && res.node_errors && Object.keys(res.node_errors).length > 0) {
            notify(tf(getLang(node), "submit_failed", successCount + 1, successCount));
            break;
          }
          successCount++;
        } catch (e) {
          notify(tf(getLang(node), "submit_failed", successCount + 1, successCount));
          break;
        }
      }
    } finally {
      carrier.value = saved;
      batchSubmitting = false;
      node.setDirtyCanvas && node.setDirtyCanvas(true, true);
    }
  };
}

function injectStyles() {
  if (document.getElementById("loulan-prompt-styles")) return;
  const style = document.createElement("style");
  style.id = "loulan-prompt-styles";
  style.textContent = ".loulan-prompt-btn { text-align: left !important; padding-left: 6px !important; }";
  document.head.appendChild(style);
}

app.registerExtension({
  name: "comfyui-prompt-batch-writer",

  async setup() {
    injectStyles();
    await Promise.all([loadBundledPresets(), loadFolderPresets()]);
    wrapQueuePrompt();
  },

  nodeCreated(node) {
    if (node.comfyClass === NODE_CLASS || node.type === NODE_CLASS) {
      buildNode(node);
    }
  },

  loadedGraphNode(node) {
    if (node.comfyClass === NODE_CLASS || node.type === NODE_CLASS) {
      node._pbLastCount = getCount(node);
      refreshPresetsCombo(node);
      applyI18n(node);
      applyVisibility(node);
      applyFeatureToggles(node);
    }
  },
});
