import SwiftUI

// Media providers: where pictures, videos and sounds are made. Separate from the providers of text models, with their
// own list of services (presets), models and a form. A port of the desktop's image-provider-form.ts.

struct AMMediaPreset: Identifiable, Equatable, Sendable {
    enum Group: String, CaseIterable, Sendable {
        case local, cloud, aggregator, custom
        var title: String {
            switch self { case .local: "On a computer you run"; case .cloud: "Cloud services"; case .aggregator: "Many models, one key"; case .custom: "Any compatible server" }
        }
    }
    enum KeyNeed: Sendable { case required, optional, none }

    let id: String
    let label: String
    let type: String
    let group: Group
    let baseURL: String
    let key: KeyNeed
    var keyURL: String?
    var help: String?
    var suggested: [String]?
    var sharesKeyWith: String?

    /// Local servers can share a GPU with a text model; a custom address may be one.
    var runsLocally: Bool { group == .local || group == .custom }
    /// Only a local server is certainly free; a custom address may be a paid gateway.
    var mayCostMoney: Bool { group != .local }
    /// Services that list no models: they are typed in, starting from the suggestions.
    var hasTypedModels: Bool { suggested != nil || id == "azure" || id == "openai-compatible" }
    var symbol: String { runsLocally ? "server.rack" : "cloud" }

