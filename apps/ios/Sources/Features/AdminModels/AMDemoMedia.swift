import SwiftUI

#if DEBUG
/// Canned answers for the media page, in the shapes the server really sends.
enum AMDemoMedia {
    static let methods: Set<String> = [
        "imageProviders.status", "imageProviders.detect", "imageProviders.test", "imageProviders.tryImage", "imageProviders.trySound",
        "imageProviders.save", "imageProviders.remove", "imageProviders.refresh", "imageProviders.parseWorkflow", "imageProviders.savedWorkflows", "imageModels.list",
    ]
    static func handles(_ method: String) -> Bool { methods.contains(method) }

    private static func now(_ secondsAgo: Double = 0) -> JSON { AMDemoData.now(secondsAgo) }

    static let workflow: JSON = [
        "id": "product-shots", "name": "Product shots",
        "graph": [
            "3": ["class_type": "KSampler", "inputs": ["seed": 156680208700286, "steps": 25, "cfg": 7, "sampler_name": "euler", "scheduler": "normal", "positive": ["6", 0], "negative": ["7", 0]], "_meta": ["title": "KSampler"]],
            "5": ["class_type": "EmptyLatentImage", "inputs": ["width": 1024, "height": 1024, "batch_size": 1]],
            "6": ["class_type": "CLIPTextEncode", "inputs": ["text": "a studio photo of a ceramic mug", "clip": ["4", 1]], "_meta": ["title": "Positive prompt"]],
            "7": ["class_type": "CLIPTextEncode", "inputs": ["text": "blurry, low quality", "clip": ["4", 1]], "_meta": ["title": "Negative prompt"]],
            "9": ["class_type": "SaveImage", "inputs": ["filename_prefix": "atelier", "images": ["8", 0]]],
        ],
        "map": ["prompt": ["node": "6", "input": "text"], "negative": ["node": "7", "input": "text"], "seed": ["node": "3", "input": "seed"], "steps": ["node": "3", "input": "steps"], "width": ["node": "5", "input": "width"], "height": ["node": "5", "input": "height"], "output": "9"],
    ]

    static let providers: [JSON] = [
        ["id": "comfyui", "type": "comfyui", "preset": "comfyui", "name": "ComfyUI", "baseUrl": "http://192.168.1.20:8188", "headers": [:], "enabled": true, "sharesGpuWith": "ollama", "freeAfterRun": true, "workflows": [workflow]],
        ["id": "openai-images", "type": "openai-images", "preset": "openai", "name": "OpenAI images", "baseUrl": "https://api.openai.com", "apiKey": "${secret:provider-openai}", "headers": [:], "enabled": true],
        ["id": "elevenlabs", "type": "elevenlabs", "preset": "elevenlabs", "name": "ElevenLabs", "baseUrl": "https://api.elevenlabs.io", "apiKey": "${secret:provider-elevenlabs}", "headers": [:], "enabled": true],
        ["id": "kokoro", "type": "openai-speech", "preset": "kokoro", "name": "Kokoro on the home server", "baseUrl": "http://192.168.1.20:8880", "headers": [:], "enabled": false],
        ["id": "gemini-video", "type": "gemini", "preset": "gemini-video", "name": "Google Gemini video", "baseUrl": "https://generativelanguage.googleapis.com", "apiKey": "${secret:provider-gemini}", "headers": [:], "enabled": true, "models": ["gemini-omni-1.1-flash"]],
    ]

    static let statuses: [JSON] = [
        ["providerId": "comfyui", "ok": true, "latencyMs": 14, "modelCount": 4, "warnings": [], "checkedAt": now(90)],
        ["providerId": "openai-images", "ok": true, "latencyMs": 310, "modelCount": 2, "warnings": [], "checkedAt": now(200)],
        ["providerId": "elevenlabs", "ok": true, "latencyMs": 420, "modelCount": 3, "warnings": ["Music needs a paid ElevenLabs plan. Your key can make speech and sound effects."], "checkedAt": now(180)],
        ["providerId": "kokoro", "ok": false, "modelCount": 0, "warnings": [], "checkedAt": 0],
        ["providerId": "gemini-video", "ok": false, "modelCount": 0, "warnings": [], "error": "Google rejected the key (403). Check it at aistudio.google.com/apikey.", "checkedAt": now(300)],
    ]

