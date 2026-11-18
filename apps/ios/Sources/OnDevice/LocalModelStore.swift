import Foundation
import CryptoKit
import Network
import UIKit

/// A model the phone can run itself, as Atelier offers it for download.
struct LocalModelSpec: Identifiable, Hashable, Sendable {
    /// The name the server knows it by (`<provider>/<id>`).
    let id: String
    let name: String
    let maker: String
    /// Its files on Hugging Face (MLX, 4-bit).
    let repo: String
    /// About how much it downloads.
    let bytes: Int64
    /// How many tokens of conversation it is asked to hold: what the phone's memory allows, not the model's own limit.
    let context: Int
    let blurb: String
    /// It reasons out loud first (`<think>…</think>`), which Atelier shows as its thinking.
    let thinks: Bool

    var sizeText: String { ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file) }

    static let catalog: [LocalModelSpec] = [
        LocalModelSpec(id: "lfm2.5-1.2b", name: "LFM2.5 1.2B", maker: "Liquid AI", repo: "lmstudio-community/LFM2.5-1.2B-Instruct-MLX-4bit", bytes: 660_000_000, context: 32_768, blurb: "Quick and light. Good for short answers, rewriting and quick questions; not for code or deep knowledge.", thinks: false),
        LocalModelSpec(id: "gemma-3-1b", name: "Gemma 3 1B", maker: "Google", repo: "mlx-community/gemma-3-1b-it-qat-4bit", bytes: 770_000_000, context: 32_768, blurb: "Small and steady, with Google's polish. Good for everyday chat and summaries.", thinks: false),
        LocalModelSpec(id: "qwen3-1.7b", name: "Qwen3 1.7B", maker: "Alibaba", repo: "mlx-community/Qwen3-1.7B-4bit", bytes: 980_000_000, context: 16_384, blurb: "Thinks before it answers, so it reasons better than its size. Slower to start.", thinks: true),
        LocalModelSpec(id: "qwen3-4b", name: "Qwen3 4B", maker: "Alibaba", repo: "mlx-community/Qwen3-4B-4bit", bytes: 2_280_000_000, context: 12_288, blurb: "The smartest one that fits comfortably: thinks first and writes well. Uses a lot of memory.", thinks: true),
    ]

    static func spec(_ id: String) -> LocalModelSpec? { catalog.first { $0.id == id } }
}

/// What the phone holds of the models it can run: the downloaded ones, the ones coming, and how much room they take.
/// Files live in Application Support (never purged by the system, never in a backup), one folder per model.
@MainActor @Observable final class LocalModelStore: NSObject {
    static let shared = LocalModelStore()

    enum State: Equatable {
        case notInstalled
        case downloading(Double)
        /// The connection dropped part-way: it tries again by itself and goes on from where it stopped.
        case reconnecting(Double)
        /// Stopped by the person, or by a connection that stayed away: everything that arrived is kept, and Resume goes on from there.
        case paused(Double)
        case waitingForWiFi
        case failed(String)
        case installed

        /// How much of the download has arrived, when there is one.
        var fraction: Double? {
            switch self {
            case .downloading(let value), .reconnecting(let value), .paused(let value): value
            default: nil
            }
        }
    }

    private(set) var states: [String: State] = [:]
    /// Whether a download may use mobile data. Off: it waits for Wi-Fi.
    /// (A download that is already running keeps what it began with.)
    var allowsCellular: Bool { didSet { UserDefaults.standard.set(allowsCellular, forKey: "localModelsCellular") } }
    /// Called when a model arrives or goes, so the server hears about it.
    var onChange: (() -> Void)?

    private static let sessionID = "dev.atelierhq.mobile.models"
    private var session: URLSession!
    private var backgroundCompletion: (() -> Void)?
    /// What each running download task is for: slug and the file it fetches.
    private var plans: [String: Plan] = [:]
    /// How many times in a row a model's download has lost its connection without getting anywhere, and the pause before its next try.
    private var retries: [String: Int] = [:]
    private var retryTasks: [String: Task<Void, Never>] = [:]
    /// Models whose download the person just stopped: the cancelled tasks still report back, and must not leave files behind.
    private var cancelling: Set<String> = []
    private let monitor = NWPathMonitor()