    static let all: [AMMediaPreset] = [
        AMMediaPreset(id: "comfyui", label: "ComfyUI", type: "comfyui", group: .local, baseURL: "http://127.0.0.1:8188", key: .none, help: "Your checkpoints appear as models. To reach it from another computer, start it with --listen."),
        AMMediaPreset(id: "forge", label: "Forge", type: "a1111", group: .local, baseURL: "http://127.0.0.1:7860", key: .none, help: "Start it with --api. Forge Neo and reForge work the same way."),
        AMMediaPreset(id: "a1111", label: "AUTOMATIC1111", type: "a1111", group: .local, baseURL: "http://127.0.0.1:7860", key: .none, help: "Start it with --api."),
        AMMediaPreset(id: "sdnext", label: "SD.Next", type: "a1111", group: .local, baseURL: "http://127.0.0.1:7860", key: .none),
        AMMediaPreset(id: "swarmui", label: "SwarmUI", type: "swarmui", group: .local, baseURL: "http://127.0.0.1:7801", key: .none),
        AMMediaPreset(id: "invokeai", label: "InvokeAI", type: "invokeai", group: .local, baseURL: "http://127.0.0.1:9090", key: .none),
        AMMediaPreset(id: "drawthings", label: "Draw Things", type: "a1111", group: .local, baseURL: "http://127.0.0.1:7860", key: .none, help: "Turn on the API Server in the app, with HTTP as the protocol."),
        AMMediaPreset(id: "koboldcpp", label: "KoboldCpp", type: "a1111", group: .local, baseURL: "http://127.0.0.1:5001", key: .none, help: "Start it with an image model loaded."),
        AMMediaPreset(id: "sd-server", label: "stable-diffusion.cpp", type: "a1111", group: .local, baseURL: "http://127.0.0.1:1234", key: .none, help: "Use its sd-server program."),
        AMMediaPreset(id: "localai", label: "LocalAI", type: "openai-images", group: .local, baseURL: "http://127.0.0.1:8080", key: .optional),
        AMMediaPreset(id: "openai", label: "OpenAI", type: "openai-images", group: .cloud, baseURL: "https://api.openai.com", key: .required, keyURL: "https://platform.openai.com/api-keys", sharesKeyWith: "openai"),
        AMMediaPreset(id: "chatgpt", label: "ChatGPT Plan", type: "responses-image", group: .cloud, baseURL: "https://chatgpt.com/backend-api/codex", key: .none, help: "Uses your ChatGPT Plan sign-in, and your plan’s limits."),
        AMMediaPreset(id: "gemini", label: "Google Gemini", type: "gemini", group: .cloud, baseURL: "https://generativelanguage.googleapis.com", key: .required, keyURL: "https://aistudio.google.com/apikey"),
        AMMediaPreset(id: "vertex", label: "Google Vertex AI", type: "gemini", group: .cloud, baseURL: "https://aiplatform.googleapis.com", key: .required, help: "Express mode: use an API key from Google Cloud. Add each image model by name.", suggested: ["gemini-2.5-flash-image"]),
        AMMediaPreset(id: "bfl", label: "Black Forest Labs", type: "bfl", group: .cloud, baseURL: "https://api.bfl.ai", key: .required, keyURL: "https://dashboard.bfl.ai"),
        AMMediaPreset(id: "stability", label: "Stability AI", type: "stability", group: .cloud, baseURL: "https://api.stability.ai", key: .required, keyURL: "https://platform.stability.ai/dashboard/api-keys"),
        AMMediaPreset(id: "xai", label: "xAI", type: "openai-images", group: .cloud, baseURL: "https://api.x.ai", key: .required, keyURL: "https://console.x.ai"),
        AMMediaPreset(id: "ideogram", label: "Ideogram", type: "ideogram", group: .cloud, baseURL: "https://api.ideogram.ai", key: .required, keyURL: "https://ideogram.ai/manage-api"),
        AMMediaPreset(id: "recraft", label: "Recraft", type: "openai-images", group: .cloud, baseURL: "https://external.api.recraft.ai", key: .required, keyURL: "https://www.recraft.ai/profile/api"),
        AMMediaPreset(id: "azure", label: "Azure OpenAI", type: "openai-images", group: .cloud, baseURL: "https://YOUR-RESOURCE.openai.azure.com", key: .required, help: "Add each image deployment by name as a model."),
        AMMediaPreset(id: "bedrock", label: "Amazon Bedrock", type: "bedrock", group: .cloud, baseURL: "https://bedrock-runtime.us-west-2.amazonaws.com", key: .required, help: "Paste a Bedrock API key, or an access key and secret as ACCESS_KEY:SECRET. Its Stability image models run in us-west-2."),
        AMMediaPreset(id: "mistral-images", label: "Mistral", type: "mistral-images", group: .cloud, baseURL: "https://api.mistral.ai", key: .required, keyURL: "https://console.mistral.ai/api-keys", help: "Runs through a Mistral chat model and its image tool (FLUX), so each image also costs that model’s tokens.", sharesKeyWith: "mistral"),
        AMMediaPreset(id: "openrouter", label: "OpenRouter", type: "chat-images", group: .aggregator, baseURL: "https://openrouter.ai/api", key: .required, keyURL: "https://openrouter.ai/keys", sharesKeyWith: "openai-compatible"),
        AMMediaPreset(id: "fal", label: "fal.ai", type: "fal", group: .aggregator, baseURL: "https://queue.fal.run", key: .required, keyURL: "https://fal.ai/dashboard/keys", suggested: ["fal-ai/flux/schnell","fal-ai/flux-2-pro"]),
        AMMediaPreset(id: "replicate", label: "Replicate", type: "replicate", group: .aggregator, baseURL: "https://api.replicate.com", key: .required, keyURL: "https://replicate.com/account/api-tokens", suggested: ["black-forest-labs/flux-schnell","black-forest-labs/flux-1.1-pro"]),
        AMMediaPreset(id: "together", label: "Together AI", type: "openai-images", group: .aggregator, baseURL: "https://api.together.xyz", key: .required, keyURL: "https://api.together.ai/settings/api-keys", suggested: ["black-forest-labs/FLUX.1-schnell","black-forest-labs/FLUX.2-dev"]),
        AMMediaPreset(id: "huggingface", label: "Hugging Face", type: "huggingface", group: .aggregator, baseURL: "https://router.huggingface.co", key: .required, keyURL: "https://huggingface.co/settings/tokens", suggested: ["black-forest-labs/FLUX.1-dev"]),
        AMMediaPreset(id: "openrouter-video", label: "OpenRouter video", type: "openrouter-video", group: .aggregator, baseURL: "https://openrouter.ai/api", key: .required, keyURL: "https://openrouter.ai/keys", help: "Veo, Kling, Wan, Seedance and others through one key. Its models are listed for you.", sharesKeyWith: "openai-compatible"),
        AMMediaPreset(id: "xai-video", label: "xAI video", type: "xai-video", group: .cloud, baseURL: "https://api.x.ai", key: .required, keyURL: "https://console.x.ai"),
        AMMediaPreset(id: "fal-video", label: "fal.ai video", type: "fal", group: .aggregator, baseURL: "https://queue.fal.run", key: .required, keyURL: "https://fal.ai/dashboard/keys", help: "Lists fal’s text-to-video and image-to-video models; type in any other video endpoint by its id.", suggested: ["kling/v4/text-to-video","alibaba/wan-3.0/text-to-video"]),
        AMMediaPreset(id: "replicate-video", label: "Replicate video", type: "replicate", group: .aggregator, baseURL: "https://api.replicate.com", key: .required, keyURL: "https://replicate.com/account/api-tokens", help: "Type in a video model as owner/name.", suggested: ["google/veo-3.1","alibaba/wan-3"]),
        AMMediaPreset(id: "bfl-video", label: "Black Forest Labs video", type: "bfl", group: .cloud, baseURL: "https://api.bfl.ai", key: .required, keyURL: "https://dashboard.bfl.ai", suggested: ["flux-3-video"]),
        AMMediaPreset(id: "gemini-video", label: "Google Gemini video", type: "gemini", group: .cloud, baseURL: "https://generativelanguage.googleapis.com", key: .required, keyURL: "https://aistudio.google.com/apikey", help: "Gemini Omni makes the video in one request, so it can take a few minutes and has no length setting.", suggested: ["gemini-omni-1.1-flash"]),
        AMMediaPreset(id: "openai-compatible", label: "OpenAI-compatible images", type: "openai-images", group: .custom, baseURL: "http://127.0.0.1:8000", key: .optional, help: "Any server with /v1/images/generations, such as LiteLLM."),
        AMMediaPreset(id: "kokoro", label: "Kokoro-FastAPI", type: "openai-speech", group: .local, baseURL: "http://127.0.0.1:8880", key: .none, help: "Its voices are listed for you, and voices can be mixed, like af_bella+af_sky."),
        AMMediaPreset(id: "speaches", label: "Speaches", type: "openai-speech", group: .local, baseURL: "http://127.0.0.1:8000", key: .optional, help: "Speaks with the Kokoro and Piper models it has downloaded."),
        AMMediaPreset(id: "localai-speech", label: "LocalAI audio", type: "openai-speech", group: .local, baseURL: "http://127.0.0.1:8080", key: .optional, help: "Speech, and music and sound effects from models such as ACE-Step, MusicGen or Stable Audio."),
        AMMediaPreset(id: "koboldcpp-speech", label: "KoboldCpp speech", type: "openai-speech", group: .local, baseURL: "http://127.0.0.1:5001", key: .none, help: "Start it with a speech model loaded (--ttsmodel)."),
        AMMediaPreset(id: "chatterbox", label: "Chatterbox TTS Server", type: "openai-speech", group: .local, baseURL: "http://127.0.0.1:8004", key: .none, help: "Its predefined voices and the reference voices you added are listed."),
        AMMediaPreset(id: "ollama-speech", label: "Ollama speech", type: "openai-speech", group: .local, baseURL: "http://127.0.0.1:11434", key: .none, help: "Pull a speech model first, such as phonon."),
        AMMediaPreset(id: "vllm-omni", label: "vLLM-Omni", type: "openai-speech", group: .local, baseURL: "http://127.0.0.1:8091", key: .optional, help: "Serves Qwen3-TTS, CosyVoice, Fish and others in OpenAI’s speech format."),
        AMMediaPreset(id: "fish-speech", label: "Fish Speech", type: "fish-audio", group: .local, baseURL: "http://127.0.0.1:8080", key: .optional, help: "Fish Speech’s own API server. A voice is the id of a reference you added to it."),
        AMMediaPreset(id: "acestep", label: "ACE-Step 1.5", type: "acestep", group: .local, baseURL: "http://127.0.0.1:8001", key: .optional, help: "Songs with vocals and instrumentals. Start acestep-api."),
        AMMediaPreset(id: "openai-speech", label: "OpenAI speech", type: "openai-speech", group: .cloud, baseURL: "https://api.openai.com", key: .required, keyURL: "https://platform.openai.com/api-keys", help: "GPT-4o mini TTS with directions, TTS-1 and TTS-1 HD. OpenAI retires them on 6 January 2027.", sharesKeyWith: "openai"),
        AMMediaPreset(id: "elevenlabs", label: "ElevenLabs", type: "elevenlabs", group: .cloud, baseURL: "https://api.elevenlabs.io", key: .required, keyURL: "https://elevenlabs.io/app/settings/api-keys", help: "Speech in your account’s voices, music and sound effects. Music needs a paid plan."),
        AMMediaPreset(id: "gemini-audio", label: "Google Gemini audio", type: "gemini-audio", group: .cloud, baseURL: "https://generativelanguage.googleapis.com", key: .required, keyURL: "https://aistudio.google.com/apikey", help: "Gemini’s speech models, with 30 voices and up to two speakers, and Lyria music."),
        AMMediaPreset(id: "xai-speech", label: "xAI speech", type: "xai-speech", group: .cloud, baseURL: "https://api.x.ai", key: .required, keyURL: "https://console.x.ai"),
        AMMediaPreset(id: "stability-audio", label: "Stability AI audio", type: "stability", group: .cloud, baseURL: "https://api.stability.ai", key: .required, keyURL: "https://platform.stability.ai/dashboard/api-keys", help: "Stable Audio: music and sound effects, without vocals."),
        AMMediaPreset(id: "azure-speech", label: "Azure OpenAI speech", type: "openai-speech", group: .cloud, baseURL: "https://YOUR-RESOURCE.openai.azure.com", key: .required, help: "Add each speech deployment by name as a model."),
        AMMediaPreset(id: "mistral-speech", label: "Mistral Voxtral", type: "openai-speech", group: .cloud, baseURL: "https://api.mistral.ai", key: .required, keyURL: "https://console.mistral.ai/api-keys", sharesKeyWith: "mistral"),
        AMMediaPreset(id: "groq-speech", label: "Groq speech", type: "openai-speech", group: .cloud, baseURL: "https://api.groq.com/openai", key: .required, keyURL: "https://console.groq.com/keys", help: "Orpheus. It reads up to 200 characters a call."),
        AMMediaPreset(id: "cartesia", label: "Cartesia", type: "cartesia", group: .cloud, baseURL: "https://api.cartesia.ai", key: .required, keyURL: "https://play.cartesia.ai/keys"),
        AMMediaPreset(id: "deepgram", label: "Deepgram Aura", type: "deepgram", group: .cloud, baseURL: "https://api.deepgram.com", key: .required, keyURL: "https://console.deepgram.com"),
        AMMediaPreset(id: "fish-audio", label: "Fish Audio", type: "fish-audio", group: .cloud, baseURL: "https://api.fish.audio", key: .required, keyURL: "https://fish.audio/app/api-keys", help: "Your account’s voices are listed for you."),
        AMMediaPreset(id: "minimax-audio", label: "MiniMax speech", type: "minimax-audio", group: .cloud, baseURL: "https://api.minimax.io", key: .required, keyURL: "https://platform.minimax.io"),
        AMMediaPreset(id: "openrouter-speech", label: "OpenRouter speech", type: "openai-speech", group: .aggregator, baseURL: "https://openrouter.ai/api", key: .required, keyURL: "https://openrouter.ai/keys", help: "Speech models from OpenAI, Google, Mistral, Fish, xAI and others through one key. Its models are listed for you.", sharesKeyWith: "openai-compatible"),
        AMMediaPreset(id: "together-speech", label: "Together AI speech", type: "openai-speech", group: .aggregator, baseURL: "https://api.together.xyz", key: .required, keyURL: "https://api.together.ai/settings/api-keys"),
        AMMediaPreset(id: "fal-audio", label: "fal.ai audio", type: "fal", group: .aggregator, baseURL: "https://queue.fal.run", key: .required, keyURL: "https://fal.ai/dashboard/keys", help: "Lists fal’s speech, music and sound models; type in any other audio endpoint by its id.", suggested: ["fal-ai/elevenlabs/tts/eleven-v4","fal-ai/stable-audio-25/text-to-audio"]),
        AMMediaPreset(id: "replicate-audio", label: "Replicate audio", type: "replicate", group: .aggregator, baseURL: "https://api.replicate.com", key: .required, keyURL: "https://replicate.com/account/api-tokens", help: "Type in a speech or music model as owner/name.", suggested: ["minimax/speech-02-hd","meta/musicgen"]),
        AMMediaPreset(id: "openai-compatible-speech", label: "OpenAI-compatible speech", type: "openai-speech", group: .custom, baseURL: "http://127.0.0.1:8000", key: .optional, help: "Any server with /v1/audio/speech, such as LiteLLM."),
    ]

