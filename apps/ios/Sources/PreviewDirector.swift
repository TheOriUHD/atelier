#if DEBUG
import SwiftUI
import UIKit

// The scripted scenes of the App Store preview video: `--demo preview-list` and `--demo preview-chat`. A debug build plays
// the scene by itself, frame by frame, and the simulator is recorded while it does, so the motion is steady in a way a
// person (or a tool injecting touches) cannot be. Everything runs through the app's own views: the list is scrolled, the
// reply arrives as the server's events do, the effort slider is dragged through the same code a finger would use.
//
//   preview-list   the conversation list scrolls at a slow, constant speed
//   preview-chat   a reply streams in word by word; when it is done a finger taps the effort chip and moves the slider
//
// A magenta frame marks the start of a scene and a green one its end, so the recording can be cut exactly.

extension Notification.Name {
    /// Opens or closes the effort panel (`userInfo["open"]`: Bool).
    static let previewEffort = Notification.Name("atelier.preview.effort")
    /// A scripted finger on the effort slider (`userInfo["phase"]`: "moved" | "ended", `["x"]`: the finger's x in the window).
    static let previewSlider = Notification.Name("atelier.preview.slider")
}

/// Where the scenes find things on screen, in window coordinates.
enum PreviewTargets {
    nonisolated(unsafe) static var frames: [String: CGRect] = [:]
    nonisolated(unsafe) static var sliderStops = 0
}

extension View {
    /// Tells the scripted scenes where this view is.
    func previewTarget(_ name: String) -> some View {
        onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { PreviewTargets.frames[name] = $0 }
    }
}

/// The finger drawn over the screen, and the start and end marks.
@MainActor @Observable final class PreviewFinger {
    static let shared = PreviewFinger()
    var position: CGPoint = .zero
    var opacity = 0.0
    var pressed = false
    var taps = 0
    var marker: Color?
}

struct PreviewOverlay: View {
    private let finger = PreviewFinger.shared
    @State private var ring = false

    var body: some View {
        ZStack {
            Circle().strokeBorder(.white.opacity(0.8), lineWidth: 2.5).frame(width: 46, height: 46)
                .scaleEffect(ring ? 2.3 : 0.7).opacity(ring ? 0 : 0.0)
                .position(finger.position)
            Circle().fill(.white.opacity(finger.pressed ? 0.4 : 0.24))
                .overlay(Circle().strokeBorder(.white.opacity(0.85), lineWidth: 1.5))
                .shadow(color: .black.opacity(0.35), radius: 8, y: 3)
                .frame(width: 46, height: 46)
                .scaleEffect(finger.pressed ? 0.78 : 1)
                .animation(.easeOut(duration: 0.14), value: finger.pressed)
                .position(finger.position)
                .opacity(finger.opacity)
            if let marker = finger.marker { marker.ignoresSafeArea() }
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
        .onChange(of: finger.taps) { _, _ in
            ring = false
            withAnimation(.easeOut(duration: 0.55)) { ring = true }
        }
    }
}

/// Runs `update` with 0…1 on every frame of the display for `duration` seconds.
@MainActor private final class Ticker: NSObject {
    private var link: CADisplayLink?
    private var begin: CFTimeInterval?
    private var duration: TimeInterval = 0
    private var update: ((Double) -> Void)?
    private var done: CheckedContinuation<Void, Never>?

    static func run(_ duration: TimeInterval, _ update: @escaping (Double) -> Void) async {
        await Ticker().go(duration, update)
    }

    private func go(_ duration: TimeInterval, _ update: @escaping (Double) -> Void) async {
        self.duration = duration
        self.update = update
        await withCheckedContinuation { continuation in
            done = continuation
            let link = CADisplayLink(target: self, selector: #selector(tick(_:)))
            link.add(to: .main, forMode: .common)
            self.link = link
        }
    }

    @objc private func tick(_ link: CADisplayLink) {
        let begin = self.begin ?? link.timestamp
        self.begin = begin
        let t = min(max((link.timestamp - begin) / duration, 0), 1)
        update?(t)
        if t >= 1 {
            link.invalidate()
            self.link = nil
            update = nil
            done?.resume()
            done = nil
        }
    }
}

enum PreviewEase {
    static func inOut(_ t: Double) -> Double { t < 0.5 ? 4 * t * t * t : 1 - pow(-2 * t + 2, 3) / 2 }
    static func smooth(_ t: Double) -> Double { t * t * (3 - 2 * t) }
}

@MainActor enum PreviewDirector {
    private static let finger = PreviewFinger.shared

