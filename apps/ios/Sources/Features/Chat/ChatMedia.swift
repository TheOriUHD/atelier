import SwiftUI
import AVKit
import AVFoundation
import Photos

// MARK: - Where files come from

private struct ChatServerKey: EnvironmentKey { static let defaultValue = UserDefaults.standard.string(forKey: "server") ?? "" }

extension EnvironmentValues {
    /// The address of the server the person is signed in to: where blobs are fetched from.
    var chatServer: String {
        get { self[ChatServerKey.self] }
        set { self[ChatServerKey.self] = newValue }
    }
}

/// A picture the server keeps, fetched when it comes into view and kept for the session.
struct BlobImage: View {
    let blob: String
    let mime: String
    var maxHeight: CGFloat = 320
    var maxWidth: CGFloat = 360
    var corner: CGFloat = 16
    var fill = false
    @Environment(\.chatServer) private var server
    @State private var image: UIImage?
    @State private var failed = false

    /// Starts from the picture already at hand (one fetched before, or the copy kept from sending it), so it is in place
    /// and in its final shape on the first frame.
    init(blob: String, mime: String, maxHeight: CGFloat = 320, maxWidth: CGFloat = 360, corner: CGFloat = 16, fill: Bool = false) {
        self.blob = blob
        self.mime = mime
        self.maxHeight = maxHeight
        self.maxWidth = maxWidth
        self.corner = corner
        self.fill = fill
        _image = State(initialValue: ChatBlobs.shared.cachedImage(sha: blob) ?? ChatBlobs.shared.preview(sha: blob))
    }

    /// The size a picture takes in a box: as large as fits, never larger than it is, whatever the room it is offered.
    static func fitted(_ size: CGSize, in box: CGSize) -> CGSize {
        guard size.width > 0, size.height > 0 else { return CGSize(width: 140, height: 120) }
        let scale = min(1, box.width / size.width, box.height / size.height)
        return CGSize(width: (size.width * scale).rounded(), height: (size.height * scale).rounded())
    }

    var body: some View {
        Group {
            if let image {
                if fill {
                    Image(uiImage: image).resizable().scaledToFill()
                } else {
                    // An exact size: a picture asked to fit the room it is offered takes the whole width in some containers.
                    let size = Self.fitted(image.size, in: CGSize(width: maxWidth, height: maxHeight))
                    Image(uiImage: image).resizable().frame(width: size.width, height: size.height)
                }
            } else if failed {
                ZStack { Theme.fill; Image(systemName: "photo.badge.exclamationmark").font(.system(size: 22, weight: .light)).foregroundStyle(Theme.inkMuted) }
                    .frame(width: 140, height: min(maxHeight, 120))
                    .accessibilityLabel("This picture could not be loaded")
            } else {
                ZStack { Theme.fill; ProgressView() }.frame(width: 140, height: min(maxHeight, 120))
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: corner, style: .continuous))
        .task(id: blob) {
            if let cached = ChatBlobs.shared.cachedImage(sha: blob) { image = cached; return }
            do { image = try await ChatBlobs.shared.image(sha: blob, mime: mime, server: server); failed = false } catch is CancellationError { return } catch { failed = true }
        }
    }
}

// MARK: - Pictures, clips and sounds a model made

/// What GenerateImage, GenerateVideo and GenerateAudio put in the conversation: a frame with the final shape from the
/// first moment, the work as it goes, and then the finished result in the same place.
struct GeneratedMediaView: View {
    let step: ToolStep
    let progress: JSON
    var waiting = false
    var onReference: ((JSON) -> Void)?
    var onChangeArea: ((JSON) -> Void)?
    @State private var viewing: Int?
    @State private var details: JSON?

    private var kind: String { step.name == "GenerateVideo" ? "video" : step.name == "GenerateAudio" ? "audio" : "image" }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if step.failed {
                failure
            } else if !step.generated.isEmpty {
                ForEach(Array(step.generated.enumerated()), id: \.offset) { _, item in
                    switch item["kind"].string {
                    case "video": ClipPlayer(item: item)
                    case "audio": SoundPlayer(item: item)
                    default: EmptyView()
                    }
                }
                let pictures = step.generated.filter { $0["kind"].string.isEmpty || $0["kind"].string == "image" }
                if !pictures.isEmpty { pictureGrid(pictures) }
            } else if step.finished {
                Label(step.resultText.isEmpty ? "Nothing was made." : String(step.resultText.prefix(300)), systemImage: "photo").font(.subheadline).foregroundStyle(Theme.inkSecondary)
            } else {
                working
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .fullScreenCover(item: Binding(get: { viewing.map { ViewerStart(index: $0) } }, set: { if $0 == nil { viewing = nil } })) { start in
            MediaViewer(items: step.generated.filter { $0["kind"].string.isEmpty || $0["kind"].string == "image" }, start: start.index, onReference: onReference, onChangeArea: onChangeArea)
        }
        .sheet(item: Binding(get: { details.map { DetailsItem(item: $0) } }, set: { if $0 == nil { details = nil } })) { MediaDetails(item: $0.item) }
    }

    private struct ViewerStart: Identifiable { let index: Int; var id: Int { index } }
    private struct DetailsItem: Identifiable { let item: JSON; var id: String { item["blob"].string } }