    static func find(_ id: String?) -> AMMediaPreset? { id.flatMap { id in all.first { $0.id == id } } }

    /// A provider's service: the preset it was added as, or a preset of its kind for one written into a settings file.
    static func of(preset: String?, type: String) -> AMMediaPreset {
        find(preset) ?? all.first { $0.type == type } ?? all[all.count - 1]
    }
}

/// A media provider as the settings keep it.
struct AMMediaProvider: Identifiable, Equatable, Sendable {
    let id: String
    let typeID: String
    let presetID: String?
    let name: String
    let baseURL: String
    let apiKey: String?
    let enabled: Bool
    let parallelRequests: Int?
    let sharesGpuWith: String?
    let freeAfterRun: Bool
    let models: [String]
    let workflows: [JSON]
    let raw: JSON

    init(json: JSON) {
        raw = json
        id = json["id"].string
        typeID = json["type"].string
        presetID = json["preset"].stringOrNil
        name = json["name"].string
        baseURL = json["baseUrl"].string
        apiKey = json["apiKey"].stringOrNil
        enabled = json["enabled"].boolOrNil ?? true
        parallelRequests = json["parallelRequests"].intOrNil
        sharesGpuWith = json["sharesGpuWith"].stringOrNil
        freeAfterRun = json["freeAfterRun"].bool
        models = json["models"].strings
        workflows = json["workflows"].array
    }