    private static func image(_ ref: String, _ name: String, family: String = "hosted", edit: Bool = false, tunable: Bool = false, previews: Bool = false, description: String? = nil) -> JSON {
        let parts = ref.split(separator: "/", maxSplits: 1).map(String.init)
        var caps: [String: JSON] = [
            "family": .string(family), "promptStyle": "natural", "negativePrompt": false, "sizes": ["kind": "free", "min": 512, "max": 2048, "multiple": 64, "base": 1024],
            "maxCount": 4, "edit": .bool(edit), "mask": false, "maxReferences": 0, "transparent": false, "seed": true, "previews": .bool(previews), "tunable": .bool(tunable),
        ]
        if tunable {
            caps["defaults"] = ["steps": 25, "guidance": 7, "sampler": "euler", "scheduler": "normal"]
            caps["samplers"] = ["euler", "euler_ancestral", "dpmpp_2m", "dpmpp_sde", "uni_pc"]
            caps["schedulers"] = ["normal", "karras", "exponential", "simple"]
        }
        var json: [String: JSON] = ["ref": .string(ref), "providerId": .string(parts[0]), "modelId": .string(parts[1]), "displayName": .string(name), "capabilities": .object(caps), "source": "detected", "hidden": false, "favorite": false, "order": 1000]
        if let description { json["description"] = .string(description) }
        return .object(json)
    }

    static func models(_ world: AMDemoWorld) -> [JSON] {
        if world.state == "empty" { return [] }
        let video: JSON = ["ref": "gemini-video/gemini-omni-1.1-flash", "providerId": "gemini-video", "modelId": "gemini-omni-1.1-flash", "displayName": "Gemini Omni 1.1 Flash", "source": "catalog", "hidden": false, "favorite": false, "order": 1000,
                            "capabilities": ["output": "video", "family": "hosted", "promptStyle": "natural", "negativePrompt": false, "sizes": ["kind": "aspect", "ratios": ["16:9", "9:16"], "classes": ["720p", "1080p"]], "maxCount": 1, "edit": false, "mask": false, "maxReferences": 0, "transparent": false, "seed": false, "previews": false, "tunable": false,
                                             "video": ["durations": ["kind": "list", "seconds": [4, 6, 8]], "defaultSeconds": 6, "fps": [24, 30], "defaultFps": 24, "resolutions": ["720p", "1080p"], "firstFrame": true, "lastFrame": false, "audio": "always"]]]
        func sound(_ ref: String, _ name: String, kinds: [String], voices: Bool = false) -> JSON {
            let parts = ref.split(separator: "/", maxSplits: 1).map(String.init)
            var audio: [String: JSON] = ["kinds": .array(kinds.map { .string($0) }), "direction": true, "maxSpeakers": 2]
            if voices { audio["voices"] = [["id": "rachel", "name": "Rachel", "description": "warm, calm, American"], ["id": "george", "name": "George", "description": "deep, British"], ["id": "mia", "name": "Mia", "description": "bright, young"]]; audio["defaultVoice"] = "rachel" }
            if kinds.contains("music") || kinds.contains("sound") { audio["durations"] = ["kind": "range", "min": 3, "max": 120]; audio["defaultSeconds"] = 30 }
            if kinds.contains("music") { audio["lyrics"] = true }
            return ["ref": .string(ref), "providerId": .string(parts[0]), "modelId": .string(parts[1]), "displayName": .string(name), "source": "catalog", "hidden": false, "favorite": false, "order": 1000,
                    "capabilities": ["output": "audio", "audio": .object(audio), "family": "hosted", "promptStyle": "natural", "negativePrompt": false, "sizes": ["kind": "fixed", "list": [["width": 1, "height": 1]]], "maxCount": 1, "edit": false, "mask": false, "maxReferences": 0, "transparent": false, "seed": false, "previews": false, "tunable": false]]
        }
        var list: [JSON] = [
            image("comfyui/sdxl-turbo", "SDXL Turbo", family: "sdxl-distilled", tunable: true, previews: true),
            image("comfyui/flux-dev", "FLUX.1 dev", family: "flux", edit: true, tunable: true, previews: true),
            image("comfyui/workflow:product-shots", "Product shots", family: "sdxl", tunable: false),
            image("openai-images/gpt-image-1", "GPT Image 1", edit: true),
            video,
            sound("elevenlabs/eleven-v3", "Eleven v3", kinds: ["speech"], voices: true),
            sound("elevenlabs/eleven-sfx", "Eleven sound effects", kinds: ["sound"]),
            sound("elevenlabs/eleven-music", "Eleven music", kinds: ["music"]),
        ]
        if world.state == "long" {
            for n in 1...14 { list.append(image("comfyui/checkpoint-with-a-long-file-name-\(n).safetensors", "checkpoint-with-a-long-file-name-\(n)", family: n % 2 == 0 ? "sdxl" : "sd15", tunable: true)) }
        }
        let overrides = world.effective["imageModels"]["overrides"]
        return list.map { json in
            var model = json
            for (key, value) in overrides[json["ref"].string].entries {
                if ["hidden", "favorite", "displayName", "description"].contains(key) { model = model.setting(key, value) }
            }
            return model
        }
    }