    @ViewBuilder private func pictureGrid(_ pictures: [JSON]) -> some View {
        let columns = pictures.count == 1 ? [GridItem(.flexible())] : [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)]
        LazyVGrid(columns: columns, spacing: 8) {
            ForEach(Array(pictures.enumerated()), id: \.offset) { index, item in
                Button { viewing = index } label: {
                    BlobImage(blob: item["blob"].string, mime: item["mime"].string, maxHeight: pictures.count == 1 ? 460 : 220, corner: 14, fill: pictures.count > 1)
                        .aspectRatio(pictures.count > 1 ? 1 : nil, contentMode: .fill).clipped()
                        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Theme.hairline, lineWidth: 0.5))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Picture \(index + 1) of \(pictures.count): \(item["prompt"].string)")
                .contextMenu {
                    ShareFileButton(blob: item["blob"].string, mime: item["mime"].string, name: MediaNaming.fileName(item))
                    SavePhotoButton(item: item)
                    Button("Details", systemImage: "info.circle") { details = item }
                    if let onReference { Button("Use as reference", systemImage: "photo.badge.plus") { onReference(item) } }
                    if let onChangeArea { Button("Change an area", systemImage: "paintbrush") { onChangeArea(item) } }
                }
            }
        }
        if let model = pictures.first?["modelName"].stringOrNil, !model.isEmpty {
            HStack(spacing: 8) {
                Text(MediaNaming.caption(pictures)).font(.caption).foregroundStyle(Theme.inkMuted)
                Spacer(minLength: 0)
                Button { details = pictures[0] } label: { Image(systemName: "info.circle") }.buttonStyle(.plain).foregroundStyle(Theme.inkMuted).accessibilityLabel("Details")
            }
        }
    }

    private var failure: some View {
        Label { Text(MediaNaming.failure(step.resultText)).font(.subheadline).foregroundStyle(Theme.ink) } icon: { Image(systemName: "exclamationmark.circle.fill").foregroundStyle(Theme.danger) }
            .padding(14).frame(maxWidth: .infinity, alignment: .leading).background(Theme.removed, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private var working: some View {
        let width = Double(progress["width"].int > 0 ? progress["width"].int : 1024)
        let height = Double(progress["height"].int > 0 ? progress["height"].int : 1024)
        let fraction = progress["fraction"].double
        return VStack(alignment: .leading, spacing: 8) {
            ZStack {
                Theme.fill
                if let preview = previewImage { Image(uiImage: preview).resizable().scaledToFill().blur(radius: 18).opacity(0.8) }
                VStack(spacing: 10) {
                    if kind == "audio" { Image(systemName: "waveform").font(.system(size: 30, weight: .light)).foregroundStyle(Theme.inkMuted) }
                    else if fraction > 0 { ProgressView(value: fraction).progressViewStyle(.linear).frame(width: 120) } else { ProgressView() }
                }
            }
            .aspectRatio(kind == "audio" ? 3 : width / height, contentMode: .fit).frame(maxHeight: 360)
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(Theme.hairline, lineWidth: 0.5))
            Text(waiting ? "Waiting for your answer" : MediaNaming.phase(progress, kind: kind)).font(.footnote).foregroundStyle(Theme.inkMuted)
        }
        .accessibilityElement(children: .combine)
    }

    private var previewImage: UIImage? {
        guard let data = Data(base64Encoded: progress["preview"]["data"].string) else { return nil }
        return UIImage(data: data)
    }
}

enum MediaNaming {
    static func phase(_ progress: JSON, kind: String) -> String {
        let noun = kind == "video" ? "the clip" : kind == "audio" ? "the sound" : "the picture"
        switch progress["phase"].string {
        case "queued": return progress["ahead"].int > 0 ? "Waiting in line, \(progress["ahead"].int) ahead" : "Waiting in line"
        case "freeing": return "Making room on the server"
        case "loading": return "Loading the model"
        case "generating":
            let steps = progress["steps"].int
            let step = progress["step"].int
            let count = progress["count"].int
            let base = "Making \(noun)\(count > 1 ? "s" : "")"
            if steps > 0 { return "\(base), step \(step) of \(steps)" }
            return base
        case "finishing": return "Finishing"
        default: return "Making \(noun)"
        }
    }

