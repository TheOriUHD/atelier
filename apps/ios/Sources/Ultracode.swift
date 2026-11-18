import SwiftUI

/// Ultracode's colours: violet, apart from the clay of everything else, so a session at that level is plain to see.
enum UltracodeLook {
    static let violet = Color(hex: 0x8B5CF6)
    static let cool = Color(hex: 0x6D4AFF)
    static let hot = Color(hex: 0xC4B5FD)
}

/// How charged the Ultracode field is over time, as plain data so its rules can be tested: it rises over `rise` seconds while
/// the slider is on Ultracode and falls over `fall` when it is left, always from where it is (a quick back and forth does not
/// jump), and `waveStart` is the clock its wavefronts run on (a new pattern each time it is charged from nothing).
struct UltracodeCharge: Equatable {
    static let rise = 0.7
    static let fall = 0.85

    private(set) var level = 0.0
    private(set) var waveStart: Date?
    private var since: Date?
    private var lit = false

    /// The level at `date`, with the slider now on or off Ultracode. Call it on every frame: the level is carried from one
    /// call to the next in the direction the slider had then.
    mutating func level(at date: Date, lit now: Bool) -> Double {
        if let since {
            let elapsed = max(0, date.timeIntervalSince(since))
            level = lit ? min(1, level + elapsed / Self.rise) : max(0, level - elapsed / Self.fall)
        }
        since = date
        if now, level == 0 || waveStart == nil { waveStart = date }
        if !now, level == 0 { waveStart = nil }
        lit = now
        return level
    }

    /// Whether anything of the field shows: nothing is drawn once it is off and has fallen to nothing.
    var isEmpty: Bool { level <= 0.01 && !lit }
}

/// The charged field drawn across the effort slider while it sits on Ultracode: a grid of small rounded cells, a violet bed
/// that brightens to the right, and wavefronts that leave the thumb and cross it, each cell lighting in a few steps and
/// cooling down after. It fades in when Ultracode is chosen and out when it is left, and holds still under Reduce Motion.
struct UltracodeField: View {
    /// Whether the slider is on Ultracode.
    let lit: Bool
    /// Where the waves start, in the field's own points.
    let origin: CGPoint
    /// What the canvas reads on every frame: a plain object, because values set from `onChange` did not reach the canvas and the
    /// field stayed dark.
    private final class Timing { var charge = UltracodeCharge() }
    @State private var timing = Timing()
    /// True while nothing is showing and nothing is lit: only then may the frames stop. They must not stop before the field has
    /// fallen to nothing and that empty frame was drawn, or the canvas keeps the last frame it drew, still lit, over the track
    /// (the same bug the desktop app had). It is state, not part of `timing`, so that changing it runs `body` again.
    @State private var settled = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let period = 1.5
    private static let life = 2.6
    private static let speed = 190.0

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: settled && !lit)) { context in
            Canvas { canvas, size in
                let now = context.date
                let level = timing.charge.level(at: now, lit: lit)
                // Smoothstep, as on the desktop: a cooling field loses its steps one by one.
                let envelope = level * level * (3 - 2 * level)
                guard envelope > 0.01 else { return }
                let time = now.timeIntervalSinceReferenceDate
                let started = (timing.charge.waveStart ?? now).timeIntervalSinceReferenceDate
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
        // Lit: running. Left: keep running through the fall (and a moment more, so the empty frame is drawn), then stop.
        .task(id: lit) {
            if lit { settled = false }
            else if !settled {
                try? await Task.sleep(for: .seconds(UltracodeCharge.fall + 0.2))
                if !Task.isCancelled { settled = true }
            }
        }
        // Gone from the screen while lit or falling (the panel closed): the next time starts cold and empty.
        .onDisappear { timing.charge = UltracodeCharge(); settled = true }
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
                            // From far above the panel to far below it: the strip under it (the home indicator's) is dimmed too.
                            Color.black.opacity(0.18).frame(width: 3000, height: 6000).offset(y: 3000)
                                .contentShape(Rectangle()).onTapGesture { open.wrappedValue = false }
                                .accessibilityHidden(true)
                        }
                        .transition(.opacity.combined(with: .scale(scale: 0.96, anchor: .bottom)))
                }
            }
            .animation(.snappy(duration: 0.22), value: open.wrappedValue)
    }
}
