import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import {
  createState, normalizeState, makeRow, selectRows, readFiles, parseText,
  migrateLegacy, fromPreset, toPreset,
} from "./library.js";
import { installBatchQueue } from "./queue.js";

const NODE = "Loulan-prompt";
const PAGE_SIZE = 25;
const editors = new WeakMap();
const presetEvents = new EventTarget();
let presets = [];
let presetsRequested = false;
let queue;

function isWriter(node) {
  return node.comfyClass === NODE || node.type === NODE;
}

function notify(message) {
  if (app.extensionManager?.toast?.add) {
    app.extensionManager.toast.add({ severity: "info", summary: String(message), life: 4500 });
  } else {
    console.info("[Loulan-prompt]", message);
  }
}

function element(tag, cls, text) {
  const out = document.createElement(tag);
  if (cls) out.className = cls;
  if (text != null) out.textContent = text;
  return out;
}

function control(el, role) {
  el.dataset.role = role;
  return el;
}

function button(text, role, click) {
  const el = control(element("button", "", text), role);
  el.type = "button";
  el.addEventListener("click", click);
  return el;
}

function input(type, role, value, onInput) {
  const el = control(element("input"), role);
  el.type = type;
  if (type === "checkbox") el.checked = !!value;
  else el.value = value ?? "";
  el.addEventListener(type === "checkbox" ? "change" : "input", () => {
    onInput(type === "checkbox" ? el.checked : el.value);
  });
  return el;
}

function select(role, choices, value, onChange) {
  const el = control(element("select"), role);
  for (const [key, label] of choices) el.add(new Option(label, key));
  el.value = value;
  el.addEventListener("change", () => onChange(el.value));
  return el;
}

function label(text, field) {
  const el = element("label", "ll-label");
  el.append(text, field);
  return el;
}

function line(...children) {
  const el = element("div", "ll-line");
  el.append(...children);
  return el;
}

function shortText(text) {
  return String(text).replace(/\s+/g, " ").trim().slice(0, 110);
}

async function fetchPresets() {
  presetsRequested = true;
  const result = await Promise.allSettled([
    fetch(new URL("./presets.json", import.meta.url)).then(response => response.json()),
    api.fetchApi("/loulan/presets").then(response => {
      if (!response.ok) throw new Error(String(response.status));
      return response.json();
    }),
  ]);
  presets = result.flatMap(item => item.status === "fulfilled" && Array.isArray(item.value) ? item.value : [])
    .filter(preset => typeof preset?.name === "string");
  presetEvents.dispatchEvent(new Event("update"));
}

function configureState(node, info) {
  const stored = info?.properties?.loulanBatch;
  const named = info?.widgets_values_named;
  const positional = info?.widgets_values;
  const namedLegacy = named && ("langue" in named || Object.keys(named).some(key => /^prompt_\d+$/.test(key)));
  const migrated = !stored && (namedLegacy ? migrateLegacy(named) : migrateLegacy(positional) || migrateLegacy(named));
  node.properties.loulanBatch = stored ? normalizeState(stored) : migrated || createState();
}

