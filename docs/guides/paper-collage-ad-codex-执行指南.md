---
feature_ids: []
topics: [Codex, 视频生成, 剪纸广告, skill]
doc_kind: guide
created: 2026-07-13
---

# Paper Collage Ad · Codex 执行指南

## 已安装与验证

- 上游仓库：`https://github.com/jane-xiaoer/paper-collage-ad-codex`
- 本地源目录：`~/.agents/skills/paper-collage-ad-codex`
- Codex 原生入口：`~/.codex/skills/paper-collage-ad`（符号链接）
- Clowder 入口：`cat-cafe-skills/external/paper-collage-ad-codex`（符号链接）
- 核心依赖已通过预检：`ffmpeg`、`ffprobe`、Node.js、Bash。

此 skill 适用于把真实产品素材做成剪纸/拼贴风格广告片，并交付经过流级校验的 MP4；不是只写提示词或生成一张静态图。

## 给 Codex 的触发方式

在包含真实品牌素材的项目目录中发起：

```text
使用 paper-collage-ad，根据这个产品目录制作一条 45 秒、有趣但不过度吵闹的剪纸广告。
先给我确认脚本和分镜，再开始生成画面。
```

生成资产必须放在独立广告项目目录，不能放进 skill 目录。推荐结构：

```text
<ad-project>/
  brief.md
  script.md
  storyboard.json
  manifests/
  assets/{brand,screenshots,keyframes,layers,voice-reference,voice-final,music,sfx,audio}/
  renders/
```

## 九步工作流

1. 读取真实 Logo、界面截图、品牌色、受众、渠道与 CTA，写入 `brief.md`。
2. 提出一个贯穿全片的视觉隐喻，写完整旁白与时间码分镜。
3. **让用户确认脚本、分镜和旁白**；未确认不得生成关键帧、声音或视频。
4. 固定纸张、半色调、纸边、阴影与品牌强调色，先做第一张风格锚点。
5. 锚点通过后，按固定参考顺序生成所有关键帧，并保存提示词清单。
6. 逐场景做本地分层动画或外部视频生成；缺素材时可退回到静帧动画。
7. 用真人录音、普通 TTS 或经授权的声纹生成旁白，并以实际音频时长校正镜头。
8. 加入配乐、动作音效和人声 ducking，合成 `final.mp4`。
9. 用 `ffprobe` 校验音视频流、时长和输出文件；交付成片、contact sheet、manifest 及可编辑场景素材。

## 依赖与边界

- `ffmpeg`、`ffprobe`、Node.js（>=18）、Bash 是每次渲染的核心依赖；当前机器均可用。
- IndexTTS-2 声音克隆、`uv`/`hf`、模型权重仅在用户提供**已授权**参考声音且选择本地克隆时才需要。
- 图像关键帧、音乐与外部视频生成服务不是该 skill 自带能力；先与用户确认可用工具和费用。
- 不得让模型虚构 Logo、产品界面、功能事实或未经授权的声音；这些素材必须来自项目真实资产。

## 常用预检与产出脚本

```bash
SKILL_DIR="$HOME/.codex/skills/paper-collage-ad"
bash "$SKILL_DIR/scripts/check-deps.sh"

# 静帧兜底动画、分层动画、最终合成
node "$SKILL_DIR/scripts/render.mjs"
node "$SKILL_DIR/scripts/layer-animate.mjs"
node "$SKILL_DIR/scripts/assemble.mjs"
```

实际参数与 manifest 以 `SKILL.md`、`references/production-workflow.md` 和 `examples/` 的模板为准；先填齐素材与 manifest，再运行脚本。

## 运行态注意：荧荧暂不适合执行落盘任务

本轮诊断显示，Grok CLI 虽支持 MCP 管理命令，但 Clowder 的 `GrokAgentService` 目前仅以 `-p`、模型、权限和 streaming JSON 参数启动，**没有像 Codex/Claude/Kimi 一样给子进程注入 Cat Cafe MCP 配置**。同时名册把 `grok.mcpSupport` 标成了 `true`，路由层因此误判其具备原生 MCP，跳过了 HTTP callback 指令注入。

结论：荧荧当前可用于检索、调研和总结；涉及任务认领、文件写入、进度回写的执行工作应交给 Codex/Kimi/Claude，直到 Grok provider 完成 MCP 接入与真实工具调用验证。