    static func caption(_ items: [JSON]) -> String {
        guard let first = items.first else { return "" }
        var parts = [first["modelName"].string]
        if first["width"].int > 0 { parts.append("\(first["width"].int) × \(first["height"].int)") }
        if first["durationMs"].int > 0 { parts.append(ChatText.elapsed(Double(first["durationMs"].int))) }
        return parts.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    static func fileName(_ item: JSON) -> String {
        let id = item["id"].string.isEmpty ? "image" : item["id"].string
        return "\(id).\(ChatBlobs.extensionFor(mime: item["mime"].string))"
    }

    static func failure(_ text: String) -> String {
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return clean.isEmpty ? "The model could not make this." : String(clean.prefix(300))
    }

    static func duration(_ seconds: Double) -> String {
        let total = max(0, Int(seconds.rounded()))
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}

// MARK: - Save to Photos

/// Saving a picture to the photo library needs the app to say why (an Info.plist key the project adds); until it does,
/// the share sheet (Save Image) is the way, and this button is not offered.
@MainActor enum ChatPhotos {
    static var available: Bool { Bundle.main.object(forInfoDictionaryKey: "NSPhotoLibraryAddUsageDescription") != nil }

    static func save(blob: String, mime: String, server: String) async throws {
        let image = try await ChatBlobs.shared.image(sha: blob, mime: mime, server: server)
        let status = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
        guard status == .authorized || status == .limited else { throw MobileError.message("Allow photo access in iOS Settings to save pictures.") }
        try await PHPhotoLibrary.shared().performChanges { PHAssetChangeRequest.creationRequestForAsset(from: image) }
    }
}

struct SavePhotoButton: View {
    let item: JSON
    @Environment(\.chatServer) private var server
    var body: some View {
        if ChatPhotos.available {
            Button("Save to Photos", systemImage: "photo.badge.arrow.down") {
                Task {
                    do { try await ChatPhotos.save(blob: item["blob"].string, mime: item["mime"].string, server: server); UINotificationFeedbackGenerator().notificationOccurred(.success) }
                    catch { UINotificationFeedbackGenerator().notificationOccurred(.error) }
                }
            }
        }
    }
}

// MARK: - Share

/// Shares a stored file (the share sheet also offers Save Image and Save to Files).
struct ShareFileButton: View {
    let blob: String
    let mime: String
    let name: String
    @Environment(\.chatServer) private var server
    @State private var url: URL?
    var body: some View {
        Group {
            if let url { ShareLink(item: url) { Label("Share", systemImage: "square.and.arrow.up") } }
            else { Button { Task { url = try? await ChatBlobs.shared.file(sha: blob, mime: mime, name: name, server: server) } } label: { Label("Share", systemImage: "square.and.arrow.up") } }
        }
    }
}

// MARK: - Full screen

struct MediaViewer: View {
    let items: [JSON]
    let start: Int
    var onReference: ((JSON) -> Void)?
    var onChangeArea: ((JSON) -> Void)?
    @State private var index: Int
    @State private var details: JSON?
    @State private var chrome = true
    /// How far the picture has been pulled down (or up) by the finger.
    @State private var pull: CGFloat = 0
    @Environment(\.dismiss) private var dismiss
    @Environment(\.chatServer) private var server

    init(items: [JSON], start: Int, onReference: ((JSON) -> Void)? = nil, onChangeArea: ((JSON) -> Void)? = nil) {
        self.items = items; self.start = start; self.onReference = onReference; self.onChangeArea = onChangeArea
        _index = State(initialValue: min(max(0, start), max(0, items.count - 1)))
    }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            TabView(selection: $index) {
                ForEach(Array(items.enumerated()), id: \.offset) { position, item in
                    ZoomableBlob(blob: item["blob"].string, mime: item["mime"].string, onTap: { withAnimation(.snappy) { chrome.toggle() } },
                                 onPull: { pull = $0 }, onRelease: { release(travelled: $0, velocity: $1) }).tag(position).ignoresSafeArea()
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            // The picture follows the finger and shrinks a little as it goes; let go far enough, or with a flick, and it leaves.
            .offset(y: pull).scaleEffect(1 - min(abs(pull) / 1600, 0.18))
            if chrome { controls.transition(.opacity).opacity(pull == 0 ? 1 : 0) }
        }
        .statusBarHidden(!chrome)
        .sheet(item: Binding(get: { details.map { DetailsBox(item: $0) } }, set: { if $0 == nil { details = nil } })) { MediaDetails(item: $0.item) }
        .preferredColorScheme(.dark)
    }

    private struct DetailsBox: Identifiable { let item: JSON; var id: String { item["blob"].string } }

    private func release(travelled: CGFloat, velocity: CGFloat) {
        if abs(travelled) > 110 || abs(velocity) > 900 {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            dismiss()
        } else {
            withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) { pull = 0 }
        }
    }

    private var current: JSON { items.indices.contains(index) ? items[index] : .null }

    private var controls: some View {
        VStack {
            HStack(spacing: 12) {
                Button { dismiss() } label: { Image(systemName: "xmark").font(.system(size: 15, weight: .semibold)).frame(width: 40, height: 40) }.buttonStyle(.glass).clipShape(Circle()).accessibilityLabel("Close")
                Spacer()
                if items.count > 1 { Text("\(index + 1) of \(items.count)").font(.subheadline.monospacedDigit()).foregroundStyle(.white.opacity(0.8)) }
                Spacer()
                Menu {
                    ShareFileButton(blob: current["blob"].string, mime: current["mime"].string, name: MediaNaming.fileName(current))
                    SavePhotoButton(item: current)
                    Button("Details", systemImage: "info.circle") { details = current }
                    if let onReference { Button("Use as reference", systemImage: "photo.badge.plus") { onReference(current); dismiss() } }
                    if let onChangeArea { Button("Change an area", systemImage: "paintbrush") { let item = current; dismiss(); onChangeArea(item) } }
                } label: { Image(systemName: "ellipsis").font(.system(size: 15, weight: .semibold)).frame(width: 40, height: 40) }.buttonStyle(.glass).clipShape(Circle()).accessibilityLabel("Picture actions")
            }.padding(.horizontal, 16).padding(.top, 8)
            Spacer()
            if !current["prompt"].string.isEmpty {
                Text(current["prompt"].string).font(.footnote).foregroundStyle(.white.opacity(0.85)).lineLimit(3).multilineTextAlignment(.leading)
                    .padding(14).frame(maxWidth: .infinity, alignment: .leading).glassEffect(.regular, in: .rect(cornerRadius: 18)).padding(.horizontal, 16).padding(.bottom, 8)
            }
        }
    }
}

/// A picture to pinch, double-tap and drag.
struct ZoomableBlob: View {
    let blob: String
    let mime: String
    var onTap: () -> Void = {}
    /// A vertical drag while the picture is not zoomed: how far it has gone, then how it ended (distance, speed).
    var onPull: (CGFloat) -> Void = { _ in }
    var onRelease: (CGFloat, CGFloat) -> Void = { _, _ in }
    @Environment(\.chatServer) private var server
    @State private var image: UIImage?
    @State private var failed = false
    var body: some View {
        Group {
            if let image { ZoomScroll(image: image, onTap: onTap, onPull: onPull, onRelease: onRelease) }
            else if failed { Label("This picture could not be loaded", systemImage: "photo.badge.exclamationmark").foregroundStyle(.white.opacity(0.7)) }
            else { ProgressView().tint(.white) }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .task(id: blob) {
            do { image = try await ChatBlobs.shared.image(sha: blob, mime: mime, server: server) } catch is CancellationError { return } catch { failed = true }
        }
    }
}

/// A scroll view that keeps its picture fitted until it is zoomed.
final class ChatZoomingScrollView: UIScrollView {
    let imageView = UIImageView()
    override func layoutSubviews() {
        super.layoutSubviews()
        if zoomScale == 1 { imageView.frame = bounds; contentSize = bounds.size }
    }
}

struct ZoomScroll: UIViewRepresentable {
    let image: UIImage
    let onTap: () -> Void
    var onPull: (CGFloat) -> Void = { _ in }
    var onRelease: (CGFloat, CGFloat) -> Void = { _, _ in }