function buildEditor(node) {
  if (editors.has(node)) return;
  const carrier = node.widgets?.find(widget => widget.name === "prompt");
  if (carrier) {
    carrier.hidden = true;
    carrier.computeSize = () => [0, -4];
    if (carrier.inputEl) carrier.inputEl.style.display = "none";
  }
  node.properties ??= {};
  node.properties.loulanBatch ??= createState();
  const state = () => node.properties.loulanBatch;
  const tr = (cn, en) => state().language === "en" ? en : cn;
  let activeTab = "library";
  let page = 0;
  let query = "";
  let selected = [];
  let filtered = [];
  let previewOpen = false;
  let paste = "";
  let format = "txt";
  let splitLines = true;
  let fileLines = false;
  let staged = null;
  let importToken = 0;
  let presetDraft = "";
  let errorText = "";
  let queueState = null;

  const root = element("div", "loulan-editor");
  const head = element("div", "ll-head");
  const tabs = element("nav", "ll-tabs");
  const options = element("div", "ll-options");
  const summary = control(element("div", "ll-summary"), "preview");
  const body = element("section", "ll-body");
  const note = element("output", "ll-note");
  const status = control(element("footer", "ll-status"), "status");
  root.append(head, options, summary, tabs, body, note, status);
  root.addEventListener("keydown", event => event.stopPropagation());
  root.addEventListener("pointerdown", event => event.stopPropagation());
  root.addEventListener("wheel", event => event.stopPropagation(), { passive: true });

  const widget = node.addDOMWidget("loulan_editor", "loulan_editor", root, {
    serialize: false, hideOnZoom: false, getMinHeight: () => 430,
  });
  widget.serialize = false;

  function changed() {
    node.graph?.change?.();
  }

  // Let the graph's history capture committed fields even when their change
  // handler rebuilds the current tab, removing the control from the document.
  const workflowFields = new Set(["language", "trigger", "selection-mode", "range-start", "range-end",
    "random-count", "sample-seed", "shuffle", "shuffle-seed", "checked", "enabled", "text", "preset", "preset-enabled"]);
  root.addEventListener("change", event => {
    if (!workflowFields.has(event.target.dataset.role)) return;
    const graph = node.graph;
    graph?.beforeChange?.();
    queueMicrotask(() => graph?.afterChange?.());
  }, true);

  function feedback(text) {
    errorText = text || "";
    note.textContent = errorText;
  }

  function mutate(fn) {
    node.graph?.beforeChange?.();
    try {
      fn();
      changed();
    } finally {
      node.graph?.afterChange?.();
    }
  }

  function refreshSelection() {
    selected = selectRows(state());
    if (carrier) {
      const text = selected[0]?.text ?? "";
      const value = text && state().trigger ? state().trigger + "\n" + text : text;
      if (carrier.value !== value) carrier.value = value;
    }
    renderSummary();
  }

  function setOption(key, value) {
    state().selection[key] = value;
    changed();
    refreshSelection();
  }

  function renderHead() {
    const language = select("language", [["cn", "中文"], ["en", "English"]], state().language, lang => {
      state().language = lang;
      feedback("");
      changed();
      render();
    });
    language.setAttribute("aria-label", tr("语言", "Language"));
    const trigger = input("text", "trigger", state().trigger, value => {
      state().trigger = value;
      changed();
      refreshSelection();
    });
    trigger.placeholder = tr("每条提示词的前缀（可选）", "Optional prefix for every prompt");
    head.replaceChildren(label(tr("全局触发词", "Global trigger"), trigger), language);
  }

  function renderOptions() {
    const s = state().selection;
    const mode = select("selection-mode", [
      ["all", tr("全部", "All")], ["range", tr("范围", "Range")],
      ["manual", tr("手选", "Manual")], ["random", tr("随机抽取", "Random sample")],
    ], s.mode, value => { setOption("mode", value); renderOptions(); if (activeTab === "library") renderLibrary(); });
    const fields = [label(tr("选择", "Select"), mode)];
    function numberField(key, role, caption) {
      const field = input("number", role, s[key], raw => {
        if (raw) setOption(key, Math.max(1, Math.floor(Number(raw)) || 1));
      });
      field.min = "1";
      field.step = "1";
      field.onchange = () => { field.value = s[key]; };
      return label(caption, field);
    }
    if (s.mode === "range") {
      fields.push(numberField("start", "range-start", tr("从", "From")), numberField("end", "range-end", tr("至", "To")));
    } else if (s.mode === "random") {
      fields.push(numberField("randomCount", "random-count", tr("条数", "Count")),
        label(tr("抽取种子", "Sample seed"), input("text", "sample-seed", s.sampleSeed, v => setOption("sampleSeed", v))));
    }
    fields.push(label(tr("打乱顺序", "Shuffle"), input("checkbox", "shuffle", s.shuffle, value => {
      setOption("shuffle", value);
      renderOptions();
    })));
    if (s.shuffle) fields.push(label(tr("排序种子", "Shuffle seed"),
      input("text", "shuffle-seed", s.shuffleSeed, v => setOption("shuffleSeed", v))));
    options.replaceChildren(...fields);
  }

  function renderSummary() {
    const times = Math.max(1, Number(app.extensionManager?.queueSettings?.batchCount ?? app.ui?.batchCount) || 1);
    const text = tr(`已选 ${selected.length} 条 × ${times} 批 = ${selected.length * times} 个任务`,
      `${selected.length} selected × ${times} repeats = ${selected.length * times} jobs`);
    const toggle = button(text + (previewOpen ? " ▴" : " ▾"), "preview-toggle", () => {
      previewOpen = !previewOpen;
      renderSummary();
    });
    toggle.setAttribute("aria-expanded", String(previewOpen));
    summary.replaceChildren(toggle);
    if (previewOpen && selected.length) {
      const list = element("ol", "ll-preview");
      for (const row of selected.slice(0, 5)) {
        const text = [state().trigger, row.text].filter(Boolean).join(" ");
        list.append(element("li", "", shortText(text)));
      }
      summary.append(list);
    }
  }

  function renderTabs() {
    const choices = [["library", tr("提示词库", "Library")], ["import", tr("导入", "Import")], ["presets", tr("预设", "Presets")]];
    tabs.replaceChildren(...choices.map(([key, text]) => {
      const b = button(text, "tab-" + key, () => { activeTab = key; feedback(""); renderTabs(); renderBody(); });
      b.setAttribute("aria-pressed", String(activeTab === key));
      return b;
    }));
  }

  function filterRows() {
    const search = query.trim().toLocaleLowerCase();
    filtered = [];
    state().rows.forEach((row, index) => {
      if (!search || row.text.toLocaleLowerCase().includes(search) || row.source.toLocaleLowerCase().includes(search)) filtered.push(index);
    });
    page = Math.min(page, Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1));
  }

  function renderLibrary() {
    const search = input("search", "search", query, value => { query = value; page = 0; drawPage(); });
    search.placeholder = tr("搜索全文或来源", "Search all prompts or sources");
    search.setAttribute("aria-label", search.placeholder);
    const add = button(tr("添加", "Add row"), "add", () => {
      mutate(() => {
        const row = makeRow();
        state().rows.push(row);
        if (state().selection.mode === "manual") state().selection.manualIds.push(row.id);
        query = search.value = "";
        page = Math.floor((state().rows.length - 1) / PAGE_SIZE);
      });
      drawPage();
      rows.lastElementChild?.querySelector("textarea")?.focus();
    });
    const clear = button(tr("清空", "Clear"), "clear", () => {
      if (!state().rows.length || !confirm(tr("清空所有提示词？", "Clear the entire prompt library?"))) return;
      mutate(() => { state().rows = []; state().selection.manualIds = []; });
      drawPage();
      refreshSelection();
    });
    const rows = control(element("div", "ll-rows"), "rows");
    const pager = element("div", "ll-pager");
    body.replaceChildren(line(search, add, clear), rows, pager);

    function drawPage() {
      filterRows();
      const manual = state().selection.mode === "manual";
      const ids = new Set(state().selection.manualIds);
      const nodes = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(index => {
        const row = state().rows[index];
        const wrap = element("div", "ll-row");
        const rowNo = index + 1;
        wrap.dataset.id = row.id;
        const enabled = input("checkbox", "enabled", row.enabled, value => {
          row.enabled = value;
          wrap.classList.toggle("ll-disabled", !value);
          changed();
          refreshSelection();
        });
        enabled.title = tr("启用", "Enabled") + " #" + rowNo;
        const flags = element("div", "ll-flags");
        flags.append(label(tr("启用", "On"), enabled));
        if (manual) {
          const check = input("checkbox", "checked", ids.has(row.id), value => {
            const s = state().selection;
            if (value && !s.manualIds.includes(row.id)) s.manualIds.push(row.id);
            else if (!value) s.manualIds = s.manualIds.filter(id => id !== row.id);
            changed();
            refreshSelection();
          });
          flags.append(label(tr("选中", "Pick"), check));
        }
        const edit = control(element("textarea"), "text");
        edit.rows = 2;
        edit.value = row.text;
        edit.setAttribute("aria-label", tr("提示词", "Prompt") + " #" + rowNo);
        edit.addEventListener("input", () => { row.text = edit.value; changed(); refreshSelection(); });
        edit.addEventListener("change", () => { if (query) drawPage(); });
        const meta = element("small", "ll-source", "#" + rowNo + (row.source ? " · " + row.source + ":" + row.sourceRow : ""));
        meta.title = meta.textContent;
        const content = element("div", "ll-content");
        content.append(meta, edit);
        const del = button("×", "delete", () => {
          mutate(() => {
            state().rows.splice(index, 1);
            state().selection.manualIds = state().selection.manualIds.filter(id => id !== row.id);
          });
          drawPage();
          refreshSelection();
        });
        del.title = tr("删除", "Delete") + " #" + rowNo;
        del.setAttribute("aria-label", del.title);
        wrap.classList.toggle("ll-disabled", !row.enabled);
        wrap.append(flags, content, del);
        return wrap;
      });
      rows.replaceChildren(...nodes);
      rows.scrollTop = 0;
      if (!nodes.length) rows.append(element("p", "ll-empty", query ? tr("没有匹配的提示词。", "No matching prompts.")
        : tr("添加一条提示词，或在「导入」中粘贴文本、选择文件。", "Add a row, or open Import to paste prompts or choose files.")));
      const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
      const back = button("‹", "prev", () => { page--; drawPage(); });
      const next = button("›", "next", () => { page++; drawPage(); });
      back.title = tr("上一页", "Previous page");
      next.title = tr("下一页", "Next page");
      back.disabled = page <= 0;
      next.disabled = page + 1 >= pages;
      const n = state().rows.length;
      pager.replaceChildren(element("span", "", query ? tr(`匹配 ${filtered.length} / ${n} 条`, `${filtered.length} of ${n} rows`) : tr(`共 ${n} 条`, `${n} rows`)),
        back, element("span", "", `${page + 1} / ${pages}`), next);
    }
    drawPage();
  }

  function commitImport(replace) {
    if (!staged?.rows?.length) return;
    if (replace && state().rows.length && !confirm(tr("用预览中的提示词替换整个词库？", "Replace the entire library with these rows?"))) return;
    const incoming = staged.rows;
    mutate(() => {
      const oldLength = state().rows.length;
      if (replace) {
        state().rows = incoming;
        state().selection.manualIds = [];
      } else {
        state().rows = state().rows.concat(incoming);
      }
      if (replace || !oldLength || state().selection.end === oldLength) state().selection.end = state().rows.length;
      query = "";
      page = replace ? 0 : Math.floor(oldLength / PAGE_SIZE);
      staged = null;
      paste = "";
      activeTab = "library";
    });
    feedback(tr(`已导入 ${incoming.length} 条。左右翻页可继续编辑。`, `Imported ${incoming.length} rows.`));
    render();
  }

  function renderImport() {
    const files = line();
    const preview = control(element("div", "ll-import-preview"), "import-preview");
    function drawStaged() {
      preview.replaceChildren();
      if (!staged) return;
      const count = staged.rows.length;
      const skipped = staged.skipped || 0;
      const head = element("strong", "", tr(`解析出 ${count} 条 · 跳过 ${skipped} 条`, `${count} parsed · ${skipped} skipped`));
      const items = element("ol", "ll-preview");
      for (const row of staged.rows.slice(0, 5)) items.append(element("li", "", `${row.source}:${row.sourceRow} · ${shortText(row.text)}`));
      const append = button(tr("追加到词库", "Append"), "append", () => commitImport(false));
      const replace = button(tr("替换词库", "Replace library"), "replace", () => commitImport(true));
      append.disabled = replace.disabled = !count;
      preview.append(head, items, line(append, replace));
      if (staged.errors?.length) {
        const errors = element("ul", "ll-errors");
        for (const err of staged.errors.slice(0, 10)) errors.append(element("li", "", err.source + " · " + err.message));
        preview.append(element("strong", "", tr(`${staged.errors.length} 个文件解析失败`, `${staged.errors.length} file errors`)), errors);
      }
    }
    function picker(folder) {
      const role = folder ? "import-folder" : "import-file";
      const file = control(element("input"), role);
      file.type = "file";
      file.multiple = true;
      file.accept = ".txt,.csv,.json";
      if (folder) file.webkitdirectory = true;
      file.hidden = true;
      file.addEventListener("change", async () => {
        const batch = Array.from(file.files || []);
        file.value = "";
        if (!batch.length) return;
        const token = ++importToken;
        staged = null;
        drawStaged();
        feedback(tr("正在读取文件…", "Reading files…"));
        try {
          const result = await readFiles(batch, { lines: fileLines });
          if (importToken !== token) return;
          staged = result;
          feedback("");
        } catch (error) {
          if (importToken === token) feedback(error.message);
        }
        if (activeTab === "import" && token === importToken) renderImport();
      });
      const b = button(folder ? tr("选择文件夹", "Choose folder") : tr("选择文件", "Choose files"), role + "-button", () => file.click());
      files.append(file, b);
    }
    picker(false);
    picker(true);
    files.append(label(tr("TXT 文件按行拆分", "Split TXT files by line"), input("checkbox", "file-lines", fileLines, value => {
      fileLines = value;
      importToken++;
      staged = null;
      feedback("");
      drawStaged();
    })));
    const pasteBox = control(element("textarea", "ll-paste"), "paste");
    pasteBox.placeholder = tr("在此粘贴 TXT、CSV 或 JSON 提示词", "Paste TXT, CSV or JSON prompts here");
    pasteBox.value = paste;
    function invalidate() {
      importToken++;
      staged = null;
      drawStaged();
      feedback("");
    }
    pasteBox.addEventListener("input", () => { paste = pasteBox.value; invalidate(); });
    const fmt = select("format", [["txt", "TXT"], ["csv", "CSV"], ["json", "JSON"]], format, value => {
      format = value;
      invalidate();
      renderImport();
    });
    const parse = button(tr("预览粘贴内容", "Preview paste"), "parse", () => {
      invalidate();
      try {
        const parsed = parseText(paste, tr("粘贴", "Paste") + "." + format, { lines: splitLines });
        staged = { ...parsed, errors: [] };
        drawStaged();
      } catch (error) { feedback(error.message); }
    });
    const pasteOptions = line(label(tr("粘贴格式", "Paste format"), fmt));
    if (format === "txt") pasteOptions.append(label(tr("每行一条", "One per line"), input("checkbox", "paste-lines", splitLines, v => { splitLines = v; invalidate(); })));
    pasteOptions.append(parse);
    body.replaceChildren(files, pasteBox, pasteOptions, preview);
    drawStaged();
  }

  async function post(path, payload) {
    const req = { method: "POST" };
    if (payload) {
      req.headers = { "Content-Type": "application/json" };
      req.body = JSON.stringify(payload);
    }
    const response = await api.fetchApi(path, req);
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || response.status);
    return result;
  }

  function renderPresets() {
    if (!presetsRequested) void fetchPresets();
    const enabled = input("checkbox", "preset-enabled", state().presetEnabled !== false, value => {
      state().presetEnabled = value;
      changed();
      renderPresets();
    });
    body.replaceChildren(line(label(tr("启用预设", "Enable presets"), enabled)));
    if (!enabled.checked) return;
    const current = state().presetName || "";
    const choices = [["", tr("选择预设…", "Choose a preset…")], ...presets.map(p => [p.name, p.name])];
    if (current && !presets.some(p => p.name === current)) choices.push([current, current]);
    const picker = select("preset", choices, current, value => { state().presetName = value; changed(); });
    const apply = button(tr("应用", "Apply"), "preset-apply", () => {
      const preset = presets.find(p => p.name === picker.value);
      if (!preset) { feedback(tr("请选择可用预设。", "Choose an available preset.")); return; }
      if (state().rows.length && !confirm(tr("用此预设替换当前词库和选择设置？", "Replace the library and selection settings with this preset?"))) return;
      try {
        const updated = fromPreset(preset);
        if (!updated?.rows?.length) throw new Error(tr("预设为空。", "The preset is empty."));
        updated.language = state().language;
        updated.presetName = preset.name;
        updated.presetEnabled = true;
        mutate(() => { node.properties.loulanBatch = updated; });
        activeTab = "library";
        query = "";
        page = 0;
        feedback(tr("已应用预设。", "Preset applied."));
        render();
      } catch (error) { feedback(error.message); }
    });
    const name = input("text", "preset-name", presetDraft, value => { presetDraft = value; });
    name.placeholder = tr("新预设名称", "New preset name");
    name.maxLength = 100;
    const save = button(tr("保存预设", "Save preset"), "preset-save", async () => {
      const chosen = presetDraft.trim();
      if (!chosen) { feedback(tr("请输入新预设名称。", "Enter a name for the new preset.")); name.focus(); return; }
      if (!state().rows.some(row => row.text.trim())) { feedback(tr("词库中没有可保存的提示词。", "The library has no prompts to save.")); return; }
      if (presets.some(p => p.name === chosen)) { feedback(tr("此名称已被使用。", "This name is already in use.")); return; }
      save.disabled = true;
      try {
        const result = await post("/loulan/save_preset", { name: chosen, preset: toPreset(state(), chosen) });
        state().presetName = result.name || chosen;
        presetDraft = "";
        changed();
        await fetchPresets();
        feedback(tr("已保存预设。", "Preset saved."));
      } catch (error) { feedback(error.message); }
      finally { save.disabled = false; }
    });
    const folder = button(tr("打开预设文件夹", "Open presets folder"), "preset-folder", async () => {
      try { await post("/loulan/open_presets"); } catch (error) { feedback(error.message); }
    });
    const reload = button(tr("刷新", "Refresh"), "preset-refresh", () => fetchPresets());
    body.append(line(picker, apply), line(name, save), line(folder, reload));
  }

  function renderStatus() {
    status.replaceChildren();
    const s = queueState;
    if (!s) { status.hidden = true; return; }
    status.hidden = false;
    const phases = {
      feeding: tr("正在提交", "Submitting"), paused: tr("已暂停提交", "Submission paused"), failed: tr("批处理出错", "Batch error"),
      submitted: tr("已全部提交", "All jobs submitted"), done: tr("批处理结束", "Batch finished"), cancelled: tr("已停止提交", "Submission stopped"),
    };
    status.append(element("strong", "", phases[s.phase] || s.phase), element("span", "",
      tr(`已提交 ${s.submitted}/${s.total} · 等待 ${s.queued} · 运行 ${s.running} · 完成 ${s.completed} · 失败 ${s.failed}`,
        `Submitted ${s.submitted}/${s.total} · queued ${s.queued} · running ${s.running} · completed ${s.completed} · failed ${s.failed}`)));
    if (s.unknown > 0) status.append(element("span", "", tr(`待核对 ${s.unknown}`, `Untracked ${s.unknown}`)));
    if (s.attempts > s.submitted) status.append(element("span", "", tr(`含重试共提交 ${s.attempts} 次`, `${s.attempts} attempts including retries`)));
    const actions = line();
    if (s.phase === "feeding") actions.append(button(tr("暂停提交", "Pause submission"), "pause", () => queue.pause(node)));
    if (s.phase === "paused") actions.append(button(tr("继续提交", "Resume submission"), "resume", () => queue.resume(node)));
    if (s.canRetry) actions.append(button(tr("重试", "Retry"), "retry", () => queue.retry(node)));
    if (["feeding", "paused", "failed"].includes(s.phase) && s.submitted < s.total) actions.append(button(tr("停止后续提交", "Stop remaining submissions"), "cancel", () => queue.cancel(node)));
    if (actions.childElementCount) status.append(actions);
    if (s.message) status.append(element("small", "", s.message));
  }

  function renderBody() {
    if (activeTab === "library") renderLibrary();
    else if (activeTab === "presets") renderPresets();
    else renderImport();
  }

  function render() {
    renderHead();
    renderOptions();
    refreshSelection();
    renderTabs();
    renderBody();
    note.textContent = errorText;
    renderStatus();
  }

  function presetsChanged() { if (activeTab === "presets") renderPresets(); }
  presetEvents.addEventListener("update", presetsChanged);
  const unsubscribe = app.extensionManager?.queueSettings?.$subscribe?.(() => renderSummary(), { detached: true });
  const removed = node.onRemoved;
  node.onRemoved = function (...args) {
    presetEvents.removeEventListener("update", presetsChanged);
    unsubscribe?.();
    importToken++;
    return removed?.apply(this, args);
  };
  editors.set(node, {
    render, status(s) { queueState = s; renderStatus(); },
    restored() { query = ""; page = 0; staged = null; importToken++; render(); },
  });
  render();
  node.setSize?.([Math.max(495, node.size?.[0] || 0), 555]);
}