    private struct FileInfo: Codable, Sendable { let path: String; let size: Int64; let sha256: String? }
    private struct Plan: Codable, Sendable {
        var files: [FileInfo]
        var done: Set<String> = []
        var received: [String: Int64] = [:]
        var total: Int64 { files.reduce(0) { $0 + $1.size } }
    }

    override private init() {
        allowsCellular = UserDefaults.standard.bool(forKey: "localModelsCellular")
        super.init()
        makeSession()
        for spec in LocalModelSpec.catalog { states[spec.id] = FileManager.default.fileExists(atPath: Self.marker(spec.id).path) ? .installed : .notInstalled }
        #if DEBUG || E2E
        // `--fake-models lfm2.5-1.2b,qwen3-1.7b`: those count as downloaded (for the simulator, which runs no model).
        if let list = Launch.value("--fake-models") {
            for id in list.split(separator: ",").map(String.init) where LocalModelSpec.spec(id) != nil {
                try? FileManager.default.createDirectory(at: Self.folder(id), withIntermediateDirectories: true)
                try? Data().write(to: Self.marker(id))
                states[id] = .installed
            }
        }
        #endif
        // A download that was begun and not finished waits here, paused, with what it has: the app was closed, or the connection never came back.
        for spec in LocalModelSpec.catalog where states[spec.id] != .installed {
            if let plan = Self.readPlan(spec.id) { plans[spec.id] = plan; states[spec.id] = .paused(Self.fraction(plan)) }
        }
        // When the connection comes back, the downloads that were waiting for it go on at once instead of after their pause.
        monitor.pathUpdateHandler = { [weak self] path in
            guard path.status == .satisfied else { return }
            Task { @MainActor in self?.connectionIsBack() }
        }
        monitor.start(queue: DispatchQueue(label: "dev.atelierhq.mobile.models.path"))
        Task { await reattach() }
    }

    // MARK: where things are

    nonisolated static var root: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appending(path: "OnDeviceModels", directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        var url = base
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? url.setResourceValues(values)
        return base
    }
    nonisolated static func folder(_ id: String) -> URL { root.appending(path: id, directoryHint: .isDirectory) }
    nonisolated private static func marker(_ id: String) -> URL { folder(id).appending(path: ".installed") }
    nonisolated private static func partial(_ id: String) -> URL { root.appending(path: ".downloading-\(id)", directoryHint: .isDirectory) }

    var installed: [LocalModelSpec] { LocalModelSpec.catalog.filter { states[$0.id] == .installed } }
    func state(_ id: String) -> State { states[id] ?? .notInstalled }
    var bytesUsed: Int64 {
        installed.reduce(0) { $0 + (Self.folderSize(Self.folder($1.id))) }
    }
    nonisolated private static func folderSize(_ url: URL) -> Int64 {
        let keys: [URLResourceKey] = [.fileAllocatedSizeKey]
        guard let walker = FileManager.default.enumerator(at: url, includingPropertiesForKeys: keys) else { return 0 }
        var total: Int64 = 0
        for case let file as URL in walker { total += Int64((try? file.resourceValues(forKeys: Set(keys)).fileAllocatedSize) ?? 0) }
        return total
    }
    /// How much room the phone has left for downloads.
    static var freeBytes: Int64 {
        let values = try? URL(fileURLWithPath: NSHomeDirectory()).resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
        return values?.volumeAvailableCapacityForImportantUsage ?? 0
    }

    // MARK: downloading

    private func makeSession() {
        let configuration = URLSessionConfiguration.background(withIdentifier: Self.sessionID)
        configuration.isDiscretionary = false
        configuration.sessionSendsLaunchEvents = true
        configuration.waitsForConnectivity = true
        session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }

    /// Picks up downloads that went on while the app was away.
    private func reattach() async {
        let tasks = await session.allTasks
        for task in tasks {
            guard let id = task.taskDescription?.split(separator: "|").first.map(String.init), LocalModelSpec.spec(id) != nil else { continue }
            if case .paused(let value) = state(id) { states[id] = .downloading(value) } else if states[id] == .notInstalled || states[id] == nil { states[id] = .downloading(0) }
            if plans[id] == nil, let plan = Self.readPlan(id) { plans[id] = plan }
        }
        // A model whose files are all there but never got its marker (the app ended at the wrong moment).
        for spec in LocalModelSpec.catalog where state(spec.id) != .installed {
            if let plan = Self.readPlan(spec.id), plan.done.count == plan.files.count, !tasks.contains(where: { $0.taskDescription?.hasPrefix(spec.id + "|") == true }) { finish(spec.id) }
        }
    }

    nonisolated private static func planURL(_ id: String) -> URL { partial(id).appending(path: "plan.json") }
    nonisolated private static func readPlan(_ id: String) -> Plan? { (try? Data(contentsOf: planURL(id))).flatMap { try? JSONDecoder().decode(Plan.self, from: $0) } }
    private func writePlan(_ id: String) {
        guard let plan = plans[id] else { return }
        try? JSONEncoder().encode(plan).write(to: Self.planURL(id))
    }

    func download(_ spec: LocalModelSpec) { begin(spec, automatic: false) }

    /// Starts a model's download, or carries it on: files that arrived whole stay, a file that was cut short goes on from where
    /// it stopped, and a file that is already being fetched is left alone. `automatic` is a try after a lost connection.
    private func begin(_ spec: LocalModelSpec, automatic: Bool) {
        guard state(spec.id) != .installed else { return }
        if case .downloading = state(spec.id) { return }
        retryTasks[spec.id]?.cancel()
        retryTasks[spec.id] = nil
        cancelling.remove(spec.id)
        if !automatic { retries[spec.id] = 0 }
        let before = state(spec.id).fraction ?? 0
        states[spec.id] = automatic ? .reconnecting(before) : .downloading(before)
        Task {
            do {
                if Self.freeBytes > 0, Self.freeBytes < Int64(Double(spec.bytes) * (1 - before)) + 500_000_000 { throw LocalModelError.noRoom(spec.sizeText) }
                // Without the connection the list cannot be asked for again, but the one from the first try is still known.
                let known = plans[spec.id] ?? Self.readPlan(spec.id)
                let files: [FileInfo]
                do { files = try await Self.listFiles(spec.repo) } catch { guard let known else { throw error }; files = known.files }
                try FileManager.default.createDirectory(at: Self.partial(spec.id), withIntermediateDirectories: true)
                var plan = known ?? Plan(files: files)
                plan.files = files
                // What is already in the folder counts: a file that arrived whole before is not fetched again.
                for file in files where Self.partialFile(spec.id, file.path).flatMap({ try? FileManager.default.attributesOfItem(atPath: $0.path)[.size] as? Int64 }) == file.size { plan.done.insert(file.path) }
                plans[spec.id] = plan
                writePlan(spec.id)
                let running = Set(await session.allTasks.filter { $0.state == .running || $0.state == .suspended }.compactMap(\.taskDescription))
                for file in files where !plan.done.contains(file.path) && !running.contains("\(spec.id)|\(file.path)") { start(spec, file) }
                if plan.done.count == files.count { finish(spec.id) } else { update(spec.id) }
            } catch {
                if DownloadRecovery.isTransient(error) { dropped(spec.id) } else { states[spec.id] = .failed(error.localizedDescription) }
            }
        }
    }

    private func start(_ spec: LocalModelSpec, _ file: FileInfo) {
        let task: URLSessionDownloadTask
        if let data = Self.takeResumeData(spec.id, file.path) {
            // What the earlier try had already fetched is not fetched again.
            task = session.downloadTask(withResumeData: data)
        } else {
            guard let url = URL(string: "https://huggingface.co/\(spec.repo)/resolve/main/\(file.path)") else { return }
            var request = URLRequest(url: url)
            request.allowsCellularAccess = allowsCellular
            task = session.downloadTask(with: request)
        }
        task.taskDescription = "\(spec.id)|\(file.path)"
        task.resume()
    }