    var preset: AMMediaPreset { AMMediaPreset.of(preset: presetID, type: typeID) }
    var isComfy: Bool { typeID == "comfyui" }

    /// The saved provider as a draft for changing part of it: its stored key stays out, or it would be saved as a new key.
    func draft() -> [String: JSON] {
        guard case .object(var object) = raw else { return [:] }
        object.removeValue(forKey: "apiKey")
        return object
    }
}

struct AMDetectedMedia: Identifiable, Equatable, Sendable {
    let preset: String
    let type: String
    let baseURL: String
    let label: String
    var id: String { "\(preset)|\(baseURL)" }
    init(json: JSON) { preset = json["preset"].string; type = json["type"].string; baseURL = json["baseUrl"].string; label = json["label"].string }
}

// MARK: - Models

/// An image, video or sound model, with what it takes.
struct AMMediaModel: Identifiable, Equatable, Sendable {
    enum Kind: String, Sendable { case image, video, audio }

    let ref: String
    let providerID: String
    let modelID: String
    let displayName: String
    let description: String?
    var hidden: Bool
    var favorite: Bool
    let kind: Kind
    let family: String
    let tunable: Bool
    let edit: Bool
    let previews: Bool
    let samplers: [String]
    let schedulers: [String]
    let defaultSteps: Int?
    let defaultGuidance: Double?
    let defaultSampler: String?
    let defaultScheduler: String?
    // Video
    let durationText: String?
    let defaultSeconds: Double?
    let fixedLength: Bool
    let fps: [Int]
    let defaultFPS: Int?
    let resolutions: [String]
    let videoSound: String?
    let firstFrame: Bool
    let firstFrameRequired: Bool
    // Sound
    let audioKinds: [String]
    let voices: [(id: String, name: String, detail: String?)]
    let defaultVoice: String?
    let soundDurationText: String?
    let soundDefaultSeconds: Double?
    let lyrics: Bool
    let direction: Bool
    let maxSpeakers: Int?
    var id: String { ref }