app.registerExtension({
  name: "comfyui-prompt-batch-writer",
  setup() {
    if (!document.getElementById("loulan-editor-styles")) {
      const link = element("link");
      link.rel = "stylesheet";
      link.id = "loulan-editor-styles";
      link.href = new URL("./prompt_batch_writer.css", import.meta.url).href;
      document.head.append(link);
    }
    queue = installBatchQueue(app, api, {
      getState: node => node.properties.loulanBatch,
      getSelection: selectRows,
      notify,
      onStatus: (node, s) => editors.get(node)?.status(s),
    });
  },
  beforeRegisterNodeDef(type, info) {
    if (info.name !== NODE) return;
    const configure = type.prototype.onConfigure;
    type.prototype.onConfigure = function (data, ...args) {
      const result = configure?.call(this, data, ...args);
      configureState(this, data);
      editors.get(this)?.restored();
      // Legacy nodes used hundreds of fixed widgets and can be very tall.
      if (!data.properties?.loulanBatch) this.setSize?.([Math.max(495, this.size?.[0] || 0), 555]);
      return result;
    };
  },
  nodeCreated(node) {
    if (isWriter(node)) buildEditor(node);
  },
  loadedGraphNode(node) {
    // Switching workflows can create a new canvas node for the same running batch.
    if (isWriter(node)) editors.get(node)?.status(queue?.getStatus(node) ?? null);
  },
});