    /// Stops a download and keeps everything that has arrived: each running file hands back the point it reached.
    func pause(_ spec: LocalModelSpec) {
        let id = spec.id
        retryTasks[id]?.cancel()
        retryTasks[id] = nil
        states[id] = .paused(state(id).fraction ?? 0)
        Task {
            for task in await session.allTasks where task.taskDescription?.hasPrefix(id + "|") == true {
                guard let task = task as? URLSessionDownloadTask, let path = task.taskDescription?.split(separator: "|", maxSplits: 1).last.map(String.init) else { continue }
                if let data = await task.cancelByProducingResumeData() { Self.saveResumeData(data, id, path) }
            }
        }
    }

    /// Stops a download for good and throws away what had arrived.
    func cancel(_ spec: LocalModelSpec) {
        let id = spec.id
        retryTasks[id]?.cancel()
        retryTasks[id] = nil
        retries[id] = nil
        cancelling.insert(id)
        states[id] = .notInstalled
        plans[id] = nil
        Task {
            for task in await session.allTasks where task.taskDescription?.hasPrefix(id + "|") == true { task.cancel() }
            try? FileManager.default.removeItem(at: Self.partial(id))
            // The cancelled tasks report back a moment later; by then the folder must stay gone.
            try? await Task.sleep(for: .seconds(3))
            try? FileManager.default.removeItem(at: Self.partial(id))
            cancelling.remove(id)
        }
    }

    func delete(_ spec: LocalModelSpec) {
        try? FileManager.default.removeItem(at: Self.folder(spec.id))
        states[spec.id] = .notInstalled
        onChange?()
    }

    /// The connection was lost (or the server stumbled): wait a little, then carry on from where it stopped. After a good many
    /// tries in a row with no progress it waits, paused, for the person.
    private func dropped(_ id: String) {
        guard retryTasks[id] == nil, state(id) != .installed else { return }
        if case .paused = state(id) { return }
        let fraction = state(id).fraction ?? 0
        let attempt = retries[id] ?? 0
        guard let delay = DownloadRecovery.delay(afterAttempts: attempt) else {
            retries[id] = 0
            states[id] = .paused(fraction)
            return
        }
        retries[id] = attempt + 1
        states[id] = .reconnecting(fraction)
        retryTasks[id] = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            self?.retryTasks[id] = nil
            self?.restart(id)
        }
    }

    private func restart(_ id: String) {
        guard case .reconnecting = state(id), let spec = LocalModelSpec.spec(id) else { return }
        begin(spec, automatic: true)
    }

    private func connectionIsBack() {
        for (id, state) in states { if case .reconnecting = state { retryTasks[id]?.cancel(); retryTasks[id] = nil; restart(id) } }
    }

    nonisolated private static func fraction(_ plan: Plan) -> Double {
        guard plan.total > 0 else { return 0 }
        return min(1, Double(plan.files.filter { plan.done.contains($0.path) }.reduce(0) { $0 + $1.size }) / Double(plan.total))
    }

    // MARK: what a stopped file has fetched so far

    nonisolated private static func resumeURL(_ id: String, _ path: String) -> URL { partial(id).appending(path: DownloadRecovery.resumeFileName(path)) }
    nonisolated private static func saveResumeData(_ data: Data, _ id: String, _ path: String) {
        guard !data.isEmpty, FileManager.default.fileExists(atPath: partial(id).path) else { return }
        try? data.write(to: resumeURL(id, path), options: .atomic)
    }
    nonisolated private static func takeResumeData(_ id: String, _ path: String) -> Data? {
        let url = resumeURL(id, path)
        defer { try? FileManager.default.removeItem(at: url) }
        return (try? Data(contentsOf: url)).flatMap { $0.isEmpty ? nil : $0 }
    }

    private func update(_ id: String) {
        guard let plan = plans[id], plan.total > 0 else { return }
        let received = plan.files.reduce(Int64(0)) { $0 + (plan.done.contains($1.path) ? $1.size : (plan.received[$1.path] ?? 0)) }
        // A late report from a task that was just paused or stopped must not start the bar again.
        switch state(id) {
        case .downloading, .reconnecting, .waitingForWiFi: states[id] = .downloading(min(1, Double(received) / Double(plan.total)))
        case .paused, .failed, .notInstalled, .installed: break
        }
    }

    nonisolated private static func partialFile(_ id: String, _ path: String) -> URL? { partial(id).appending(path: path) }

    /// Every file of the repository that the model needs (the picture of it, the card and git's own files are not).
    private static func listFiles(_ repo: String) async throws -> [FileInfo] {
        var request = URLRequest(url: URL(string: "https://huggingface.co/api/models/\(repo)/tree/main")!)
        request.timeoutInterval = 30
        let (data, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200, let list = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { throw LocalModelError.listing }
        let files: [FileInfo] = list.compactMap { entry in
            guard entry["type"] as? String == "file", let path = entry["path"] as? String, !path.hasPrefix("."), path != "README.md", !path.contains("..") else { return nil }
            let lfs = entry["lfs"] as? [String: Any]
            let size = (lfs?["size"] as? Int64) ?? (entry["size"] as? Int64) ?? Int64((lfs?["size"] as? Int) ?? (entry["size"] as? Int) ?? 0)
            return FileInfo(path: path, size: size, sha256: lfs?["oid"] as? String)
        }
        guard files.contains(where: { $0.path == "config.json" }), files.contains(where: { $0.path.hasSuffix(".safetensors") }) else { throw LocalModelError.listing }
        return files
    }

    private func finish(_ id: String) {
        guard let plan = plans[id] ?? Self.readPlan(id) else { return }
        let target = Self.folder(id)
        try? FileManager.default.removeItem(at: target)
        for file in (try? FileManager.default.contentsOfDirectory(atPath: Self.partial(id).path)) ?? [] where file.hasPrefix("resume-") {
            try? FileManager.default.removeItem(at: Self.partial(id).appending(path: file))
        }
        do {
            try FileManager.default.moveItem(at: Self.partial(id), to: target)
            try? FileManager.default.removeItem(at: target.appending(path: "plan.json"))
            try Data().write(to: Self.marker(id))
            plans[id] = nil
            states[id] = .installed
            _ = plan
            onChange?()
        } catch {
            states[id] = .failed(error.localizedDescription)
        }
    }

    func handleBackgroundEvents(_ completion: @escaping () -> Void) { backgroundCompletion = completion }
}