    func makeUIView(context: Context) -> ChatZoomingScrollView {
        let scroll = ChatZoomingScrollView()
        scroll.delegate = context.coordinator
        scroll.minimumZoomScale = 1
        scroll.maximumZoomScale = 5
        scroll.showsHorizontalScrollIndicator = false
        scroll.showsVerticalScrollIndicator = false
        scroll.contentInsetAdjustmentBehavior = .never
        let view = scroll.imageView
        view.image = image
        view.contentMode = .scaleAspectFit
        view.isUserInteractionEnabled = true
        scroll.addSubview(view)
        let double = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.doubleTap(_:)))
        double.numberOfTapsRequired = 2
        view.addGestureRecognizer(double)
        let single = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.singleTap))
        single.require(toFail: double)
        view.addGestureRecognizer(single)
        let pan = UIPanGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.pan(_:)))
        pan.delegate = context.coordinator
        pan.maximumNumberOfTouches = 1
        scroll.addGestureRecognizer(pan)
        context.coordinator.scroll = scroll
        return scroll
    }

    func updateUIView(_ scroll: ChatZoomingScrollView, context: Context) {
        scroll.imageView.image = image
        context.coordinator.onTap = onTap
        context.coordinator.onPull = onPull
        context.coordinator.onRelease = onRelease
    }
    func makeCoordinator() -> Coordinator { Coordinator(onTap: onTap, onPull: onPull, onRelease: onRelease) }

    final class Coordinator: NSObject, UIScrollViewDelegate, UIGestureRecognizerDelegate {
        weak var scroll: ChatZoomingScrollView?
        var onTap: () -> Void
        var onPull: (CGFloat) -> Void
        var onRelease: (CGFloat, CGFloat) -> Void
        init(onTap: @escaping () -> Void, onPull: @escaping (CGFloat) -> Void, onRelease: @escaping (CGFloat, CGFloat) -> Void) { self.onTap = onTap; self.onPull = onPull; self.onRelease = onRelease }

        /// The drag starts only on a picture that is not zoomed and only for a mostly vertical move: sideways is the next picture.
        func gestureRecognizerShouldBegin(_ gesture: UIGestureRecognizer) -> Bool {
            guard let pan = gesture as? UIPanGestureRecognizer, let scroll else { return true }
            let velocity = pan.velocity(in: scroll)
            return scroll.zoomScale <= 1.01 && abs(velocity.y) > abs(velocity.x) * 1.2
        }
        func gestureRecognizer(_ gesture: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }
        @objc func pan(_ gesture: UIPanGestureRecognizer) {
            guard let scroll else { return }
            let travelled = gesture.translation(in: scroll).y
            switch gesture.state {
            case .changed: onPull(travelled)
            case .ended, .cancelled, .failed: onRelease(travelled, gesture.velocity(in: scroll).y)
            default: break
            }
        }
        func viewForZooming(in scrollView: UIScrollView) -> UIView? { (scrollView as? ChatZoomingScrollView)?.imageView }
        @objc func singleTap() { onTap() }
        @objc func doubleTap(_ gesture: UITapGestureRecognizer) {
            guard let scroll else { return }
            if scroll.zoomScale > 1.01 { scroll.setZoomScale(1, animated: true); return }
            let point = gesture.location(in: scroll.imageView)
            let size = CGSize(width: scroll.bounds.width / 2.5, height: scroll.bounds.height / 2.5)
            scroll.zoom(to: CGRect(x: point.x - size.width / 2, y: point.y - size.height / 2, width: size.width, height: size.height), animated: true)
        }
    }
}

// MARK: - Details

