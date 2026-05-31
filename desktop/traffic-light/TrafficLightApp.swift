import Cocoa

enum LightState: String {
  case idle
  case running
  case error
  case offline

  var color: NSColor {
    switch self {
    case .idle:
      return NSColor(calibratedRed: 0.20, green: 0.78, blue: 0.34, alpha: 1)
    case .running:
      return NSColor(calibratedRed: 1.00, green: 0.78, blue: 0.16, alpha: 1)
    case .error:
      return NSColor(calibratedRed: 0.94, green: 0.20, blue: 0.20, alpha: 1)
    case .offline:
      return NSColor(calibratedWhite: 0.48, alpha: 1)
    }
  }

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

final class LightView: NSView {
  var state: LightState = .offline {
    didSet { needsDisplay = true }
  }

  override func draw(_ dirtyRect: NSRect) {
    super.draw(dirtyRect)
    NSColor.clear.setFill()
    dirtyRect.fill()

    let diameter = min(bounds.width, bounds.height) - 8
    let rect = NSRect(
      x: (bounds.width - diameter) / 2,
      y: (bounds.height - diameter) / 2,
      width: diameter,
      height: diameter
    )

    let shadow = NSShadow()
    shadow.shadowBlurRadius = 0
    shadow.shadowOffset = NSSize(width: 3, height: -3)
    shadow.shadowColor = NSColor.black.withAlphaComponent(0.85)

    NSGraphicsContext.saveGraphicsState()
    shadow.set()
    state.color.setFill()
    NSBezierPath(ovalIn: rect).fill()
    NSGraphicsContext.restoreGraphicsState()

    NSColor.black.setStroke()
    let path = NSBezierPath(ovalIn: rect)
    path.lineWidth = 2
    path.stroke()
  }
}

final class TrafficLightApp: NSObject, NSApplicationDelegate {
  private var panel: NSPanel!
  private let lightView = LightView(frame: NSRect(x: 12, y: 30, width: 54, height: 54))
  private let titleLabel = NSTextField(labelWithString: "Clowder")
  private let detailLabel = NSTextField(labelWithString: "连接中…")
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
      contentRect: NSRect(x: 1400, y: 760, width: 220, height: 96),
      styleMask: [.nonactivatingPanel, .titled, .fullSizeContentView],
      backing: .buffered,
      defer: false
    )
    panel.title = "Clowder Traffic Light"
    panel.level = .floating
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    panel.isMovableByWindowBackground = true
    panel.titlebarAppearsTransparent = true
    panel.backgroundColor = NSColor(calibratedRed: 1.0, green: 0.98, blue: 0.92, alpha: 0.96)
    panel.isOpaque = false
    panel.hasShadow = true

    let root = NSView(frame: NSRect(x: 0, y: 0, width: 220, height: 96))
    root.wantsLayer = true
    root.layer?.borderWidth = 2
    root.layer?.borderColor = NSColor.black.cgColor
    root.layer?.cornerRadius = 0

    titleLabel.frame = NSRect(x: 78, y: 54, width: 120, height: 22)
    titleLabel.font = NSFont.boldSystemFont(ofSize: 15)
    titleLabel.textColor = NSColor.black

    detailLabel.frame = NSRect(x: 78, y: 28, width: 130, height: 22)
    detailLabel.font = NSFont.systemFont(ofSize: 12)
    detailLabel.textColor = NSColor.darkGray

    root.addSubview(lightView)
    root.addSubview(titleLabel)
    root.addSubview(detailLabel)

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
    titleLabel.stringValue = "Clowder \(state.title)"
    detailLabel.stringValue = detail
  }
}

let app = NSApplication.shared
let delegate = TrafficLightApp()
app.delegate = delegate
app.run()