enum LocalModelError: LocalizedError {
    case listing, noRoom(String), damaged(String)
    var errorDescription: String? {
        switch self {
        case .listing: "Atelier could not read the model's file list from Hugging Face."
        case .noRoom(let size): "There is not enough room on this iPhone: the model needs about \(size) and some space to spare."
        case .damaged(let file): "\(file) did not download correctly. Try again."
        }
    }
}

extension LocalModelStore: URLSessionDownloadDelegate {
    nonisolated func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteTotalBytesWritten written: Int64, totalBytesExpectedToWrite expected: Int64) {
        guard let parts = downloadTask.taskDescription?.split(separator: "|", maxSplits: 1).map(String.init), parts.count == 2 else { return }
        Task { @MainActor in
            let before = self.plans[parts[0]]?.received[parts[1]] ?? 0
            self.plans[parts[0]]?.received[parts[1]] = written
            // Bytes are arriving again: the next lost connection starts the waiting over.
            if written > before { self.retries[parts[0]] = 0 }
            self.update(parts[0])
        }
    }

    nonisolated func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        guard let parts = downloadTask.taskDescription?.split(separator: "|", maxSplits: 1).map(String.init), parts.count == 2 else { return }
        let id = parts[0], path = parts[1]
        // The system deletes the file when this returns: move it now, and check it is the file that was asked for.
        let destination = Self.partial(id).appending(path: path)
        let status = (downloadTask.response as? HTTPURLResponse)?.statusCode ?? 0
        let problem: String? = {
            // 206: a file that was carried on from where it stopped comes whole, but with the answer to the part that was asked for.
            guard status == 200 || status == 206 else { return "\(path) was not available (\(status))." }
            do {
                try FileManager.default.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
                try? FileManager.default.removeItem(at: destination)
                try FileManager.default.moveItem(at: location, to: destination)
                return nil
            } catch { return error.localizedDescription }
        }()
        Task { @MainActor in
            guard var plan = self.plans[id] ?? Self.readPlan(id), let file = plan.files.first(where: { $0.path == path }) else { return }
            if let problem {
                // A busy server (5xx, 429) is the same as a lost connection: try again in a moment.
                if DownloadRecovery.isTransient(status: status) { self.dropped(id) } else { self.states[id] = .failed(problem) }
                return
            }
            // Size always, and the checksum of the big files: a model that is cut short or altered must not load.
            let size = (try? FileManager.default.attributesOfItem(atPath: destination.path)[.size] as? Int64) ?? -1
            if size != file.size && file.size > 0 { try? FileManager.default.removeItem(at: destination); self.states[id] = .failed(LocalModelError.damaged(path).localizedDescription); return }
            if let expected = file.sha256, expected.count == 64, file.size > 1_000_000 {
                let actual = await Task.detached { Self.sha256(of: destination) }.value
                if actual != expected { try? FileManager.default.removeItem(at: destination); self.states[id] = .failed(LocalModelError.damaged(path).localizedDescription); return }
            }
            plan.done.insert(path)
            self.plans[id] = plan
            self.writePlan(id)
            if plan.done.count == plan.files.count { self.finish(id) } else { self.update(id) }
        }
    }

    nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let error, let parts = task.taskDescription?.split(separator: "|", maxSplits: 1).map(String.init), parts.count == 2 else { return }
        let id = parts[0], path = parts[1]
        let nsError = error as NSError
        // A file that was cut short says how far it got: that is what a later try goes on from (also when the system stopped it,
        // for instance when the app was swiped away).
        let resumeData = nsError.userInfo[NSURLSessionDownloadTaskResumeData] as? Data
        Task { @MainActor in
            if let resumeData, !self.cancelling.contains(id), self.state(id) != .installed { Self.saveResumeData(resumeData, id, path) }
            // Stopped on purpose (paused, or taken away): not a failure.
            if nsError.code == NSURLErrorCancelled { return }
            if case .installed = self.state(id) { return }
            if case .paused = self.state(id) { return }
            if DownloadRecovery.isTransient(error) { self.dropped(id) } else { self.states[id] = .failed(error.localizedDescription) }
        }
    }

    nonisolated func urlSession(_ session: URLSession, taskIsWaitingForConnectivity task: URLSessionTask) {
        guard let id = task.taskDescription?.split(separator: "|").first.map(String.init) else { return }
        Task { @MainActor in
            if case .downloading = self.state(id) { self.states[id] = .waitingForWiFi }
        }
    }

    nonisolated func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        Task { @MainActor in
            self.backgroundCompletion?()
            self.backgroundCompletion = nil
        }
    }

    nonisolated private static func sha256(of url: URL) -> String? {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? handle.close() }
        var hasher = SHA256()
        while let chunk = try? handle.read(upToCount: 8 * 1024 * 1024), !chunk.isEmpty { hasher.update(data: chunk) }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }
}

