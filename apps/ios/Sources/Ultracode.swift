import SwiftUI

/// Ultracode's colours: violet, apart from the clay of everything else, so a session at that level is plain to see.
enum UltracodeLook {
    static let violet = Color(hex: 0x8B5CF6)
    static let cool = Color(hex: 0x6D4AFF)
    static let hot = Color(hex: 0xC4B5FD)
}

/// The charged field drawn across the effort slider while it sits on Ultracode: a grid of small rounded cells, a violet bed
/// that brightens to the right, and wavefronts that leave the thumb and cross it, each cell lighting in a few steps and
/// cooling down after. It fades in when Ultracode is chosen and out when it is left, and holds still under Reduce Motion.
struct UltracodeField: View {
    /// Whether the slider is on Ultracode.
    let lit: Bool
    /// Where the waves start, in the field's own points.
    let origin: CGPoint
    /// When the field was lit and when it was left. A plain object read on every frame: values set from `onChange` did not
    /// reach the canvas, and the field stayed dark.
    private final class Timing { var litAt: Date?; var unlitAt: Date? }
    @State private var timing = Timing()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let period = 1.5
    private static let life = 2.6
    private static let speed = 190.0
    private static let rise = 0.7
    private static let fall = 0.85

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: !lit && (timing.unlitAt.map { Date().timeIntervalSince($0) > Self.fall } ?? true))) { context in
            Canvas { canvas, size in
                let now = context.date
                let envelope = envelope(at: now)
                guard envelope > 0.01 else { return }
                let time = now.timeIntervalSinceReferenceDate
                let started = (timing.litAt ?? now).timeIntervalSinceReferenceDate
                let pitch: CGFloat = 4, cell: CGFloat = 3
                let columns = max(1, Int(size.width / pitch))
                let rows = max(1, Int(size.height / pitch))
                let rowPitch = size.height / CGFloat(rows)
                // The waves still alive: one leaves every `period`, and each lasts `life`.
                let first = Int(floor((time - started) / Self.period))
                let waves = (0..<4).map { first - $0 }.filter { $0 >= 0 }.map { time - (started + Double($0) * Self.period) }.filter { $0 >= 0 && $0 <= Self.life }
                for column in 0..<columns {
                    let x = (CGFloat(column) + 0.5) * pitch
                    for row in 0..<rows {
                        let y = (CGFloat(row) + 0.5) * rowPitch
                        var energy = 0.0
                        if !reduceMotion {
                            let distance = hypot(Double(origin.x - x), Double(origin.y - y) * 0.7)
                            for age in waves {
                                let front = exp(-pow((distance - age * Self.speed) / 24, 2))
                                energy = max(energy, front * (1 - age / Self.life))
                            }
                        }
                        let step = (energy * 5).rounded() / 5
                        let bed = 0.13 + 0.12 * Double(x / size.width)
                        let alpha = min(1, bed + 0.75 * step) * envelope
                        let color = Self.mix(UltracodeLook.cool, UltracodeLook.hot, step).opacity(alpha)
                        let rect = CGRect(x: x - cell / 2, y: y - cell / 2, width: cell, height: cell)
                        canvas.fill(Path(roundedRect: rect, cornerRadius: 0.9), with: .color(color))
                    }
                }
            }
        }
        .allowsHitTesting(false)
    }

    private func envelope(at date: Date) -> Double {
        if lit {
            // Lit now: start the clock the first time, and again after it was left.
            if timing.litAt == nil || timing.unlitAt != nil { timing.litAt = date; timing.unlitAt = nil }
            return min(1, date.timeIntervalSince(timing.litAt ?? date) / Self.rise)
        }
        if timing.litAt != nil, timing.unlitAt == nil { timing.unlitAt = date }
        guard let left = timing.unlitAt else { return 0 }
        return max(0, 1 - date.timeIntervalSince(left) / Self.fall)
    }

    private static func mix(_ a: Color, _ b: Color, _ t: Double) -> Color {
        let first = UIColor(a), second = UIColor(b)
        var (r1, g1, b1, a1) = (CGFloat(0), CGFloat(0), CGFloat(0), CGFloat(0))
        var (r2, g2, b2, a2) = (CGFloat(0), CGFloat(0), CGFloat(0), CGFloat(0))
        first.getRed(&r1, green: &g1, blue: &b1, alpha: &a1)
        second.getRed(&r2, green: &g2, blue: &b2, alpha: &a2)
        let k = CGFloat(min(max(t, 0), 1))
        return Color(red: r1 + (r2 - r1) * k, green: g1 + (g2 - g1) * k, blue: b1 + (b2 - b1) * k)
    }
}

extension View {
    /// Lets `panel` take this box's place while `open` is on, bottom edges together; a tap anywhere else closes it.
    func coveredBy<Panel: View>(_ open: Binding<Bool>, @ViewBuilder panel: () -> Panel) -> some View {
        self
            .opacity(open.wrappedValue ? 0 : 1)
            .allowsHitTesting(!open.wrappedValue)
            .overlay(alignment: .bottom) {
                if open.wrappedValue {
                    panel()
                        .frame(maxWidth: .infinity)
                        .fixedSize(horizontal: false, vertical: true)
                        .raisedBox()
                        .background(alignment: .bottom) {
                            Color.black.opacity(0.18).frame(width: 3000, height: 3000)
                                .contentShape(Rectangle()).onTapGesture { open.wrappedValue = false }
                                .accessibilityHidden(true)
                        }
                        .transition(.opacity.combined(with: .scale(scale: 0.96, anchor: .bottom)))
                }
            }
            .animation(.snappy(duration: 0.22), value: open.wrappedValue)
    }
}
