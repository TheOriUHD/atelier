import SwiftUI

/// Atelier's look on iPhone and iPad: the same warm paper, ink and clay as the desktop app (design/tokens), with the
/// system's own type (SF for the interface, New York for what the assistant writes) and iOS 26's glass for controls.
enum Theme {
    static let clay = Color(hex: 0xC6613F)
    static let clayBright = Color(hex: 0xD97757)
    static let background = Color.adaptive(light: 0xFCFCFB, dark: 0x151515)
    /// Behind lists and sidebars: a step away from the page.
    static let sunken = Color.adaptive(light: 0xF5F4F1, dark: 0x101010)
    static let surface = Color.adaptive(light: 0xFFFFFF, dark: 0x20201F)
    static let ink = Color.adaptive(light: 0x0B0B0B, dark: 0xF0EFEC)
    static let inkSecondary = Color.adaptive(light: 0x52514E, dark: 0xC3C2B7)
    static let inkMuted = Color.adaptive(light: 0x686762, dark: 0x9C9A94)
    static let hairline = Color.adaptive(light: 0x0B0B0B, lightAlpha: 0.09, dark: 0xFFFFFF, darkAlpha: 0.10)
    /// A person's own message, and quiet fills.
    static let fill = Color.adaptive(light: 0x0B0B0B, lightAlpha: 0.055, dark: 0xFFFFFF, darkAlpha: 0.08)
    static let fillStrong = Color.adaptive(light: 0x0B0B0B, lightAlpha: 0.10, dark: 0xFFFFFF, darkAlpha: 0.15)
    static let danger = Color.adaptive(light: 0xC22F2F, dark: 0xEC7E7E)
    static let success = Color.adaptive(light: 0x1E7A1E, dark: 0x4FBF4F)
    static let added = Color.adaptive(light: 0x1E7A1E, lightAlpha: 0.10, dark: 0x4FBF4F, darkAlpha: 0.14)
    static let removed = Color.adaptive(light: 0xC22F2F, lightAlpha: 0.10, dark: 0xEC7E7E, darkAlpha: 0.14)
    static let waiting = Color(hex: 0xE0A21B)

    /// Debug builds launched with `--expand` open every fold, to look at what is inside.
    static var expandedForDemo: Bool {
        #if DEBUG
        ProcessInfo.processInfo.arguments.contains("--expand")
        #else
        false
        #endif
    }

    /// Page widths on iPad: a conversation reads best at about 700 points.
    static let readingWidth: CGFloat = 700
}

extension Color {
    init(hex: UInt32, opacity: Double = 1) {
        self.init(.sRGB, red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255, opacity: opacity)
    }
    static func adaptive(light: UInt32, lightAlpha: Double = 1, dark: UInt32, darkAlpha: Double = 1) -> Color {
        Color(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark ? UIColor(hex: dark, alpha: darkAlpha) : UIColor(hex: light, alpha: lightAlpha)
        })
    }
}

private extension UIColor {
    convenience init(hex: UInt32, alpha: Double = 1) {
        self.init(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: alpha)
    }
}

extension Font {
    /// What the assistant writes, and greetings and titles: New York.
    static func reading(_ style: Font.TextStyle = .body, weight: Font.Weight = .regular) -> Font { .system(style, design: .serif, weight: weight) }
    static func mono(_ style: Font.TextStyle = .footnote) -> Font { .system(style, design: .monospaced) }
}

/// The clay rounded square with the palette mark: Atelier's icon.
struct AtelierMark: View {
    var size: CGFloat = 56
    var body: some View {
        RoundedRectangle(cornerRadius: size * 0.225, style: .continuous)
            .fill(LinearGradient(colors: [Color(hex: 0xDE8463), Color(hex: 0xC6613F)], startPoint: .top, endPoint: .bottom))
            .overlay(RoundedRectangle(cornerRadius: size * 0.225, style: .continuous).stroke(.black.opacity(0.08), lineWidth: 0.5))
            .overlay(Image(systemName: "paintpalette.fill").font(.system(size: size * 0.46, weight: .regular)).foregroundStyle(Color(hex: 0xFBF8F2)))
            .frame(width: size, height: size)
            .shadow(color: Theme.clay.opacity(0.28), radius: size * 0.18, y: size * 0.07)
            .accessibilityHidden(true)
    }
}

/// A conversation's state at a glance: working, waiting for an answer, or a reply you haven't seen.
struct StatusDot: View {
    enum Kind { case running, waiting, unseen }
    let kind: Kind
    @State private var pulse = false
    var body: some View {
        Circle()
            .fill(kind == .waiting ? Theme.waiting : Theme.clay)
            .frame(width: 8, height: 8)
            .opacity(kind == .running ? (pulse ? 0.35 : 1) : 1)
            .animation(kind == .running ? .easeInOut(duration: 0.9).repeatForever(autoreverses: true) : .default, value: pulse)
            .onAppear { pulse = true }
            .accessibilityLabel(kind == .running ? "Working" : kind == .waiting ? "Needs your answer" : "New reply")
    }
}

/// A person's initial on clay, for the account button.
struct Avatar: View {
    let name: String
    var size: CGFloat = 30
    /// A fine light edge, so the circle holds its shape against any background.
    var ring = false
    var body: some View {
        Text(name.trimmingCharacters(in: .whitespaces).first.map { String($0).uppercased() } ?? "A")
            .font(.system(size: size * 0.46, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(Theme.clay.gradient, in: Circle())
            .overlay(Circle().strokeBorder(.white.opacity(ring ? 0.35 : 0), lineWidth: 1))
            .shadow(color: Theme.clay.opacity(ring ? 0.28 : 0), radius: 5, y: 2)
            .contentShape(Circle())
            .accessibilityHidden(true)
    }
}

/// The main action: clay, full width, with a spinner while it works.
struct ClayButtonStyle: ButtonStyle {
    var busy = false
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 8) {
            configuration.label
            if busy { ProgressView().tint(.white) }
        }
        .font(.system(.body, weight: .semibold))
        .foregroundStyle(.white)
        .frame(maxWidth: .infinity, minHeight: 50)
        .background(Theme.clay.opacity(enabled ? 1 : 0.38), in: Capsule())
        .scaleEffect(configuration.isPressed ? 0.985 : 1)
        .animation(.spring(duration: 0.2), value: configuration.isPressed)
    }
}

/// A quiet second action beside the main one.
struct QuietButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(.body, weight: .medium))
            .foregroundStyle(Theme.ink)
            .frame(maxWidth: .infinity, minHeight: 50)
            .background(Theme.fill, in: Capsule())
            .scaleEffect(configuration.isPressed ? 0.985 : 1)
            .animation(.spring(duration: 0.2), value: configuration.isPressed)
    }
}

/// A rounded card on the page: the surface colour with a hairline, as the desktop's popovers.
struct CardBackground: ViewModifier {
    var radius: CGFloat = 20
    func body(content: Content) -> some View {
        content
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).stroke(Theme.hairline, lineWidth: 0.5))
    }
}
extension View {
    func card(radius: CGFloat = 20) -> some View { modifier(CardBackground(radius: radius)) }
}

extension View {
    /// A raised surface for the message box and the panels that replace it. It is solid on purpose: glass picks a light or a dark
    /// look from what is behind it, and over a moving conversation that showed as a flash of the other mode.
    func raisedBox(radius: CGFloat = 28) -> some View {
        self
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(Theme.hairline, lineWidth: 1))
            .shadow(color: .black.opacity(0.10), radius: 14, y: 4)
    }
}