    static func == (lhs: AMMediaModel, rhs: AMMediaModel) -> Bool { lhs.ref == rhs.ref && lhs.hidden == rhs.hidden && lhs.favorite == rhs.favorite && lhs.displayName == rhs.displayName && lhs.description == rhs.description }

    init(json: JSON) {
        ref = json["ref"].string
        providerID = json["providerId"].string
        modelID = json["modelId"].string
        displayName = json["displayName"].string
        description = json["description"].stringOrNil
        hidden = json["hidden"].bool
        favorite = json["favorite"].bool
        let caps = json["capabilities"]
        kind = Kind(rawValue: caps["output"].string) ?? .image
        family = caps["family"].string
        tunable = caps["tunable"].bool
        edit = caps["edit"].bool
        previews = caps["previews"].bool
        samplers = caps["samplers"].strings
        schedulers = caps["schedulers"].strings
        defaultSteps = caps["defaults"]["steps"].intOrNil
        defaultGuidance = caps["defaults"]["guidance"].doubleOrNil
        defaultSampler = caps["defaults"]["sampler"].stringOrNil
        defaultScheduler = caps["defaults"]["scheduler"].stringOrNil
        let video = caps["video"]
        durationText = video == .null ? nil : AMMediaModel.durations(video["durations"], fixed: video["fixedLength"].bool)
        defaultSeconds = video["defaultSeconds"].doubleOrNil
        fixedLength = video["fixedLength"].bool
        fps = video["fps"].array.compactMap(\.intOrNil)
        defaultFPS = video["defaultFps"].intOrNil
        resolutions = video["resolutions"].strings
        videoSound = video["audio"].stringOrNil
        firstFrame = video["firstFrame"].bool
        firstFrameRequired = video["firstFrameRequired"].bool
        let audio = caps["audio"]
        audioKinds = audio["kinds"].strings
        voices = audio["voices"].array.map { ($0["id"].string, $0["name"].string, $0["description"].stringOrNil) }
        defaultVoice = audio["defaultVoice"].stringOrNil
        soundDurationText = audio == .null ? nil : AMMediaModel.durations(audio["durations"], fixed: false)
        soundDefaultSeconds = audio["defaultSeconds"].doubleOrNil
        lyrics = audio["lyrics"].bool
        direction = audio["direction"].bool
        maxSpeakers = audio["maxSpeakers"].intOrNil
    }

