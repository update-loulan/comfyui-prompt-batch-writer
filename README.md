# Loulan-prompt

A ComfyUI node for batch-running prompt tasks. Write prompts ahead of time (e.g. with an LLM tool) and load them from **txt / json / csv** files, then queue them all at once.

一个 ComfyUI 节点，用于批量执行提示词任务。可以提前用 LLM 工具写好提示词，转成 **txt / json / csv** 文件导入，一次跑完。

---

## Quick start / 快速上手

| Step | English | 中文 |
|---|---|---|
| 1 | Double-click the canvas and type `loulan prompt` to add the node. | 双击画布空白处，输入 `loulan prompt` 弹出节点。 |
| 2 | Connect the node's `prompt` output to the CLIP text (positive) input. | 把节点接到 CLIP 提示词输入（正向）那里。 |
| 3 | Use the language toggle to switch 中文 / English. | 用语言控件切换中文 / English。 |

---

## Features / 功能说明

### Prompt count · 提示词数量
Choose how many prompt boxes are active. / 选择参与跑图的提示词数量。

### Global TAG / Trigger · 全局TAG（触发词）
Type the LoRA trigger word here. For example, if you are writing 10 character prompts, the LLM only needs to write the prompt content — put the shared trigger word here and it is automatically prefixed to every prompt.

输入 LoRA 的触发词。比如我要写 10 组人物提示词，LLM 只需要写好提示词内容，这里输入全局提示词的触发词即可，它会自动加到每条提示词前面。

### Clear History · 清理历史输入记录
When you reduce the prompt count, hidden prompts are kept by default. Turn this **ON** to clear them instead. Example: you ran 20 prompts for "Character 1", now you switch to another LoRA but want to keep Character 1's prompts — leave this **OFF**.

当你减少提示词数量时，默认会保留被隐藏的提示词；打开这个开关则会清除它们。比如我刚跑了一遍「人物1」的 20 组提示词，现在要换 LoRA 但又想保留「人物1」的提示词，这里选择关闭即可。

### Per-prompt toggle · 每条独立开关
Every prompt has its own **Enable** switch. / 每个提示词组都有单独的开关。

### Presets · 预设
Save the current prompts to a JSON file and reuse them later. Example: on 2026-09-01 you used a set of prompts and liked the result — click **Save as Preset**; on 2026-09-05, when running a different LoRA, click **Apply Preset** to reuse those prompts.

把当前提示词保存到一个 json 文件里，下次跑图时直接复用。比如 2026 年 9 月 1 日用了某组提示词、觉得效果不错，点击「保存为预设」；2026 年 9 月 5 日跑其他 LoRA 时点击「应用预设」，就能直接用之前的提示词。

### Import File · 输入文件
Select a folder of **txt / csv / json** files. / 选择 **txt / csv / json** 文件（文件夹）导入。

### Clear All · 全部清理
Reset the prompt count and all prompts back to the initial state. / 把输入数量和提示词全部恢复到初始状态。

---

## Install / 安装

Copy this folder into `ComfyUI/custom_nodes/` and restart ComfyUI. Requires ComfyUI **0.3.0+** (V3 node API).

把本目录放到 `ComfyUI/custom_nodes/` 下并重启 ComfyUI。需要 ComfyUI **0.3.0+**（V3 节点接口）。

## Notes / 注意事项

- **Batch count**: the queue is split into `prompt count × batch count` tasks (ComfyUI's batch setting applies to every prompt). / **批次数**：队列拆分为「提示词数量 × 批次数」条任务（ComfyUI 的批次设置会作用于每条提示词）。
- **Seeds**: seed behavior follows ComfyUI's own seed settings (fixed / increment / randomize). / **种子**：种子行为跟随 ComfyUI 的 seed 设置（固定 / 递增 / 随机）。
- **API mode**: batch splitting is a browser-side feature. Calling the workflow directly through the API queues only one prompt (the node forwards the current value). / **API 模式**：批量拆分是浏览器端功能，直接通过 API 调用工作流只会执行当前一条提示词（节点只转发当前值）。

## License / 许可证

[MIT](LICENSE)
