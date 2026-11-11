import AppKit
import QuartzCore

/// The software cursor (`bg.cursor`): a small clay arrow the helper draws where background work happens, in a window of
/// its own ordered just above the window it works in. Windows in front of that one (the person's) stay in front of the
/// cursor too, so it never covers what they are doing; the real pointer never moves. It glides to each new point,
/// ripples where it clicked, and fades out after a few seconds still. ChatGPT's computer use draws one the same way.
/// It isn't in the window's own screenshots (those capture that window alone); Full control hides it before it looks.
@MainActor
final class SoftwareCursor {
  static let shared = SoftwareCursor()

  /// The window's size in points; the arrow's tip sits at `tip` inside it, with room for the glow and the ripple.
  static let size = CGSize(width: 64, height: 64)
  static let tip = CGPoint(x: 22, y: 22)
  /// Still this long, it fades out.
  static let idle: TimeInterval = 4

  private var window: NSWindow?
  private var ripple: CAShapeLayer?
  /// Counts shows: a fade that ends after a newer show leaves the window up.
  private var generation = 0

  /// Where the window's origin goes (Cocoa's bottom-left coordinates) for the tip at `point` (global, top-left origin).
  static func origin(for point: CGPoint, primaryHeight: CGFloat) -> CGPoint {
    CGPoint(x: point.x - tip.x, y: primaryHeight - point.y - (size.height - tip.y))
  }

  /// The arrow, its tip at (0, 0), pointing up and to the left, in a layer's own coordinates (y up, as AppKit keeps a
  /// hosted layer).
  static func arrowPath() -> CGPath {
    let path = CGMutablePath()
    path.move(to: .zero)
    for (x, y) in [(0, 21), (5.2, 16.2), (8.8, 24.4), (12.2, 22.9), (8.7, 14.9), (15.6, 14.9)] as [(CGFloat, CGFloat)] {
      path.addLine(to: CGPoint(x: x, y: -y))
    }
    path.closeSubpath()
    return path
  }

  /// The tip in the window's layer (y up).
  static var tipInLayer: CGPoint { CGPoint(x: tip.x, y: size.height - tip.y) }

  /// Shows the cursor at `point` above `windowID` (moving there from where it was), with a ripple for a click.
  func show(at point: CGPoint, above windowID: CGWindowID, click: Bool) {
    // Only over a window that is on this screen now: ordered above one that isn't, it would float over everything.
    guard Windows.list(onScreenOnly: true).contains(where: { $0.id == windowID }) else {
      hide()
      return
    }
    let window = self.window ?? make()
    let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
    let origin = Self.origin(for: point, primaryHeight: primaryHeight)
    generation += 1
    let shown = generation
    if window.isVisible, window.alphaValue > 0.5 {
      NSAnimationContext.runAnimationGroup { context in
        context.duration = 0.22
        context.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        window.animator().setFrameOrigin(origin)
      }
    } else {
      window.setFrameOrigin(origin)
      window.alphaValue = 0
      NSAnimationContext.runAnimationGroup { context in
        context.duration = 0.15
        window.animator().alphaValue = 1
      }
    }
    window.order(.above, relativeTo: Int(windowID))
    if click { rippleOnce() }
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.idle) { [weak self] in
      MainActor.assumeIsolated { self?.fadeOut(shown) }
    }
  }

  func hide() {
    generation += 1
    window?.orderOut(nil)
  }

  /// Fades out when nothing was shown since show number `shown`.
  private func fadeOut(_ shown: Int) {
    guard let window, shown == generation else { return }
    NSAnimationContext.runAnimationGroup({ context in
      context.duration = 0.4
      window.animator().alphaValue = 0
    }, completionHandler: { [weak self] in
      MainActor.assumeIsolated {
        guard let self, shown == self.generation else { return }
        window.orderOut(nil)
      }
    })
  }

  private func make() -> NSWindow {
    // A helper started from Terminal or from Atelier has no app object yet: one that never shows in the Dock or the
    // app switcher and is never activated (the window ignores the mouse, so nothing can activate it).
    let app = NSApplication.shared
    if app.activationPolicy() != .accessory { app.setActivationPolicy(.accessory) }
    let window = NSWindow(contentRect: NSRect(origin: .zero, size: Self.size), styleMask: .borderless, backing: .buffered, defer: false)
    window.isOpaque = false
    window.backgroundColor = .clear
    window.hasShadow = false
    window.ignoresMouseEvents = true
    window.level = .normal
    window.isReleasedWhenClosed = false
    window.animationBehavior = .none
    window.collectionBehavior = [.transient, .ignoresCycle, .fullScreenAuxiliary]

    let view = NSView(frame: NSRect(origin: .zero, size: Self.size))
    view.wantsLayer = true
    let root = CALayer()
    root.frame = view.bounds
    view.layer = root

    let ripple = CAShapeLayer()
    ripple.path = CGPath(ellipseIn: CGRect(x: -14, y: -14, width: 28, height: 28), transform: nil)
    ripple.position = Self.tipInLayer
    ripple.fillColor = NSColor(srgbRed: 0.776, green: 0.380, blue: 0.247, alpha: 0.35).cgColor
    ripple.opacity = 0
    root.addSublayer(ripple)
    self.ripple = ripple

    let arrow = CAShapeLayer()
    arrow.path = Self.arrowPath()
    arrow.position = Self.tipInLayer
    // Atelier's clay with a white edge and a soft clay glow, readable on light and dark windows.
    arrow.fillColor = NSColor(srgbRed: 0.776, green: 0.380, blue: 0.247, alpha: 1).cgColor
    arrow.strokeColor = NSColor.white.cgColor
    arrow.lineWidth = 1.6
    arrow.lineJoin = .round
    arrow.shadowColor = NSColor(srgbRed: 0.776, green: 0.380, blue: 0.247, alpha: 1).cgColor
    arrow.shadowOpacity = 0.55
    arrow.shadowRadius = 6
    arrow.shadowOffset = .zero
    root.addSublayer(arrow)

    window.contentView = view
    self.window = window
    return window
  }

  private func rippleOnce() {
    guard let ripple else { return }
    let scale = CABasicAnimation(keyPath: "transform.scale")
    scale.fromValue = 0.4
    scale.toValue = 1.3
    let opacity = CABasicAnimation(keyPath: "opacity")
    opacity.fromValue = 1
    opacity.toValue = 0
    let group = CAAnimationGroup()
    group.animations = [scale, opacity]
    group.duration = 0.45
    group.timingFunction = CAMediaTimingFunction(name: .easeOut)
    ripple.add(group, forKey: "ripple")
  }
}