    /// "4 to 8 s", "6 s", "2 min": the lengths a model makes.
    static func durations(_ json: JSON, fixed: Bool) -> String? {
        if fixed { return "Its own length" }
        let low: Double, high: Double
        switch json["kind"].string {
        case "list":
            let seconds = json["seconds"].array.compactMap(\.doubleOrNil)
            guard let min = seconds.min(), let max = seconds.max() else { return nil }
            low = min; high = max
        case "range":
            guard let min = json["min"].doubleOrNil, let max = json["max"].doubleOrNil else { return nil }
            low = min; high = max
        default: return nil
        }
        func show(_ s: Double) -> String { s >= 120 && s.truncatingRemainder(dividingBy: 60) == 0 ? "\(Int(s / 60)) min" : "\(Int(s)) s" }
        if low == high { return show(low) }
        return high >= 120 ? "\(show(low)) to \(show(high))" : "\(Int(low)) to \(Int(high)) s"
    }

    var kindLabel: String { kind == .video ? "Video" : kind == .audio ? "Sound" : "Image" }

    /// "Speech, music" and so on for a sound model.
    var soundKindsLabel: String { audioKinds.map { $0 == "speech" ? "Speech" : $0 == "music" ? "Music" : "Sound effects" }.joined(separator: ", ") }

    var familyLabel: String? {
        ["sd15": "SD 1.5", "sdxl": "SDXL", "sdxl-distilled": "SDXL distilled", "sd3": "SD3", "flux": "FLUX", "flux2": "FLUX.2", "z-image": "Z-Image"][family]
    }

    /// The words under a model's name.
    var summary: String {
        switch kind {
        case .audio:
            var parts = [soundKindsLabel]
            if voices.count > 1 { parts.append("\(voices.count) voices") }
            if maxSpeakers ?? 1 > 1 { parts.append("dialogue") }
            if lyrics { parts.append("lyrics") }
            if let soundDurationText { parts.append(soundDurationText) }
            return parts.joined(separator: ", ")
        case .video:
            var parts = ["Video"]
            if let durationText { parts.append(durationText) }
            if let videoSound, videoSound != "none" { parts.append("with sound") }
            if firstFrame { parts.append(firstFrameRequired ? "from a picture" : "can start from a picture") }
            return parts.joined(separator: ", ")
        case .image:
            var parts: [String] = []
            if let familyLabel { parts.append(familyLabel) }
            if edit { parts.append("edits pictures") }
            if previews { parts.append("previews") }
            return parts.isEmpty ? "Image" : parts.joined(separator: ", ")
        }
    }
}