    static func respond(_ world: AMDemoWorld, _ method: String, _ params: [String: JSON]) throws -> JSON? {
        switch method {
        case "imageProviders.status": return .array(world.mediaStatuses)
        case "imageModels.list": return .array(models(world))
        case "imageProviders.detect": return .array(world.state == "nodetect" ? [] : [["preset": "kokoro", "type": "openai-speech", "baseUrl": "http://localhost:8880", "label": "Kokoro-FastAPI"], ["preset": "forge", "type": "a1111", "baseUrl": "http://localhost:7860", "label": "Forge"]])
        case "imageProviders.test":
            let id = params["id"]?.string ?? "x"
            if params["baseUrl"]?.string.contains("fail") == true { return ["status": ["providerId": .string(id), "ok": false, "modelCount": 0, "warnings": [], "error": "Could not reach that address. Is the server running, and can this server reach it?", "checkedAt": now()], "models": []] }
            let type = params["type"]?.string ?? ""
            let found: [JSON] = type == "elevenlabs" || type == "openai-speech" ? models(world).filter { $0["capabilities"]["output"].string == "audio" } : models(world).filter { $0["capabilities"]["output"] == .null }.prefix(3).map { $0 }
            return ["status": ["providerId": .string(id), "ok": true, "latencyMs": 38, "modelCount": .number(Double(found.count)), "warnings": [], "checkedAt": now()], "models": .array(found)]
        case "imageProviders.tryImage":
            if world.state == "tryfail" { throw MobileError.message("The server accepted the request but made no picture. The model may still be loading; try again.") }
            return ["blob": .string(String(repeating: "a", count: 64)), "mime": "image/png", "width": 512, "height": 512, "durationMs": 4200]
        case "imageProviders.trySound":
            return ["blob": .string(String(repeating: "b", count: 64)), "mime": "audio/wav", "seconds": 2, "kind": "speech", "text": "Hello from Atelier. This is a test of the voice.", "durationMs": 1800]
        case "imageProviders.save":
            var config: [String: JSON] = [:]
            for key in ["id", "type", "preset", "name", "baseUrl", "headers", "enabled", "parallelRequests", "sharesGpuWith", "freeAfterRun", "models", "workflows"] { if let value = params[key] { config[key] = value } }
            let id = params["id"]?.string ?? ""
            var list = world.effective["imageProviders"].array
            if params["apiKey"] != nil || params["apiKeyFromProvider"] != nil { config["apiKey"] = .string("${secret:provider-\(id)}") }
            else if let existing = list.first(where: { $0["id"].string == id }), existing["apiKey"] != .null { config["apiKey"] = existing["apiKey"] }
            if let index = list.firstIndex(where: { $0["id"].string == id }) { list[index] = .object(config) } else { list.append(.object(config)) }
            world.setSetting(["imageProviders"], .array(list))
            world.mediaStatuses.removeAll { $0["providerId"].string == id }
            world.mediaStatuses.append(["providerId": .string(id), "ok": true, "latencyMs": 22, "modelCount": 2, "warnings": [], "checkedAt": now()])
            return .object(config)
        case "imageProviders.remove":
            let id = params["id"]?.string ?? ""
            world.setSetting(["imageProviders"], .array(world.effective["imageProviders"].array.filter { $0["id"].string != id }))
            world.mediaStatuses.removeAll { $0["providerId"].string == id }
            return ["ok": true]
        case "imageProviders.refresh":
            world.mediaStatuses = world.mediaStatuses.map { status in
                guard params["id"] == nil || status["providerId"] == params["id"] else { return status }
                return status.setting("checkedAt", now())
            }
            return .array(world.mediaStatuses)
        case "imageProviders.parseWorkflow":
            if params["text"]?.string.contains("broken") == true { throw MobileError.message("That isn't a ComfyUI workflow in API format. In ComfyUI, use Save (API) and paste that file.") }
            return workflow.setting("id", "imported-flow").setting("name", "Imported workflow")
        case "imageProviders.savedWorkflows":
            if world.state == "unsupported" { throw MobileError.message("Unknown method imageProviders.savedWorkflows") }
            return [["path": "user/default/workflows/portraits.json", "size": 18_400, "modified": now(86400)], ["path": "user/default/workflows/upscale-4x.json", "size": 9_200, "modified": now(86400 * 6)]]
        default: return nil
        }
    }
}
#endif
