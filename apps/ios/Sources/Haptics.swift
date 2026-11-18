import CoreHaptics
import UIKit

/// The feel of a phone that has just been signed in: a short rising run of taps that settles into a soft swell, on phones whose
/// hardware does fine haptics; the system's own "success" on the others; nothing on a device with neither.
@MainActor final class PairingHaptics {
    static let shared = PairingHaptics()
    private var engine: CHHapticEngine?
    private let supported = CHHapticEngine.capabilitiesForHardware().supportsHaptics

    /// Starts the engine ahead of time, so the pattern is there the moment it is wanted.
    func prepare() {
        guard supported, engine == nil else { return }
        engine = try? CHHapticEngine()
        engine?.isAutoShutdownEnabled = true
        engine?.resetHandler = { [weak self] in try? self?.engine?.start() }
        try? engine?.start()
    }

    /// A code was read: one light tick, so the person knows the camera has it.
    func scanned() {
        UIImpactFeedbackGenerator(style: .light).impactOccurred(intensity: 0.8)
    }

    /// The phone is signed in.
    func success() {
        prepare()
        guard supported, let engine, let pattern = Self.successPattern(), let player = try? engine.makePlayer(with: pattern) else {
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            return
        }
        do { try player.start(atTime: CHHapticTimeImmediate) } catch { UINotificationFeedbackGenerator().notificationOccurred(.success) }
    }

    /// Three taps, each a little firmer than the one before, and a swell that fades under the last.
    private static func successPattern() -> CHHapticPattern? {
        func tap(_ time: TimeInterval, _ intensity: Float, _ sharpness: Float) -> CHHapticEvent {
            CHHapticEvent(eventType: .hapticTransient, parameters: [
                CHHapticEventParameter(parameterID: .hapticIntensity, value: intensity),
                CHHapticEventParameter(parameterID: .hapticSharpness, value: sharpness),
            ], relativeTime: time)
        }
        let swell = CHHapticEvent(eventType: .hapticContinuous, parameters: [
            CHHapticEventParameter(parameterID: .hapticIntensity, value: 0.5),
            CHHapticEventParameter(parameterID: .hapticSharpness, value: 0.2),
        ], relativeTime: 0.2, duration: 0.4)
        let fade = CHHapticParameterCurve(parameterID: .hapticIntensityControl, controlPoints: [
            .init(relativeTime: 0.2, value: 1),
            .init(relativeTime: 0.45, value: 0.55),
            .init(relativeTime: 0.6, value: 0),
        ], relativeTime: 0)
        return try? CHHapticPattern(events: [tap(0, 0.55, 0.45), tap(0.09, 0.8, 0.6), tap(0.2, 1, 0.8), swell], parameterCurves: [fade])
    }
}