/// The five defaults an admin can set: a model for each thing that can be made.
enum AMMediaDefault: String, CaseIterable, Identifiable {
    case image, video, speech, music, sound
    var id: String { rawValue }
    var title: String {
        switch self {
        case .image: "Default image model"
        case .video: "Default video model"
        case .speech: "Default speech model"
        case .music: "Default music model"
        case .sound: "Default sound effects model"
        }
    }
    var shortTitle: String {
        switch self { case .image: "Image model"; case .video: "Video model"; case .speech: "Speech model"; case .music: "Music model"; case .sound: "Sound effects model" }
    }
    var noun: String {
        switch self { case .image: "Images"; case .video: "Videos"; case .speech: "Speech and voice-overs"; case .music: "Songs and music"; case .sound: "Sound effects" }
    }
    var summary: String {
        switch self {
        case .image: "What makes images unless a person or a conversation chooses another."
        case .video: "What makes videos unless a person chooses another or names one when they ask."
        case .speech: "What reads text aloud unless a person chooses another or names one when they ask."
        case .music: "What makes music unless a person chooses another or names one when they ask."
        case .sound: "What makes sound effects unless a person chooses another or names one when they ask."
        }
    }
    var path: [JSON] { ["models", "defaults", .string(rawValue)] }
    @MainActor func offered(_ store: AppStore) -> Bool {
        switch self {
        case .image: store.offers("imageGeneration")
        case .video: store.offers("videoGeneration")
        case .speech, .music, .sound: store.offers("audioGeneration")
        }
    }
    func fits(_ model: AMMediaModel) -> Bool {
        switch self {
        case .image: model.kind == .image
        case .video: model.kind == .video
        case .speech: model.kind == .audio && model.audioKinds.contains("speech")
        case .music: model.kind == .audio && model.audioKinds.contains("music")
        case .sound: model.kind == .audio && model.audioKinds.contains("sound")
        }
    }
}

// MARK: - The form

struct AMMediaForm: Equatable, Sendable {
    enum Field: Hashable { case name, id, baseURL, apiKey, parallel, models }

    let preset: AMMediaPreset
    var name: String
    var id: String
    var idEdited = false
    var baseURL: String
    var apiKey = ""
    /// Copies this text provider's key when saved, so nobody pastes it twice.
    var keyFrom: String?
    var parallelRequests = ""
    var sharesGpuWith: String?
    var freeAfterRun = false
    var models: [String]
    /// What the form doesn't show, kept when editing.
    var keptHeaders: JSON = [:]
    var keptEnabled = true
    var keptWorkflows: JSON = .null

    static func new(_ preset: AMMediaPreset, taken: Set<String>, name: String? = nil, baseURL: String? = nil) -> AMMediaForm {
        let shown = name ?? preset.label
        return AMMediaForm(preset: preset, name: shown, id: AMForm.uniqueID(AMForm.slugify(shown), taken: taken), baseURL: baseURL ?? preset.baseURL, models: preset.suggested ?? [])
    }

    init(preset: AMMediaPreset, name: String, id: String, baseURL: String, models: [String]) {
        self.preset = preset; self.name = name; self.id = id; self.baseURL = baseURL; self.models = models
    }

    init(config: AMMediaProvider) {
        preset = config.preset
        name = config.name
        id = config.id
        idEdited = true
        baseURL = config.baseURL
        parallelRequests = config.parallelRequests.map(String.init) ?? ""
        sharesGpuWith = config.sharesGpuWith
        freeAfterRun = config.freeAfterRun
        models = config.models
        keptHeaders = config.raw["headers"] == .null ? [:] : config.raw["headers"]
        keptEnabled = config.enabled
        keptWorkflows = config.raw["workflows"]
    }

    mutating func rename(_ newName: String, taken: Set<String>) {
        name = newName
        if !idEdited { id = AMForm.uniqueID(AMForm.slugify(newName), taken: taken) }
    }