struct MediaDetails: View {
    let item: JSON
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            List {
                Section("Prompt") { Text(item["prompt"].string.isEmpty ? "None" : item["prompt"].string).textSelection(.enabled) }
                if !item["revisedPrompt"].string.isEmpty { Section("As the model rewrote it") { Text(item["revisedPrompt"].string).textSelection(.enabled) } }
                if !item["negativePrompt"].string.isEmpty { Section("Left out") { Text(item["negativePrompt"].string).textSelection(.enabled) } }
                if item["kind"].string == "audio", !item["lyrics"].string.isEmpty { Section("Words") { Text(item["lyrics"].string).textSelection(.enabled) } }
                Section {
                    if !item["modelName"].string.isEmpty { ValueRow(title: "Model", value: item["modelName"].string) }
                    if item["width"].int > 0 { ValueRow(title: "Size", value: "\(item["width"].int) × \(item["height"].int)") }
                    if item["seconds"].double > 0 { ValueRow(title: "Length", value: MediaNaming.duration(item["seconds"].double)) }
                    if item["seed"] != .null { ValueRow(title: "Seed", value: String(item["seed"].int), mono: true) }
                    if item["durationMs"].int > 0 { ValueRow(title: "Took", value: ChatText.elapsed(Double(item["durationMs"].int))) }
                    if item["costUsd"] != .null { ValueRow(title: "Cost", value: (item["costEstimated"].bool ? "About " : "") + ChatText.usd(item["costUsd"].double)) }
                    if !item["voice"].string.isEmpty { ValueRow(title: "Voice", value: item["voice"].string) }
                }
            }
            .scrollContentBackground(.hidden).background(Theme.sunken)
            .navigationTitle("Details").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        .tint(Theme.clay).presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
    }
}

// MARK: - Clips and sounds

/// A generated clip: its frame at the right shape, one tap to fetch and play it.
struct ClipPlayer: View {
    let item: JSON
    @Environment(\.chatServer) private var server
    @State private var player: AVPlayer?
    @State private var loading = false
    @State private var failed = false
    private var ratio: Double { item["width"].int > 0 && item["height"].int > 0 ? Double(item["width"].int) / Double(item["height"].int) : 16.0 / 9.0 }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ZStack {
                Color.black
                if let player {
                    VideoPlayer(player: player)
                } else {
                    Button { load() } label: {
                        VStack(spacing: 8) {
                            if loading { ProgressView().tint(.white) } else { Image(systemName: failed ? "arrow.clockwise" : "play.fill").font(.system(size: 28)).foregroundStyle(.white) }
                            Text(failed ? "Could not load. Tap to try again." : item["seconds"].double > 0 ? MediaNaming.duration(item["seconds"].double) : "Play").font(.footnote).foregroundStyle(.white.opacity(0.85))
                        }.frame(maxWidth: .infinity, maxHeight: .infinity).contentShape(Rectangle())
                    }.buttonStyle(.plain).disabled(loading).accessibilityLabel("Play the clip")
                }
            }
            .aspectRatio(ratio, contentMode: .fit).frame(maxHeight: 420)
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            HStack {
                Text(MediaNaming.caption([item])).font(.caption).foregroundStyle(Theme.inkMuted)
                Spacer()
                ShareFileButton(blob: item["blob"].string, mime: item["mime"].string, name: "\(item["id"].string).\(ChatBlobs.extensionFor(mime: item["mime"].string))").labelStyle(.iconOnly).foregroundStyle(Theme.inkMuted)
            }
        }
        .onDisappear { player?.pause() }
    }

    private func load() {
        loading = true; failed = false
        Task {
            defer { loading = false }
            do {
                let url = try await ChatBlobs.shared.file(sha: item["blob"].string, mime: item["mime"].string, name: "", server: server)
                let player = AVPlayer(url: url)
                self.player = player
                player.play()
            } catch is CancellationError { return } catch { failed = true }
        }
    }
}

/// A generated voice, song or sound effect with a play button and a position.
@MainActor @Observable final class SoundModel {
    var playing = false
    var position = 0.0
    var length = 0.0
    var loading = false
    var failed = false
    private var player: AVAudioPlayer?
    private var timer: Timer?

    func toggle(item: JSON, server: String) async {
        if let player {
            if player.isPlaying { player.pause(); playing = false; stopTimer() } else { start(player) }
            return
        }
        loading = true; failed = false
        defer { loading = false }
        do {
            let url = try await ChatBlobs.shared.file(sha: item["blob"].string, mime: item["mime"].string, name: "", server: server)
            try AVAudioSession.sharedInstance().setCategory(.playback)
            try AVAudioSession.sharedInstance().setActive(true)
            let player = try AVAudioPlayer(contentsOf: url)
            self.player = player
            length = player.duration
            start(player)
        } catch is CancellationError { return } catch { failed = true }
    }

    private func start(_ player: AVAudioPlayer) {
        player.play(); playing = true
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, let player = self.player else { return }
                self.position = player.currentTime
                if !player.isPlaying { self.playing = false; self.stopTimer(); if player.currentTime >= player.duration - 0.3 { player.currentTime = 0; self.position = 0 } }
            }
        }
    }

    func seek(_ value: Double) { player?.currentTime = value; position = value }
    private func stopTimer() { timer?.invalidate(); timer = nil }
    func stop() { player?.pause(); playing = false; stopTimer() }
}

