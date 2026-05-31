# Clowder Traffic Light

macOS 桌面置顶三路状态灯，用来观察本机 Clowder、Slock daemon 和 Codex 客户端状态。

## 状态规则

窗口中有三列：

- `Clowder`：读取 `GET /api/runtime/traffic-light`。
  - 黄灯：有 Agent 正在运行，或有 invocation 处于 queued。
  - 绿灯：当前空闲，最近任务已完成或没有任务。
  - 红灯：最近 5 分钟有失败 invocation，且当前没有运行/排队任务。
  - 灰灯：无法连接 Clowder API。
- `Slock`：用 `pgrep` 检测本机 Slock daemon 进程。
  - 绿灯：daemon 在线。
  - 灰灯：daemon 未运行。
- `Codex`：用 `pgrep` 检测本机 `opencode` / `codex` 客户端进程。
  - 黄灯：检测到客户端进程。
  - 绿灯：未检测到客户端进程。

## 启动

```bash
cd desktop/traffic-light
./run.sh
```

启动后会出现一个约 `300×120` 的置顶胶囊小窗口。点击小灯会打开 `http://127.0.0.1:3003`。

视觉规则：三列固定展示，每列一颗状态灯 + 名称。鼠标悬浮可查看详细状态。

## 配置

可用环境变量覆盖默认地址：

```bash
CLOWDER_API_URL=http://127.0.0.1:3004/api/runtime/traffic-light \
CLOWDER_WEB_URL=http://127.0.0.1:3003 \
./run.sh
```

## 打包成 `.app`

第一版先提供源码启动。后续需要双击启动时，可把 `run.sh` 包进
`ClowderTrafficLight.app`，或接入现有 Electron desktop 打包流程。
