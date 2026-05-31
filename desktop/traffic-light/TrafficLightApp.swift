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
    ServiceLight(name: "Codex", state: .idle, detail: "未检测到客户端进程"),
  ] {
    didSet { needsDisplay = true }
  }

  private let green = NSColor(calibratedRed: 0.72, green: 0.86, blue: 0.16, alpha: 1)
  private let yellow = NSColor(calibratedRed: 1.00, green: 0.69, blue: 0.26, alpha: 1)
  private let red = NSColor(calibratedRed: 0.94, green: 0.32, blue: 0.25, alpha: 1)
  private let dim = NSColor(calibratedWhite: 0.78, alpha: 1)

  override func draw(_ dirtyRect: NSRect) {
    super.draw(dirtyRect)
    NSColor.clear.setFill()
    dirtyRect.fill()

    let pillRect = bounds.insetBy(dx: 4, dy: 4)
    let pillPath = NSBezierPath(roundedRect: pillRect, xRadius: pillRect.height / 2, yRadius: pillRect.height / 2)

    let shadow = NSShadow()
    shadow.shadowBlurRadius = 0
    shadow.shadowOffset = NSSize(width: 3, height: -3)
    shadow.shadowColor = NSColor.black.withAlphaComponent(0.85)

    NSGraphicsContext.saveGraphicsState()
    shadow.set()
    NSColor(calibratedWhite: 0.80, alpha: 1).setFill()
    pillPath.fill()
    NSGraphicsContext.restoreGraphicsState()

    NSColor.black.setStroke()
    pillPath.lineWidth = 8
    pillPath.stroke()

    for (index, service) in services.prefix(3).enumerated() {
      let cellWidth = pillRect.width / 3
      let cellMidX = pillRect.minX + cellWidth * (CGFloat(index) + 0.5)
      drawService(service, centerX: cellMidX)
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

  private func drawService(_ service: ServiceLight, centerX: CGFloat) {
    drawLamp(center: NSPoint(x: centerX, y: bounds.midY + 12), color: colorFor(service.state))

    let title = service.name as NSString
    let attributes: [NSAttributedString.Key: Any] = [
      .font: NSFont.monospacedSystemFont(ofSize: 12, weight: .bold),
      .foregroundColor: NSColor.black,
    ]
    let size = title.size(withAttributes: attributes)
    title.draw(
      at: NSPoint(x: centerX - size.width / 2, y: bounds.midY - 38),
      withAttributes: attributes
    )
  }

  private func drawLamp(center: NSPoint, color: NSColor) {
    let ringDiameter = bounds.height * 0.36
    let ringRect = NSRect(
      x: center.x - ringDiameter / 2,
      y: center.y - ringDiameter / 2,
      width: ringDiameter,
      height: ringDiameter
    )
    NSColor.black.setFill()
    NSBezierPath(ovalIn: ringRect).fill()

    let innerRect = ringRect.insetBy(dx: ringDiameter * 0.18, dy: ringDiameter * 0.18)
    color.setFill()
    NSBezierPath(ovalIn: innerRect).fill()
  }
}

final class TrafficLightApp: NSObject, NSApplicationDelegate {
  private var panel: NSPanel!
  private let windowSize = NSSize(width: 300, height: 120)
  private let lightView = TrafficLightView(frame: NSRect(x: 0, y: 0, width: 300, height: 120))
  private var timer: Timer?

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
      contentRect: NSRect(x: 1300, y: 760, width: windowSize.width, height: windowSize.height),
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
    let slock = checkProcess(pattern: "slock.*daemon|slock-daemon")
      ? ServiceLight(name: "Slock", state: .idle, detail: "daemon 在线")
      : ServiceLight(name: "Slock", state: .offline, detail: "daemon 未运行")
    let codex = checkProcess(pattern: "opencode|codex")
      ? ServiceLight(name: "Codex", state: .running, detail: "检测到客户端进程")
      : ServiceLight(name: "Codex", state: .idle, detail: "未检测到客户端进程")

    var request = URLRequest(url: apiURL)
    request.timeoutInterval = 1.0

    URLSession.shared.dataTask(with: request) { [weak self] data, _, error in
      guard let self else { return }
      if error != nil {
        DispatchQueue.main.async {
          self.render(services: [
            ServiceLight(name: "Clowder", state: .offline, detail: "API 未连接"),
            slock,
            codex,
          ])
        }
        return
      }
      guard
        let data,
        let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let stateRaw = json["state"] as? String,
        let state = LightState(rawValue: stateRaw)
      else {
        DispatchQueue.main.async {
          self.render(services: [
            ServiceLight(name: "Clowder", state: .offline, detail: "状态不可读"),
            slock,
            codex,
          ])
        }
        return
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

      DispatchQueue.main.async {
        self.render(services: [
          ServiceLight(name: "Clowder", state: state, detail: detail),
          slock,
          codex,
        ])
      }
    }.resume()
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

  private func render(services: [ServiceLight]) {
    lightView.services = services
    panel.contentView?.toolTip = services
      .map { "\($0.name) \($0.state.title)：\($0.detail)" }
      .joined(separator: "\n")
  }
}

let app = NSApplication.shared
let delegate = TrafficLightApp()
app.delegate = delegate
app.run()