struct SoundPlayer: View {
    let item: JSON
    @Environment(\.chatServer) private var server
    @State private var model = SoundModel()
    private var title: String {
        switch item["audioKind"].string { case "music": "Music"; case "sound": "Sound effect"; default: "Speech" }
    }
    private var seconds: Double { model.length > 0 ? model.length : item["seconds"].double }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 14) {
                Button { Task { await model.toggle(item: item, server: server) } } label: {
                    ZStack {
                        Circle().fill(Theme.clay)
                        if model.loading { ProgressView().tint(.white) } else { Image(systemName: model.playing ? "pause.fill" : "play.fill").foregroundStyle(.white).font(.system(size: 16)) }
                    }.frame(width: 44, height: 44)
                }.buttonStyle(.plain).disabled(model.loading).accessibilityLabel(model.playing ? "Pause" : "Play")
                VStack(alignment: .leading, spacing: 4) {
                    Text(item["voice"].string.isEmpty ? title : "\(title), \(item["voice"].string)").font(.subheadline.weight(.medium))
                    if seconds > 0 {
                        ProgressView(value: min(model.position, seconds), total: seconds).tint(Theme.clay)
                        Text("\(MediaNaming.duration(model.position)) / \(MediaNaming.duration(seconds))").font(.caption.monospacedDigit()).foregroundStyle(Theme.inkMuted)
                    }
                }
                ShareFileButton(blob: item["blob"].string, mime: item["mime"].string, name: "\(item["id"].string).\(ChatBlobs.extensionFor(mime: item["mime"].string))").labelStyle(.iconOnly).foregroundStyle(Theme.inkMuted)
            }
            if model.failed { Text("The sound could not be loaded. Tap play to try again.").font(.footnote).foregroundStyle(Theme.danger) }
            if !item["lyrics"].string.isEmpty { DisclosureGroup("Words") { Text(item["lyrics"].string).font(.footnote).foregroundStyle(Theme.inkSecondary).frame(maxWidth: .infinity, alignment: .leading) }.font(.footnote).tint(Theme.inkMuted) }
        }
        .padding(14).card(radius: 16)
        .onDisappear { model.stop() }
    }
}

// MARK: - Everything that was made

@MainActor @Observable final class ChatGalleryModel {
    var items: [JSON] = []
    var next: Double?
    var totalBytes = 0
    var state: LoadState = .idle
    enum LoadState: Equatable { case idle, loading, loaded, failed(String), more }
    var kind = ""
    var query = ""

    func load(store: AppStore, more: Bool = false) async {
        if more { guard let next else { return }; state = .more; await fetch(store, before: next, append: true) }
        else { state = .loading; await fetch(store, before: nil, append: false) }
    }

    private func fetch(_ store: AppStore, before: Double?, append: Bool) async {
        var params: [String: JSON] = ["limit": 60]
        if let before { params["before"] = .number(before) }
        if !kind.isEmpty { params["kind"] = .string(kind) }
        if !query.trimmingCharacters(in: .whitespaces).isEmpty { params["query"] = .string(query.trimmingCharacters(in: .whitespaces)) }
#if DEBUG
        if Demo.requested != nil { ChatDemo.seedImages() }
#endif
        do {
            let page = try await store.rpc.call("generatedImages.list", params)
            items = append ? items + page["items"].array : page["items"].array
            next = page["next"] == .null ? nil : page["next"].double
            totalBytes = page["totalBytes"].int
            state = .loaded
        } catch is CancellationError { return } catch { state = .failed(ChatError.text(error)) }
    }
}

/// Every picture, clip and sound the person's conversations made, newest first.
struct GalleryPage: View {
    let store: AppStore
    var open: (String) -> Void = { _ in }
    @State private var model = ChatGalleryModel()
    @State private var viewing: Int?
    @State private var playing: JSON?
    private var pictures: [JSON] { model.items.filter { $0["kind"].string.isEmpty || $0["kind"].string == "image" } }

