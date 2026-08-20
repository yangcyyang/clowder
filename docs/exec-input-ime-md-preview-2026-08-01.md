---
feature_ids: [input-ime-fix, md-preview-panel]
topics: [composer, ime, markdown-preview, workspace-panel]
doc_kind: exec-plan
created: 2026-08-01
---

# 执行方案：thread 输入框 IME 误发送修复 + 右侧 Markdown 预览增强

> 需求来源：铲屎官 2026-08-01 thread 消息。
> 规划：大师（规划）。执行：codex。本文件含全部事实依据（路径:行号），执行时直接按单施工，不要重新做大范围侦察。

## 背景事实（已侦察确认）

- 前端：`packages/web/`（Next.js 14 + React 18 + zustand + Tailwind，dev 端口 3003）；API：`packages/api/`（Fastify，3004）。
- 项目已有现成的 IME 防护 hook：`packages/web/src/hooks/useIMEGuard.ts:19-39`（ref + requestAnimationFrame 延迟一帧清除 composing 标志，解决 Chrome compositionend 先于 keydown 的时序坑）。
- 项目已有现成的 md 渲染组件：`packages/web/src/components/MarkdownContent.tsx:813`（react-markdown + remark-gfm + remark-breaks + dompurify，依赖已在 package.json，无需新增）。
- 项目已有多个 IME 回归测试先例：`packages/web/src/components/__tests__/quick-create-form-ime.test.tsx`、`hub-tag-editor-ime.test.tsx` 等。

---

## 任务 A：修复右侧 thread 面板（InlineThreadPanel）输入框中文输入误发送

### 根因

用户感知："打字按空格被当成发送键"。代码里两处 composer 的发送键其实都是 Enter（非 Shift），不存在 space→send 路径。真实根因是：

- 主输入框 `ChatInput.tsx:380` 有 IME 防护（`if (ime.isComposing()) return;` + textarea 挂 composition 事件，`:913-919`）。
- 右侧面板的独立 composer `InlineThreadPanel.tsx` **完全没有 IME 防护**：
  - textarea（`:1780-1789`）只挂了 `onChange / onKeyDown / onPaste`，无 onCompositionStart/End，全文件 grep `Composition` 零匹配。
  - 发送判定 `shouldSendInlineThreadMessage`（`:174-178`）只看 `key === 'Enter' && !shiftKey`，事件类型（`:110`）没带 `isComposing`。
  - 中文输入法候选窗确认（空格/回车，部分 IME 确认会产生 Enter keydown）在 composition 期间被直接判为发送。
- 对比佐证：同文件搜索框 `handleSearchKeyDown`（`:1043`）反而有 `if (event.nativeEvent.isComposing) return;` —— 模式已存在，只是 composer 漏了。

### 修法（复用现有模式，最小改动）

1. `packages/web/src/components/InlineThreadPanel.tsx`：
   - import 并使用 `useIMEGuard`（与 `ChatInput.tsx:90` 同法）。
   - textarea 增加 `onCompositionStart={ime.onCompositionStart}` / `onCompositionEnd={ime.onCompositionEnd}`。
   - `handleInputKeyDown`（`:1346-1416`）开头加 `if (ime.isComposing()) return;`（注意要在 shouldSendInlineThreadMessage 判定之前，且不影响正常非 composition 按键）。
   - 如需要，`shouldSendInlineThreadMessage` 的事件类型补上 `nativeEvent.isComposing` 双保险（与 `:1043` 搜索框模式对齐）。
2. 新增回归测试 `packages/web/src/components/__tests__/inline-thread-panel-ime.test.tsx`：
   - 仿照 `quick-create-form-ime.test.tsx` 的写法。
   - 覆盖：composition 期间 keydown Enter 不触发发送；composition 期间 keydown Space 不触发发送；compositionend 后正常 Enter 发送。
3. 不要动 `ChatInput.tsx`（它已正确）。

### 验收

- `pnpm --filter @cat-cafe/web test`（或项目实际 test 命令）全绿，含新测试。
- 手动验证：dev 起 3003，右侧 thread 面板用中文输入法打字，候选窗按空格/回车确认 → 上屏不发送；英文 Enter → 正常发送；Shift+Enter → 换行。

---

## 任务 B：右侧 Markdown 预览面板增强（打开本地 md 路径）

### 现状：能力已存在 80%，复用而非新造

- `WorkspacePanel.tsx:372` 已支持 md/mdx 渲染预览（默认 rendered 态，`:277`），Raw/Rendered 切换按钮在 `WorkspaceFileViewer.tsx:183-189`。
- 渲染分派 `workspace/FileContentRenderer.tsx:109-113`：md → `MarkdownContent`；源码 → CodeMirror `CodeViewer`。
- md 内相对图片/链接解析已有：`workspace-md-components.tsx`（图片走 `/api/workspace/file/raw`，相对 .md 链接面板内跳转）。
- 后端读文件 API 已有：`GET /api/workspace/file?worktreeId=&path=`（`packages/api/src/routes/workspace.ts:343-402`，1MB 截断）。
- **限制**：安全边界 `workspace-security.ts:38-44` 要求文件必须落在 git worktree 或 linked root 内，不能直接预览任意绝对路径文件。linked root 挂载 API 已存在：`POST /api/workspace/linked-roots`（`workspace.ts:10-11`，持久化在 `.cat-cafe/linked-roots.json`）。

### 方案（P1 必做，P2 可选）

**P1：「打开本地 md 路径」入口**

1. 在 WorkspacePanel 顶部加一个「打开本地文件」输入入口（粘贴/输入绝对路径，仅接受 `.md` / `.mdx`）。
2. 前端流程：校验扩展名 → 取父目录 → 调 `POST /api/workspace/linked-roots` 挂载（已存在 API，幂等处理已挂载的情况）→ 拿到 worktreeId/root 标识 → `setWorkspaceOpenFile(path)` + `setRightPanelMode('workspace')`（`chatStore.ts:1321`）→ 现有渲染管线出预览。
3. 非法路径/不存在/非 md：输入框内报错提示，不发请求。
4. **不要**新增绕过 `resolveWorkspacePath` 的任意文件读取接口（安全边界不破）。

**P2（可选，时间够再做）**：thread 消息文本中出现的本地 `.md` 绝对路径渲染为可点击链接，点击走 P1 同一流程打开预览。

### 验收

- 粘贴一个仓库外任意目录的 `.md` 绝对路径 → 右侧面板渲染出排版后的 markdown（标题/表格/代码块/图片），效果对齐 codex 文件预览（rendered 为主、可切 Raw）。
- md 内相对路径图片正常显示；Raw/Rendered 切换正常。
- 非 md 路径、不存在路径有明确错误提示。
- API 测试：linked-roots 重复挂载不报错不重复记录。

---

## 工程纪律

- 在当前 Clowder 主仓基础上新建 worktree + 分支 `codex/ime-fix-md-preview`（基于 `feature/slock-like-webui`，即 origin/HEAD；当前主 checkout 有未提交的其他改动，不要直接在上面施工）。
- 通过 lint（biome）和相关 vitest；提交前 `git status` 确认只包含本任务文件。
- 不碰共享契约热点文件；两个任务分两个 commit（A: fix，B: feat）。
- 完成后回报：commit hash、测试输出、手动验证结果（A 的手动验证如无法自动做，明确说明并给出验证步骤）。
