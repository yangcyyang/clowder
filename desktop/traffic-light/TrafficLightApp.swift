import Cocoa

enum LightState: String {
  case idle
  case running
  case error
  case offline

  var title: String {
    switch self {
    case .idle:
      return "空闲"
    case .running:
      return "运行中"
    case .error:
      return "失败"
    case .offline:
      return "离线"
    }
  }
}

struct ServiceLight {
  let name: String
  let state: LightState
  let detail: String
}

final class TrafficLightView: NSView {
  var services: [ServiceLight] = [
    ServiceLight(name: "Clowder", state: .offline, detail: "API 未连接"),
    ServiceLight(name: "Slock", state: .offline, detail: "daemon 未运行"),
    ServiceLight(name: "Codex", state: .offline, detail: "未检测到客户端进程"),
  ] {
    didSet { needsDisplay = true }
  }

  private let green = NSColor(calibratedRed: 0.72, green: 0.86, blue: 0.16, alpha: 1)
  private let yellow = NSColor(calibratedRed: 1.00, green: 0.69, blue: 0.26, alpha: 1)
  private let red = NSColor(calibratedRed: 0.94, green: 0.32, blue: 0.25, alpha: 1)
  private let dim = NSColor(calibratedWhite: 0.48, alpha: 1)

  override func draw(_ dirtyRect: NSRect) {
    super.draw(dirtyRect)
    NSColor.clear.setFill()
    dirtyRect.fill()

    let barRect = bounds.insetBy(dx: 2, dy: 2)
    let barPath = NSBezierPath(roundedRect: barRect, xRadius: 10, yRadius: 10)
    NSColor(calibratedRed: 0.07, green: 0.10, blue: 0.16, alpha: 0.98).setFill()
    barPath.fill()

    for (index, service) in services.prefix(3).enumerated() {
      let cellWidth = barRect.width / 3
      let cellMinX = barRect.minX + cellWidth * CGFloat(index)
      drawService(service, x: cellMinX + 16, width: cellWidth - 24)
    }
  }

  private func colorFor(_ state: LightState) -> NSColor {
    switch state {
    case .idle:
      return green
    case .running:
      return yellow
    case .error:
      return red
    case .offline:
      return dim
    }
  }

  private func drawService(_ service: ServiceLight, x: CGFloat, width: CGFloat) {
    drawLamp(center: NSPoint(x: x + 8, y: bounds.midY), color: colorFor(service.state))

    let title = service.name as NSString
    let attributes: [NSAttributedString.Key: Any] = [
      .font: NSFont.monospacedSystemFont(ofSize: 17, weight: .regular),
      .foregroundColor: NSColor.white,
    ]
    title.draw(
      in: NSRect(x: x + 28, y: bounds.midY - 12, width: width - 28, height: 24),
      withAttributes: attributes
    )
  }

  private func drawLamp(center: NSPoint, color: NSColor) {
    let ringDiameter: CGFloat = 16
    let ringRect = NSRect(
      x: center.x - ringDiameter / 2,
      y: center.y - ringDiameter / 2,
      width: ringDiameter,
      height: ringDiameter
    )
    NSColor.black.withAlphaComponent(0.18).setFill()
    NSBezierPath(ovalIn: ringRect.offsetBy(dx: 0, dy: -1)).fill()
    color.setFill()
    NSBezierPath(ovalIn: ringRect).fill()
  }
}

final class TrafficLightApp: NSObject, NSApplicationDelegate {
  private var panel: NSPanel!
  private let windowSize = NSSize(width: 420, height: 56)
  private let lightView = TrafficLightView(frame: NSRect(x: 0, y: 0, width: 420, height: 56))
  private var timer: Timer?
  private var codexBusyUntil: TimeInterval?
  private var slockBusyUntil: TimeInterval?
  private let runtimeQuietGraceInterval: TimeInterval = 8