    static func run(_ scene: String, store: AppStore) async {
        finger.marker = Color(red: 1, green: 0, blue: 1)
        await pause(0.8)
        if scene == "preview-list" { await settleList() }
        await pause(0.4)
        finger.marker = nil
        await pause(0.5)
        switch scene {
        case "preview-list": await scrollList()
        case "preview-chat": await chat(store)
        default: break
        }
        finger.marker = Color(red: 0, green: 1, blue: 0)
    }

    private static func pause(_ seconds: Double) async { try? await Task.sleep(for: .seconds(seconds)) }

    // MARK: the list

    /// Under the start mark: the iPad's sidebar hides its search field (and so shrinks its top inset) the moment it is scrolled at
    /// all, which a scripted scroll that starts at the very top would show as a pull. Moving it once and putting it at the new
    /// resting place means the picture starts from there.
    private static func settleList() async {
        guard let list = biggestScrollView() else { return }
        list.setContentOffset(CGPoint(x: 0, y: list.contentOffset.y + 1), animated: false)
        await pause(0.4)
        list.setContentOffset(CGPoint(x: 0, y: -list.adjustedContentInset.top), animated: false)
        await pause(0.4)
    }

    /// Scrolls the biggest list on screen: it eases in, then moves at one constant speed, then eases out.
    private static func scrollList() async {
        guard let list = biggestScrollView() else { return }
        let from = list.contentOffset.y
        let reach = list.contentSize.height + list.adjustedContentInset.bottom - list.bounds.height
        let distance = min(Double(Launch.value("--distance").flatMap(Double.init) ?? 800), Double(reach - from))
        let total = Double(Launch.value("--seconds").flatMap(Double.init) ?? 5.8), rampIn = 0.8, rampOut = 1.0
        let speed = distance / (total - rampIn / 2 - rampOut / 2)
        await Ticker.run(total) { t in
            let s = t * total
            let travelled: Double
            if s < rampIn { travelled = speed * s * s / (2 * rampIn) }
            else if s > total - rampOut { let r = total - s; travelled = distance - speed * r * r / (2 * rampOut) }
            else { travelled = speed * rampIn / 2 + speed * (s - rampIn) }
            list.setContentOffset(CGPoint(x: 0, y: from + CGFloat(travelled)), animated: false)
        }
        await pause(0.6)
    }

    private static func biggestScrollView() -> UIScrollView? {
        var best: UIScrollView?
        func visit(_ view: UIView) {
            if let scroll = view as? UIScrollView, !scroll.isHidden, scroll.contentSize.height > scroll.bounds.height + 200 {
                if best == nil || scroll.contentSize.height > best!.contentSize.height { best = scroll }
            }
            for sub in view.subviews { visit(sub) }
        }
        for scene in UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }) { for window in scene.windows { visit(window) } }
        return best
    }

    // MARK: the conversation

    /// The reply, as the server sends it: words (a mark such as `##` or `-` travels with the word after it, so no half-drawn
    /// markup is ever on screen).
    static let reply = """
    # A relaxed weekend in Lisbon

    Slow mornings, short walks and one good museum. Here is a plan that keeps the pace gentle.

    ## Saturday

    - **Morning:** coffee and a pastel de nata in Alfama, then up to the Santa Luzia viewpoint.
    - **Afternoon:** the Gulbenkian Museum: compact, calm, with a lovely garden.
    - **Evening:** dinner in Bairro Alto, then a slow walk down to the river.

    ## Sunday

    - **Morning:** tram 28 early, before the queues.
    - **Afternoon:** Belém: the tower from the outside, then a bakery picnic.

    > Flat shoes beat anything else you could pack.
    """

    static func tokens(_ text: String) -> [String] {
        var pieces: [String] = []
        var rest = Substring(text)
        while let start = rest.firstIndex(where: { !$0.isWhitespace }) {
            let word = rest[start...].prefix { !$0.isWhitespace }
            var end = word.endIndex
            while end < rest.endIndex, rest[end].isWhitespace { end = rest.index(after: end) }
            pieces.append(String(rest[start..<end]))
            rest = rest[end...]
        }
        var merged: [String] = []
        var carry = ""
        for piece in pieces {
            let bare = piece.trimmingCharacters(in: .whitespacesAndNewlines)
            if ["#", "##", "###", "-", ">"].contains(bare) || (bare.hasSuffix(".") && Int(bare.dropLast()) != nil) { carry += piece } else { merged.append(carry + piece); carry = "" }
        }
        return merged
    }