    func errors(taken: Set<String>, editing: Bool, hasStoredKey: Bool) -> [Field: String] {
        var errors: [Field: String] = [:]
        let url = baseURL.trimmingCharacters(in: .whitespaces)
        if name.trimmingCharacters(in: .whitespaces).isEmpty { errors[.name] = "Enter a name." }
        if !AMForm.isValidID(id) { errors[.id] = "Use lowercase letters, digits and dashes, starting with a letter or digit." }
        else if !editing, taken.contains(id) { errors[.id] = "Another provider already uses this short name." }
        if !AMForm.isHTTPURL(url) { errors[.baseURL] = "Enter an address starting with http:// or https://." }
        else if url.contains("YOUR-RESOURCE") { errors[.baseURL] = "Put the name of your resource in place of YOUR-RESOURCE." }
        if preset.key == .required, apiKey.trimmingCharacters(in: .whitespaces).isEmpty, keyFrom == nil, !(editing && hasStoredKey) { errors[.apiKey] = "\(preset.label) needs an API key." }
        if AMForm.count(parallelRequests, max: 64) == .invalid { errors[.parallel] = "Leave empty for automatic, or enter 1 to 64." }
        if preset.id == "azure", models.isEmpty { errors[.models] = "Add at least one deployment." }
        return errors
    }

    /// What `imageProviders.test`, `.tryImage` and `.save` take. The key goes along only when one was entered or copied.
    func draft() -> [String: JSON] {
        var draft: [String: JSON] = [
            "headers": keptHeaders, "enabled": .bool(keptEnabled),
            "id": .string(id), "type": .string(preset.type), "preset": .string(preset.id),
            "name": .string(name.trimmingCharacters(in: .whitespaces)), "baseUrl": .string(baseURL.trimmingCharacters(in: .whitespaces)),
        ]
        if keptWorkflows != .null { draft["workflows"] = keptWorkflows }
        if case .value(let n) = AMForm.count(parallelRequests, max: 64) { draft["parallelRequests"] = .number(Double(n)) }
        if let sharesGpuWith { draft["sharesGpuWith"] = .string(sharesGpuWith) }
        if freeAfterRun { draft["freeAfterRun"] = true }
        if !models.isEmpty { draft["models"] = .array(models.map { .string($0) }) }
        if let keyFrom { draft["apiKeyFromProvider"] = .string(keyFrom) }
        else if !apiKey.trimmingCharacters(in: .whitespaces).isEmpty { draft["apiKey"] = .string(apiKey.trimmingCharacters(in: .whitespaces)) }
        return draft
    }

    /// A server found on this computer is added in one tap: it needs no key, and the rest of its details are known.
    static func detectedDraft(_ found: AMDetectedMedia, taken: Set<String>) -> [String: JSON] {
        AMMediaForm.new(AMMediaPreset.of(preset: found.preset, type: found.type), taken: taken, name: found.label, baseURL: found.baseURL).draft()
    }
}

enum AMMediaKeys {
    private static func host(_ url: String) -> String? {
        guard let host = URL(string: url)?.host?.lowercased() else { return nil }
        return host == "localhost" || host == "::1" || host.hasPrefix("127.") ? "localhost" : host
    }

    /// Text providers whose key also works for this service: for a service that isn't OpenAI itself, only those at its own address.
    static func sources(for preset: AMMediaPreset, providers: [AMProvider]) -> [AMProvider] {
        guard let shares = preset.sharesKeyWith else { return [] }
        return providers.filter { $0.typeID == shares && $0.apiKey != nil && ($0.typeID == "openai" || host($0.baseURL) == host(preset.baseURL)) }
    }

    /// Local text providers an image server can share a GPU with, those on its own computer first.
    static func gpuPartners(baseURL: String, providers: [AMProvider]) -> [(provider: AMProvider, sameHost: Bool)] {
        let mine = host(baseURL)
        return providers
            .filter { !($0.type?.hosted ?? true) && AMTextPreset.of(baseURL: $0.baseURL) == nil }
            .map { ($0, mine != nil && host($0.baseURL) == mine) }
            .sorted { $0.sameHost && !$1.sameHost }
    }
}