  private let apiURL = URL(string: ProcessInfo.processInfo.environment["CLOWDER_API_URL"] ?? "http://127.0.0.1:3004/api/runtime/traffic-light")!
  private let webURL = URL(string: ProcessInfo.processInfo.environment["CLOWDER_WEB_URL"] ?? "http://127.0.0.1:3003")!

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory)
    createPanel()
    poll()
    timer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in
      self?.poll()
    }
  }

  private func createPanel() {
    panel = NSPanel(
      contentRect: NSRect(x: 1320, y: 820, width: windowSize.width, height: windowSize.height),
      styleMask: [.nonactivatingPanel, .borderless],
      backing: .buffered,
      defer: false
    )
    panel.title = "Clowder Traffic Light"
    panel.level = .floating
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    panel.isMovableByWindowBackground = true
    panel.backgroundColor = NSColor.clear
    panel.isOpaque = false
    panel.hasShadow = true

    let root = NSView(frame: NSRect(origin: .zero, size: windowSize))
    root.wantsLayer = true

    root.addSubview(lightView)

    let click = NSClickGestureRecognizer(target: self, action: #selector(openClowder))
    root.addGestureRecognizer(click)

    panel.contentView = root
    panel.orderFrontRegardless()
  }

  @objc private func openClowder() {
    NSWorkspace.shared.open(webURL)
  }

  private func poll() {
    let clowder = clowderServiceLight()
    let slock = slockServiceLight()
    let codex = codexServiceLight()

    render(services: [clowder, slock, codex])
  }

  private func clowderServiceLight() -> ServiceLight {
    let output = commandOutput(
      executable: "/usr/bin/curl",
      arguments: ["-sS", "-m", "1", apiURL.absoluteString]
    )
    guard
      let data = output.data(using: .utf8),
      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let stateRaw = json["state"] as? String,
      let state = LightState(rawValue: stateRaw)
    else {
      return ServiceLight(name: "Clowder", state: .offline, detail: "API 未连接或状态不可读")
    }

    let running = json["runningCount"] as? Int ?? 0
    let queued = json["queuedCount"] as? Int ?? 0
    let lastAgent = json["lastAgent"] as? String
    let detail: String
    switch state {
    case .running:
      detail = "\(running) 运行 / \(queued) 排队"
    case .idle:
      detail = lastAgent.map { "最近完成 \($0)" } ?? "当前空闲"
    case .error:
      detail = lastAgent.map { "最近失败 \($0)" } ?? "最近失败"
    case .offline:
      detail = "API 未连接"
    }

    return ServiceLight(name: "Clowder", state: state, detail: detail)
  }

  private func slockServiceLight() -> ServiceLight {
    let snapshot = currentSlockRuntimeSnapshot()
    let online = snapshot.hasBridge || isSlockDaemonOnline()
    let decision = runtimeActivityDecision(
      snapshot: snapshot,
      hasOnlineSignal: online,
      now: Date().timeIntervalSince1970,
      previousBusyUntil: slockBusyUntil,
      quietGraceInterval: runtimeQuietGraceInterval
    )
    slockBusyUntil = decision.busyUntil

    switch decision.state {
    case .running:
      let detail = snapshot.busyRuntimeCount > 0
        ? "\(snapshot.busyRuntimeCount) 个 runtime 活跃"
        : "刚检测到 runtime 活跃，短暂保持运行中"
      return ServiceLight(name: "Slock", state: .running, detail: detail)
    case .idle:
      let detail = snapshot.hasRuntimeProcess
        ? "\(snapshot.runtimeProcessCount) 个 runtime 在线但持续安静"
        : "daemon 在线，当前未检测到忙碌 runtime"
      return ServiceLight(name: "Slock", state: .idle, detail: detail)
    case .offline:
      return ServiceLight(name: "Slock", state: .offline, detail: "daemon 未运行")
    }
  }

  private func codexServiceLight() -> ServiceLight {
    let snapshot = currentCodexRuntimeSnapshot()
    let online = snapshot.hasBridge || checkProcess(pattern: "opencode|codex")
    let decision = runtimeActivityDecision(
      snapshot: snapshot,
      hasOnlineSignal: online,
      now: Date().timeIntervalSince1970,
      previousBusyUntil: codexBusyUntil,
      quietGraceInterval: runtimeQuietGraceInterval
    )
    codexBusyUntil = decision.busyUntil

    switch decision.state {
    case .running:
      let detail = snapshot.busyRuntimeCount > 0
        ? "\(snapshot.busyRuntimeCount) 个 Codex runtime 活跃"
        : "刚检测到 Codex runtime 活跃，短暂保持运行中"
      return ServiceLight(name: "Codex", state: .running, detail: detail)
    case .idle:
      let detail = snapshot.hasRuntimeProcess
        ? "\(snapshot.runtimeProcessCount) 个 Codex runtime 在线但持续安静"
        : "客户端在线，未检测到活跃 runtime"
      return ServiceLight(name: "Codex", state: .idle, detail: detail)
    case .offline:
      return ServiceLight(name: "Codex", state: .offline, detail: "未检测到客户端进程")
    }
  }

  private func currentCodexRuntimeSnapshot() -> RuntimeProcessSnapshot {
    let output = commandOutput(executable: "/bin/ps", arguments: ["-axo", "pcpu=,command="])
    return codexRuntimeSnapshot(from: output)
  }

  private func currentSlockRuntimeSnapshot() -> RuntimeProcessSnapshot {
    let output = commandOutput(executable: "/bin/ps", arguments: ["-axo", "pcpu=,command="])
    return slockRuntimeSnapshot(from: output)
  }

  private func isSlockDaemonOnline() -> Bool {
    let machinesURL = FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent(".slock/machines")
    guard let machineDirs = try? FileManager.default.contentsOfDirectory(
      at: machinesURL,
      includingPropertiesForKeys: nil,
      options: [.skipsHiddenFiles]
    ) else {
      return false
    }

    for machineDir in machineDirs {
      let ownerURL = machineDir.appendingPathComponent("daemon.lock/owner.json")
      guard
        let data = try? Data(contentsOf: ownerURL),
        let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let pid = json["pid"] as? Int
      else {
        continue
      }
      if checkPid(pid) {
        return true
      }
    }
    return false
  }

  private func checkPid(_ pid: Int) -> Bool {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/kill")
    process.arguments = ["-0", String(pid)]
    process.standardOutput = Pipe()
    process.standardError = Pipe()

    do {
      try process.run()
      process.waitUntilExit()
      return process.terminationStatus == 0
    } catch {
      return false
    }
  }

  private func checkProcess(pattern: String) -> Bool {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/pgrep")
    process.arguments = ["-f", pattern]
    process.standardOutput = Pipe()
    process.standardError = Pipe()

    do {
      try process.run()
      process.waitUntilExit()
      return process.terminationStatus == 0
    } catch {
      return false
    }
  }

  private func commandOutput(executable: String, arguments: [String]) -> String {
    let process = Process()
    let output = Pipe()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    process.standardOutput = output
    process.standardError = Pipe()

    do {
      try process.run()
      let data = output.fileHandleForReading.readDataToEndOfFile()
      process.waitUntilExit()
      return String(data: data, encoding: .utf8) ?? ""
    } catch {
      return ""
    }
  }

  private func render(services: [ServiceLight]) {
    lightView.services = services
    panel.contentView?.toolTip = services
      .map { "\($0.name) \($0.state.title)：\($0.detail)" }
      .joined(separator: "\n")
  }
}

@main
struct ClowderTrafficLightMain {
  static func main() {
    let app = NSApplication.shared
    let delegate = TrafficLightApp()
    app.delegate = delegate
    app.run()
  }
}