    var body: some View {
        Group {
            switch model.state {
            case .idle, .loading: ProgressView().controlSize(.large).frame(maxWidth: .infinity, maxHeight: .infinity)
            case .failed(let message): ScrollView { InlineError(message: message) { Task { await model.load(store: store) } }.padding(.top, 60) }
            default:
                if model.items.isEmpty {
                    ScrollView { EmptyState(title: model.query.isEmpty && model.kind.isEmpty ? "Nothing made yet" : "Nothing matches", symbol: "photo.on.rectangle", message: model.query.isEmpty && model.kind.isEmpty ? "Pictures, clips and sounds that Atelier makes in your conversations collect here." : "Try another search or filter.").padding(.top, 60) }
                } else { grid }
            }
        }
        .background(Theme.background)
        .navigationTitle("Images").navigationBarTitleDisplayMode(.inline)
        .searchable(text: $model.query, prompt: "Search by prompt")
        .onSubmit(of: .search) { Task { await model.load(store: store) } }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Picker("Show", selection: $model.kind) { Text("Everything").tag(""); Text("Pictures").tag("image"); Text("Clips").tag("video"); Text("Sounds").tag("audio") }
                } label: { Image(systemName: model.kind.isEmpty ? "line.3.horizontal.decrease.circle" : "line.3.horizontal.decrease.circle.fill") }.accessibilityLabel("Filter")
            }
        }
        .onChange(of: model.kind) { _, _ in Task { await model.load(store: store) } }
        .refreshable { await model.load(store: store) }
        .task { if model.state == .idle { await model.load(store: store) } }
        .fullScreenCover(item: Binding(get: { viewing.map { Start(index: $0) } }, set: { if $0 == nil { viewing = nil } })) { MediaViewer(items: pictures, start: $0.index) }
        .sheet(item: Binding(get: { playing.map { Playing(item: $0) } }, set: { if $0 == nil { playing = nil } })) { box in
            NavigationStack {
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        if box.item["kind"].string == "video" { ClipPlayer(item: box.item) } else { SoundPlayer(item: box.item) }
                        Text(box.item["prompt"].string).font(.subheadline).foregroundStyle(Theme.inkSecondary)
                        if !box.item["sessionId"].string.isEmpty { Button("Open the conversation") { playing = nil; open(box.item["sessionId"].string) }.buttonStyle(QuietButtonStyle()) }
                    }.padding(16)
                }.background(Theme.background).navigationTitle(box.item["kind"].string == "video" ? "Clip" : "Sound").navigationBarTitleDisplayMode(.inline)
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { playing = nil } } }
            }.tint(Theme.clay).presentationDetents([.medium, .large])
        }
    }

    private struct Start: Identifiable { let index: Int; var id: Int { index } }
    private struct Playing: Identifiable { let item: JSON; var id: String { item["blob"].string } }

    private var grid: some View {
        ScrollView {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 104), spacing: 4)], spacing: 4) {
                ForEach(Array(model.items.enumerated()), id: \.offset) { _, item in
                    tile(item).onAppear { if item == model.items.last { Task { await model.load(store: store, more: true) } } }
                }
            }.padding(4)
            if model.state == .more { ProgressView().padding() }
            if model.totalBytes > 0 { Text("\(ChatText.plural(model.items.count, "item")) shown, \(ChatText.bytes(model.totalBytes)) in all").font(.footnote).foregroundStyle(Theme.inkMuted).padding(.vertical, 16) }
        }
    }

    @ViewBuilder private func tile(_ item: JSON) -> some View {
        let kind = item["kind"].string
        Button {
            if kind == "video" || kind == "audio" { playing = item } else if let index = pictures.firstIndex(of: item) { viewing = index }
        } label: {
            ZStack {
                if kind == "video" || kind == "audio" {
                    Rectangle().fill(kind == "video" ? Color.black : Theme.fill)
                    VStack(spacing: 6) {
                        Image(systemName: kind == "video" ? "play.circle.fill" : "waveform").font(.system(size: 26, weight: .light)).foregroundStyle(kind == "video" ? .white : Theme.inkMuted)
                        if item["seconds"].double > 0 { Text(MediaNaming.duration(item["seconds"].double)).font(.caption2.monospacedDigit()).foregroundStyle(kind == "video" ? .white.opacity(0.8) : Theme.inkMuted) }
                    }
                } else {
                    Color.clear.overlay { BlobImage(blob: item["blob"].string, mime: item["mime"].string, maxHeight: 220, corner: 0, fill: true) }.clipped()
                }
            }
            .aspectRatio(1, contentMode: .fit).clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(kind == "video" ? "Clip" : kind == "audio" ? "Sound" : "Picture"): \(item["prompt"].string)")
    }
}

// MARK: - Change an area

/// "Change an area": brush over part of a picture, say what it should become, and send the picture with a mask of the
/// marked part (white is what changes) as one message. The model turns it into an image edit.
struct ChatAreaEditor: View {
    let store: AppStore
    let item: JSON
    @State private var strokes: [Stroke] = []
    @State private var current: Stroke?
    @State private var size = 12.0
    @State private var erasing = false
    @State private var instruction = ""
    @State private var image: UIImage?
    @State private var failed = false
    @State private var busy = false
    @Environment(\.dismiss) private var dismiss
    @Environment(\.chatServer) private var server

    struct Stroke { var erase: Bool; var fraction: CGFloat; var points: [CGPoint] }

    /// The brush's width as a share of the picture's shorter side: at 100 it is 40 percent, and never under a few pixels.
    static func brushFraction(size: Double, width: CGFloat, height: CGFloat) -> CGFloat {
        let clamped = min(100, max(1, size))
        let natural = max(4, CGFloat(clamped / 100) * min(width, height) * 0.4)
        return natural / max(1, min(width, height))
    }

    /// The largest side of a mask; a larger picture gets a smaller mask (the server resizes it back).
    static func maskSize(_ width: CGFloat, _ height: CGFloat) -> CGSize {
        let scale = min(1, 4096 / max(width, height))
        return CGSize(width: max(1, (width * scale).rounded()), height: max(1, (height * scale).rounded()))
    }

