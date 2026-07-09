import Foundation

func assertEqual<T: Equatable>(_ actual: T, _ expected: T, _ message: String) {
  if actual != expected {
    fputs("FAIL: \(message). expected \(expected), got \(actual)\n", stderr)
    exit(1)
  }
}

@main
struct TrafficLightStatusTests {
  static func main() throws {
    let codexBridgeOnly = """
       0.0 node /tmp/chat-bridge.js --agent-id abc --runtime codex
    """
    let codexBridge = codexRuntimeSnapshot(from: codexBridgeOnly)
    assertEqual(codexBridge.bridgeCount, 1, "Codex bridge should be counted as bridge")
    assertEqual(codexBridge.runtimeProcessCount, 0, "Codex bridge must not be counted as runtime")

    let codexRuntimeIdleCpu = """
       0.0 /usr/local/bin/codex --runtime codex --work
    """
    let codexRuntime = codexRuntimeSnapshot(from: codexRuntimeIdleCpu)
    assertEqual(codexRuntime.runtimeProcessCount, 1, "Codex runtime should count even with low CPU")
    assertEqual(codexRuntime.busyRuntimeCount, 0, "Low CPU runtime is present but not CPU-busy")

    let codexAppServerBusy = """
       12.5 ~/.npm-global/bin/codex app-server --listen stdio://
    """
    let appServerBusy = codexRuntimeSnapshot(from: codexAppServerBusy)
    assertEqual(appServerBusy.runtimeProcessCount, 1, "Busy Codex app-server should count as Codex activity source")
    assertEqual(appServerBusy.busyRuntimeCount, 1, "Busy Codex app-server should turn Codex yellow")

    let idleDecision = runtimeActivityDecision(
      snapshot: codexRuntime,
      hasOnlineSignal: true,
      now: 100,
      previousBusyUntil: nil,
      quietGraceInterval: 8
    )
    assertEqual(idleDecision.state, .idle, "Low CPU runtime should be idle without recent busy evidence")

    let recentBusyDecision = runtimeActivityDecision(
      snapshot: codexRuntime,
      hasOnlineSignal: true,
      now: 100,
      previousBusyUntil: 105,
      quietGraceInterval: 8
    )
    assertEqual(recentBusyDecision.state, .running, "Recent busy runtime should stay running during grace window")

    let slockBridgeOnly = """
       0.0 node /tmp/chat-bridge.js --agent-id old-man
    """
    let slockBridge = slockRuntimeSnapshot(from: slockBridgeOnly)
    assertEqual(slockBridge.bridgeCount, 1, "Slock bridge should be counted as bridge")
    assertEqual(slockBridge.runtimeProcessCount, 0, "Slock bridge must not be counted as runtime")

    let slockRuntimeIdleCpu = """
       0.0 /usr/local/bin/node worker.js --runtime-actions-only
    """
    let slockRuntime = slockRuntimeSnapshot(from: slockRuntimeIdleCpu)
    assertEqual(slockRuntime.runtimeProcessCount, 1, "Slock runtime should count even with low CPU")

    let appSource = try String(contentsOfFile: "TrafficLightApp.swift", encoding: .utf8)
    if appSource.contains("ServiceLight(name: \"Clowd\"") {
      fputs("FAIL: Clowder label must not be shortened to Clowd\n", stderr)
      exit(1)
    }
  }
}
