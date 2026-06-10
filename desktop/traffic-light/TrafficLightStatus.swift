import Foundation

struct RuntimeProcessSnapshot {
  let bridgeCount: Int
  let runtimeProcessCount: Int
  let busyRuntimeCount: Int

  var hasRuntimeProcess: Bool {
    runtimeProcessCount > 0
  }

  var hasBridge: Bool {
    bridgeCount > 0
  }
}

enum RuntimeActivityState: String {
  case offline
  case idle
  case running
}

struct RuntimeActivityDecision {
  let state: RuntimeActivityState
  let busyUntil: TimeInterval?
}

private func cpuPercent(from processLine: String) -> Double {
  let trimmed = processLine.trimmingCharacters(in: .whitespacesAndNewlines)
  let parts = trimmed.split(separator: " ", maxSplits: 1, omittingEmptySubsequences: true)
  return parts.first.flatMap { Double($0) } ?? 0
}

private func isTrafficLightProbe(_ normalizedLine: String) -> Bool {
  normalizedLine.contains("clowdertrafficlight") || normalizedLine.contains("/bin/ps ")
}

func codexRuntimeSnapshot(from processList: String) -> RuntimeProcessSnapshot {
  var bridgeCount = 0
  var runtimeProcessCount = 0
  var busyRuntimeCount = 0

  for rawLine in processList.split(separator: "\n") {
    let line = String(rawLine)
    let normalized = line.lowercased()
    let isCodexRuntime = normalized.contains("--runtime codex")
      || normalized.contains("--runtime\",\"codex")
      || normalized.contains("--runtime=codex")
    let isCodexProcess = isCodexRuntime
      || normalized.contains("codex app-server")
      || normalized.contains("/bin/codex")
      || normalized.contains("@openai/codex")
      || normalized.contains("opencode")
    guard isCodexProcess, !isTrafficLightProbe(normalized) else { continue }

    let bridgeOnly = normalized.contains("chat-bridge.js --agent-id")
    if bridgeOnly {
      bridgeCount += 1
      continue
    }

    runtimeProcessCount += 1
    if cpuPercent(from: line) >= 1.0 {
      busyRuntimeCount += 1
    }
  }

  return RuntimeProcessSnapshot(
    bridgeCount: bridgeCount,
    runtimeProcessCount: runtimeProcessCount,
    busyRuntimeCount: busyRuntimeCount
  )
}

func slockRuntimeSnapshot(from processList: String) -> RuntimeProcessSnapshot {
  var bridgeCount = 0
  var runtimeProcessCount = 0
  var busyRuntimeCount = 0

  for rawLine in processList.split(separator: "\n") {
    let line = String(rawLine)
    let normalized = line.lowercased()
    let isBridge = normalized.contains("chat-bridge.js")
    let isRuntime = normalized.contains("--runtime-actions-only")
    guard (isBridge || isRuntime), !isTrafficLightProbe(normalized) else { continue }

    if isBridge {
      bridgeCount += 1
    }

    // bridge 是常驻通道，不代表真实 agent turn；runtime 进程存在时保守视为运行中。
    if isRuntime && !isBridge {
      runtimeProcessCount += 1
      if cpuPercent(from: line) >= 1.0 {
        busyRuntimeCount += 1
      }
    }
  }

  return RuntimeProcessSnapshot(
    bridgeCount: bridgeCount,
    runtimeProcessCount: runtimeProcessCount,
    busyRuntimeCount: busyRuntimeCount
  )
}

func runtimeActivityDecision(
  snapshot: RuntimeProcessSnapshot,
  hasOnlineSignal: Bool,
  now: TimeInterval,
  previousBusyUntil: TimeInterval?,
  quietGraceInterval: TimeInterval
) -> RuntimeActivityDecision {
  if snapshot.busyRuntimeCount > 0 {
    return RuntimeActivityDecision(state: .running, busyUntil: now + quietGraceInterval)
  }

  if let previousBusyUntil, previousBusyUntil > now {
    return RuntimeActivityDecision(state: .running, busyUntil: previousBusyUntil)
  }

  if snapshot.hasRuntimeProcess || hasOnlineSignal {
    return RuntimeActivityDecision(state: .idle, busyUntil: nil)
  }

  return RuntimeActivityDecision(state: .offline, busyUntil: nil)
}