    /// Black, with every stroke in white (or black again where it was erased).
    static func mask(strokes: [Stroke], width: CGFloat, height: CGFloat) -> Data? {
        let size = maskSize(width, height)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let image = UIGraphicsImageRenderer(size: size, format: format).image { context in
            let cg = context.cgContext
            UIColor.black.setFill()
            cg.fill(CGRect(origin: .zero, size: size))
            cg.setLineCap(.round)
            cg.setLineJoin(.round)
            for stroke in strokes {
                let color = stroke.erase ? UIColor.black : UIColor.white
                let diameter = stroke.fraction * min(size.width, size.height)
                cg.setStrokeColor(color.cgColor)
                cg.setFillColor(color.cgColor)
                cg.setLineWidth(diameter)
                let points = stroke.points.map { CGPoint(x: $0.x * size.width, y: $0.y * size.height) }
                if points.count == 1, let point = points.first { cg.fillEllipse(in: CGRect(x: point.x - diameter / 2, y: point.y - diameter / 2, width: diameter, height: diameter)) }
                else if let first = points.first { cg.move(to: first); for point in points.dropFirst() { cg.addLine(to: point) }; cg.strokePath() }
            }
        }
        return image.pngData()
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 14) {
                if let image { canvas(image) } else if failed { Label("This picture could not be loaded", systemImage: "photo.badge.exclamationmark").foregroundStyle(Theme.inkMuted).frame(maxHeight: .infinity) } else { ProgressView().frame(maxHeight: .infinity) }
                tools
                HStack(spacing: 10) {
                    TextField("What should it become? For example: a red door", text: $instruction, axis: .vertical).lineLimit(1...3).padding(12).background(Theme.fill, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                    Button { send() } label: { Image(systemName: busy ? "hourglass" : "arrow.up").font(.system(size: 16, weight: .bold)).foregroundStyle(.white).frame(width: 42, height: 42).background(Theme.clay.opacity(ready ? 1 : 0.35), in: Circle()) }
                        .buttonStyle(.plain).disabled(!ready).accessibilityLabel("Send")
                }
            }
            .padding(16).background(Theme.background)
            .navigationTitle("Change an area").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
            .task { do { image = try await ChatBlobs.shared.image(sha: item["blob"].string, mime: item["mime"].string, server: server) } catch is CancellationError { return } catch { failed = true } }
        }
        .tint(Theme.clay)
    }

    private var ready: Bool { !strokes.isEmpty && !instruction.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !busy && image != nil }

    private func canvas(_ image: UIImage) -> some View {
        GeometryReader { proxy in
            let fit = AVMakeRect(aspectRatio: image.size, insideRect: CGRect(origin: .zero, size: proxy.size))
            ZStack {
                Image(uiImage: image).resizable().frame(width: fit.width, height: fit.height)
                Canvas { context, _ in
                    context.drawLayer { layer in
                        for stroke in strokes + (current.map { [$0] } ?? []) {
                            let width = stroke.fraction * min(fit.width, fit.height)
                            let points = stroke.points.map { CGPoint(x: $0.x * fit.width, y: $0.y * fit.height) }
                            guard let first = points.first else { continue }
                            layer.blendMode = stroke.erase ? .clear : .normal
                            var path = Path()
                            if points.count == 1 {
                                path.addEllipse(in: CGRect(x: first.x - width / 2, y: first.y - width / 2, width: width, height: width))
                                layer.fill(path, with: .color(Theme.clay.opacity(0.55)))
                            } else {
                                path.move(to: first)
                                for point in points.dropFirst() { path.addLine(to: point) }
                                layer.stroke(path, with: .color(Theme.clay.opacity(0.55)), style: StrokeStyle(lineWidth: width, lineCap: .round, lineJoin: .round))
                            }
                        }
                    }
                }
                .frame(width: fit.width, height: fit.height).allowsHitTesting(false)
            }
            .frame(width: fit.width, height: fit.height).position(x: fit.midX, y: fit.midY)
            .contentShape(Rectangle())
            .gesture(DragGesture(minimumDistance: 0).onChanged { value in
                let point = CGPoint(x: min(1, max(0, (value.location.x - (proxy.size.width - fit.width) / 2) / max(1, fit.width))), y: min(1, max(0, (value.location.y - (proxy.size.height - fit.height) / 2) / max(1, fit.height))))
                var stroke = current ?? Stroke(erase: erasing, fraction: Self.brushFraction(size: size, width: image.size.width, height: image.size.height), points: [])
                stroke.points.append(point)
                current = stroke
            }.onEnded { _ in if let current { strokes.append(current) }; current = nil })
        }
        .accessibilityLabel("The picture. Paint the part to change.")
    }

    private var tools: some View {
        VStack(spacing: 10) {
            Picker("Tool", selection: $erasing) { Text("Paint").tag(false); Text("Erase").tag(true) }.pickerStyle(.segmented)
            HStack(spacing: 12) {
                Image(systemName: "circle.fill").font(.system(size: 6)).foregroundStyle(Theme.inkMuted)
                Slider(value: $size, in: 1...100).accessibilityLabel("Brush size")
                Image(systemName: "circle.fill").font(.system(size: 18)).foregroundStyle(Theme.inkMuted)
                Button { _ = strokes.popLast() } label: { Image(systemName: "arrow.uturn.backward") }.disabled(strokes.isEmpty).accessibilityLabel("Undo")
                Button { strokes = [] } label: { Image(systemName: "trash") }.disabled(strokes.isEmpty).accessibilityLabel("Clear")
            }
        }
    }

    private func send() {
        guard let image, let session = store.selected, let data = Self.mask(strokes: strokes, width: image.size.width, height: image.size.height) else { return }
        busy = true
        let text = instruction.trimmingCharacters(in: .whitespacesAndNewlines)
        Task {
            defer { busy = false }
            do {
                let file = try await store.rpc.call("files.upload", ["name": "area-mask.png", "mime": "image/png", "dataBase64": .string(data.base64EncodedString()), "sessionId": .string(session)])
                let parts: [JSON] = [.obj(["type": "context", "text": "", "notice": .obj(["kind": "area", "image": .obj(["blob": item["blob"], "mime": item["mime"]]), "mask": .obj(["blob": file["blob"], "mime": "image/png"])])]), JSON.text(text)]
                _ = try await store.rpc.call("chat.queue", ["sessionId": .string(session), "parts": .array(parts)])
                dismiss()
            } catch is CancellationError { return } catch { store.error = ChatError.text(error) }
        }
    }
}