    private static func chat(_ store: AppStore) async {
        let words = tokens(reply)
        var seq = store.transcript.seq
        func event(_ value: JSON) {
            seq += 1
            _ = store.transcript.apply(.obj(["seq": .number(Double(seq)), "event": value]))
        }
        await pause(0.9)
        // The words arrive at an even pace, as many as are due on each frame.
        let perSecond = Double(Launch.value("--words").flatMap(Double.init) ?? 17)
        var sent = 0
        await Ticker.run(Double(words.count) / perSecond) { t in
            let due = min(words.count, Int((t * Double(words.count)).rounded(.down)) + (t >= 1 ? 1 : 0))
            guard due > sent else { return }
            event(.obj(["type": "delta", "messageId": "a1", "kind": "text", "index": 0, "text": .string(words[sent..<due].joined())]))
            sent = due
        }
        if sent < words.count { event(.obj(["type": "delta", "messageId": "a1", "kind": "text", "index": 0, "text": .string(words[sent...].joined())])) }
        event(.obj(["type": "done", "messageId": "a1", "error": .null, "usage": .null]))
        event(.obj(["type": "status", "status": "idle"]))
        store.transcript.snapshot = store.transcript.snapshot.setting("streamingMessageId", .null)
        await pause(1.1)
        await chooseEffort(store, level: "high")
        await pause(1.2)
    }

    // MARK: the effort chip

    private static func move(to point: CGPoint, over duration: Double) async {
        let from = finger.position
        await Ticker.run(duration) { t in
            let e = PreviewEase.inOut(t)
            finger.position = CGPoint(x: from.x + (point.x - from.x) * e, y: from.y + (point.y - from.y) * e)
        }
    }

    private static func fade(_ to: Double, over duration: Double) async {
        let from = finger.opacity
        await Ticker.run(duration) { t in finger.opacity = from + (to - from) * PreviewEase.smooth(t) }
    }

    private static func tap() async {
        finger.pressed = true
        finger.taps += 1
        await pause(0.16)
    }

    private static func chooseEffort(_ store: AppStore, level: String) async {
        guard let chip = PreviewTargets.frames["effort-chip"] else { return }
        let target = CGPoint(x: chip.midX, y: chip.midY)
        // The finger comes in from below the box, to the chip.
        finger.position = CGPoint(x: target.x + 70, y: target.y + 190)
        async let appear: Void = fade(1, over: 0.5)
        await move(to: target, over: 1.1)
        await appear
        await pause(0.25)
        await tap()
        NotificationCenter.default.post(name: .previewEffort, object: nil, userInfo: ["open": true])
        await pause(0.14)
        finger.pressed = false
        await pause(0.9)

        // Onto the slider's thumb, then along the track to the level.
        guard let slider = PreviewTargets.frames["effort-slider"], PreviewTargets.sliderStops > 1 else { return }
        let inset = slider.height / 2, span = slider.width - 2 * inset, last = Double(PreviewTargets.sliderStops - 1)
        func stop(_ index: Int) -> CGFloat { slider.minX + inset + span * CGFloat(Double(index) / last) }
        let model = store.models.first { $0["ref"].string == store.selectedModel }
        let levels = ChatEffort.choices(model, mode: "chat", ultracode: ChatHub.of(store).ultracodeOn)
        let current = ChatEffort.shown(nil, model: model, mode: "chat", ultracode: ChatHub.of(store).ultracodeOn).flatMap { levels.firstIndex(of: $0) } ?? 1
        let wanted = levels.firstIndex(of: level) ?? 2
        let y = slider.midY
        await move(to: CGPoint(x: stop(current), y: y), over: 0.6)
        await pause(0.2)
        finger.pressed = true
        await pause(0.2)
        let start = stop(current), end = stop(wanted)
        await Ticker.run(1.2) { t in
            let x = start + (end - start) * CGFloat(PreviewEase.inOut(t))
            finger.position = CGPoint(x: x, y: y)
            NotificationCenter.default.post(name: .previewSlider, object: nil, userInfo: ["phase": "moved", "x": x])
        }
        await pause(0.25)
        NotificationCenter.default.post(name: .previewSlider, object: nil, userInfo: ["phase": "ended", "x": end])
        finger.pressed = false
        // What the server would now report for the conversation.
        if let at = store.sessions.firstIndex(where: { $0.id == store.selected }) {
            store.sessions[at] = Conversation(raw: store.sessions[at].raw.setting("effort", .string(level)))
        }
        await pause(1.1)

        // A tap beside the panel closes it.
        let outside = CGPoint(x: slider.midX, y: slider.minY - 330)
        await move(to: outside, over: 0.7)
        await tap()
        NotificationCenter.default.post(name: .previewEffort, object: nil, userInfo: ["open": false])
        await pause(0.14)
        finger.pressed = false
        await fade(0, over: 0.35)
    }
}