/// When a download that lost its connection tries again, and which errors count as a lost connection.
enum DownloadRecovery {
    /// Seconds to wait before the first, second, … try in a row; after the last one the download waits, paused, for the person.
    static let delays: [Double] = [2, 5, 10, 20, 40, 60, 120, 180]
    static func delay(afterAttempts attempts: Int) -> Double? { delays.indices.contains(attempts) ? delays[attempts] : nil }

    private static let transient: Set<Int> = [
        NSURLErrorNetworkConnectionLost, NSURLErrorTimedOut, NSURLErrorNotConnectedToInternet, NSURLErrorDataNotAllowed,
        NSURLErrorCannotConnectToHost, NSURLErrorCannotFindHost, NSURLErrorDNSLookupFailed, NSURLErrorInternationalRoamingOff,
        NSURLErrorCallIsActive, NSURLErrorResourceUnavailable, NSURLErrorCannotLoadFromNetwork, NSURLErrorBackgroundSessionWasDisconnected,
    ]
    static func isTransient(_ error: Error) -> Bool {
        let error = error as NSError
        return error.domain == NSURLErrorDomain && transient.contains(error.code)
    }
    /// A server that is busy or stumbling (not one that says the file is not there).
    static func isTransient(status: Int) -> Bool { status == 408 || status == 429 || (500...599).contains(status) }

    /// The file a stopped download's resume point is kept in, one per model file.
    static func resumeFileName(_ path: String) -> String { "resume-" + path.replacingOccurrences(of: "/", with: "__") }
}
