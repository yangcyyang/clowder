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

final class TrafficLightView: NSView {
  var state: LightState = .offline {
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

    drawLamp(centerX: pillRect.minX + pillRect.width * 0.24, color: colorFor(.idle))
    drawLamp(centerX: pillRect.midX, color: colorFor(.running))
    drawLamp(centerX: pillRect.minX + pillRect.width * 0.76, color: colorFor(.error))
  }

  private func colorFor(_ lamp: LightState) -> NSColor {
    guard state != .offline else { return dim }
    guard state == lamp else { return dim.withAlphaComponent(0.55) }
    switch lamp {
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

  private func drawLamp(centerX: CGFloat, color: NSColor) {
    let ringDiameter = bounds.height * 0.54
    let ringRect = NSRect(
      x: centerX - ringDiameter / 2,
      y: bounds.midY - ringDiameter / 2,
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
  private let lightView = TrafficLightView(frame: NSRect(x: 0, y: 0, width: 260, height: 112))
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
      contentRect: NSRect(x: 1400, y: 760, width: 260, height: 112),
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

    let root = NSView(frame: NSRect(x: 0, y: 0, width: 260, height: 112))
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
    var request = URLRequest(url: apiURL)
    request.timeoutInterval = 1.0

    URLSession.shared.dataTask(with: request) { [weak self] data, _, error in
      guard let self else { return }
      if error != nil {
        DispatchQueue.main.async {
          self.render(state: .offline, detail: "API 未连接")
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
          self.render(state: .offline, detail: "状态不可读")
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
        self.render(state: state, detail: detail)
      }
    }.resume()
  }

  private func render(state: LightState, detail: String) {
    lightView.state = state
    panel.contentView?.toolTip = "Clowder \(state.title)：\(detail)"
  }
}

let app = NSApplication.shared
let delegate = TrafficLightApp()
app.delegate = delegate
app.run()