/// What the scenes show: a long list of conversations, and one conversation with a reply on its way.
enum PreviewReel {
    private static func ms(_ secondsAgo: Double) -> Double { (Date.now.timeIntervalSince1970 - secondsAgo) * 1000 }

    private static func session(_ id: String, _ title: String, ago: Double, model: String = "anthropic/opus", pinned: Bool = false, status: String = "idle", unseen: Bool = false, project: String? = nil) -> JSON {
        ChatDemo.session(id, title, status: status, ago: ago, pinned: pinned, unseen: unseen, model: model, project: project)
    }

    static let sonnet = "anthropic/sonnet", qwen = "ollama/qwen3", mistral = "mistral/large"

    static func sessions(selected: Bool) -> [JSON] {
        let hour = 3600.0, day = 86400.0
        var list = [
            session("p1", "Launch plan for 0.11", ago: 3 * hour, pinned: true, project: "p1"),
            session("p2", "Trip to Lisbon in March", ago: 2 * day, model: sonnet, pinned: true),
            session("t1", "Plan the offsite agenda", ago: 90, model: sonnet, status: "running"),
            session("t2", "Rename photos by date", ago: 40 * 60, unseen: true),
            session("t3", "Summarize the Q3 report", ago: 5 * hour, model: sonnet),
            session("t4", "Draft a reply to Anna", ago: 7 * hour, model: mistral),
            session("t5", "How HTTP caching works", ago: 9 * hour),
            session("y1", "Launch announcement email", ago: 26 * hour, model: sonnet),
            session("y2", "Compare three self-hosted wikis", ago: 30 * hour, model: qwen),
            session("y3", "A speech for Mira's birthday", ago: 34 * hour),
            session("y4", "Why is my sourdough flat?", ago: 40 * hour, model: sonnet),
            session("w1", "How the updater checks a download", ago: 4 * day),
            session("w2", "Weekly meal plan without dairy", ago: 4.5 * day, model: mistral),
            session("w3", "Translate the lease into English", ago: 5 * day, model: sonnet),
            session("w4", "Fix a leaking tap, step by step", ago: 5.5 * day, model: qwen),
            session("w5", "A regex for German phone numbers", ago: 6 * day),
            session("m1", "Cover letter for the design role", ago: 12 * day, model: sonnet),
            session("m2", "Budget for three weeks in Japan", ago: 14 * day),
            session("m3", "Rename the gym playlist", ago: 18 * day, model: mistral),
            session("m4", "Why do tides come twice a day?", ago: 21 * day, model: qwen),
            session("m5", "Two ways to manage app state", ago: 24 * day),
            session("m6", "Birthday ideas for a ten-year-old", ago: 27 * day, model: sonnet),
            session("m7", "Notes on the new home server", ago: 29 * day),
        ]
        if selected { list.insert(session("c1", "A weekend in Lisbon", ago: 20, status: "running"), at: 0) }
        return list
    }

    /// The conversation before the reply: the question is sent and the answer has not begun.
    static func conversation() -> JSON {
        let question = "Plan a relaxed weekend in Lisbon for two: good food, one museum, lots of walking."
        return Demo.json(#"{"session":{"id":"c1","status":"running","title":"A weekend in Lisbon","model":"anthropic/opus"},"seq":3,"streamingMessageId":"a1","messages":[{"id":"u1","role":"user","kind":"normal","parts":[{"type":"text","text":"\#(question)"}],"error":null},{"id":"a1","role":"assistant","kind":"normal","parts":[],"error":null}],"pending":null,"todos":[],"context":{"used":24000,"limit":200000,"threshold":170000,"categories":{"systemPrompt":9000,"systemTools":14000,"mcpTools":0,"skills":0,"messages":1000}}}"#)
    }
}
#else
import SwiftUI

extension View {
    func previewTarget(_ name: String) -> some View { self }
}
#endif
