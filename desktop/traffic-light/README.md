# Clowder Traffic Light

macOS 桌面置顶三色灯，用来观察本机 Clowder Agent 运行状态。

## 状态规则

- 黄灯：有 Agent 正在运行，或有 invocation 处于 queued。
- 绿灯：当前空闲，最近任务已完成或没有任务。
- 红灯：最近 5 分钟有失败 invocation，且当前没有运行/排队任务。
- 灰灯：无法连接 Clowder API。

## 启动

```bash
cd desktop/traffic-light
./run.sh
```

启动后会出现一个置顶胶囊小窗口。点击小灯会打开 `http://127.0.0.1:3003`。

视觉规则：三颗灯固定展示，当前状态对应的灯点亮；其他灯变暗。离线时三颗灯全部置灰。

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
