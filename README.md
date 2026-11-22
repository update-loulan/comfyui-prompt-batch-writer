# Loulan-prompt

ComfyUI 的批量提示词节点。把 `Loulan-prompt` 的字符串输出接到工作流的提示词输入，然后用 ComfyUI 的运行按钮提交。支持中文和英文界面。

A paginated prompt library for ComfyUI. Connect the node’s STRING output to a prompt input in your workflow and use the standard Run button.

## 0.2.0 更新说明 · Release notes

取消了 100 条提示词上限。可以搜索整份词库，按范围、手选或随机抽取来跑；带引号的多行 CSV 提示词会完整保留。提交前可查看任务总数，运行中可暂停和继续，已确认失败的任务可按原提示词和种子单独重试。[完整更新说明](https://github.com/update-loulan/comfyui-prompt-batch-writer/releases/tag/v0.2.0)

Version 0.2.0 removes the 100-prompt limit and adds library search, seeded sampling, pause and resume, and individual retries. [Full release notes](https://github.com/update-loulan/comfyui-prompt-batch-writer/releases/tag/v0.2.0)

## 导入和选择 · Import and select

- **导入**支持 TXT、CSV 和 JSON，可选择文件、选择文件夹或粘贴文本。先预览条数和解析错误，再决定追加或替换。TXT 文件默认整份作为一条提示词，可切换为每行一条。CSV 支持引号内的逗号、换行和双引号，识别 `prompt`、`text`、`提示词` 等列名，缺少可识别的表头时取第一列。JSON 支持字符串数组以及含有 `prompts` 数组的对象。
- **浏览**每页显示 25 条，可搜索整份图库。搜索影响浏览结果，运行范围由选择模式决定。
- **选择**支持全部、按原始序号选范围、手动勾选以及随机抽 N 条。空白和禁用行会跳过。范围包含起止两端，随机抽取不会重复选择同一行。
- **打乱顺序**单独控制执行次序。默认按图库顺序提交。使用同一份图库和抽取种子可重现抽样，改变排序种子可打乱同一组结果。采样器种子仍由工作流控制。
- **运行**前查看任务数，即有效行数乘以 ComfyUI 的批次数。全局触发词会加在每条正文前。工作流保存完整图库；批次生成的 PNG 保存该项的提示词，拖回画布可复现单项。

Import TXT, CSV or JSON, preview the results, then append or replace. Browse and search the whole library. Choose all eligible rows, an inclusive range, a manual selection or a seeded sample without replacement. Optional shuffling uses a separate seed. The preview shows the selected row count multiplied by the ComfyUI batch count.

## 队列与重试 · Queue and retry

运行时会固定本批的选词和工作流，并分批把任务交给 ComfyUI。暂停、继续和停止控制后续提交，已经取得任务 ID 的项目仍由 ComfyUI 队列处理。确认执行失败的项目可以用原提示词和原种子重试。响应丢失时请先核对队列和历史记录，避免重复出图。

运行期间请保持该 ComfyUI 页面打开。待提交的进度保存在当前页面中；刷新前请先保存工作流。直接调用后端 API 时，每次提交执行一个 `prompt` 值。

使用需要账号验证的合作伙伴节点时，提交期间请保持原工作流处于选中状态。本地工作流支持 ComfyUI 内置的固定、递增、递减和随机种子模式。依赖第三方扩展在每次入队时动态改写其他参数的工作流，应先用小批量核对参数。

The browser feeds a bounded number of jobs at a time. Pausing or stopping the feeder leaves already accepted jobs in ComfyUI’s queue. Keep the page open while feeding. A retry of a confirmed execution failure uses its original prompt and seed.

## 示例 · Examples

打开独立示例并点击「运行」，两条示例词会依次送到 ComfyUI 内置的「预览为文本」节点。可以直接编辑示例词，也可以在「导入」页替换整份词库。[下载示例工作流](example_workflows/batch-prompt-preview.json)

Run the standalone workflow to send both sample prompts to ComfyUI’s built-in **Preview as Text** node in order. It runs without a model download. [Open the example workflow](example_workflows/batch-prompt-preview.json)

CSV 中的第一条提示词跨两行。导入下例会得到两条提示词。

```csv
prompt,style
"A white cat
sitting beside a window",photo
A small wooden boat,illustration
```

JSON 可以直接写成字符串数组。

```json
["A white cat beside a window", "A small wooden boat"]
```

## 安装与兼容 · Installation and compatibility

将此目录放入 ComfyUI 的 `custom_nodes`，重启服务并刷新前端，在节点搜索里输入 `Loulan-prompt`。已有 0.1.1 工作流会迁移到图库界面。旧预设仍可读取，应用预设会还原它保存的全局触发词。

Install under `ComfyUI/custom_nodes`, restart ComfyUI and refresh the frontend. Existing 0.1.1 workflows and presets are supported. Batch selection runs in the browser. Direct API submissions execute one value of the node’s `prompt` input per queue item.

## License / 许可证

[MIT](LICENSE)
