import Foundation

/// What the server asks of the models on the phone: the two calls of an OpenAI-compatible server (`GET /models` and
/// `POST /chat/completions`), answered here instead of over a network. The server treats the phone like any other model
/// server on one of the person's computers: it reaches it through the device link and the answer comes back the same way.
enum OnDeviceAPI {
    enum Event: Sendable {
        case head(status: Int, headers: [String: String])
        case body(Data)
    }

    /// The request as the device link carries it.
    struct Request: Sendable {
        let method: String
        let url: URL
        let body: Data?
    }

    @MainActor static func respond(to request: Request) -> AsyncThrowingStream<Event, Error> {
        AsyncThrowingStream { continuation in
            let path = request.url.path
            if request.method == "GET", path.hasSuffix("/models") {
                continuation.yield(.head(status: 200, headers: ["content-type": "application/json"]))
                continuation.yield(.body(modelList()))
                continuation.finish()
            } else if request.method == "POST", path.hasSuffix("/chat/completions") {
                guard let body = request.body, let json = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any], let chat = chatRequest(json) else {
                    fail(continuation, status: 400, message: "That request could not be read.", code: "invalid_request")
                    return
                }
                let streaming = (json["stream"] as? Bool) ?? false
                let task = Task { @MainActor in await complete(chat, streaming: streaming, into: continuation) }
                continuation.onTermination = { _ in task.cancel() }
            } else {
                fail(continuation, status: 404, message: "Nothing here: this iPhone answers /models and /chat/completions.", code: "not_found")
            }
        }
    }

    // MARK: the model list

    @MainActor private static func modelList() -> Data {
        let data: [[String: Any]] = LocalModelStore.shared.installed.map { spec in
            [
                "id": spec.id, "object": "model", "name": "\(spec.name)", "owned_by": spec.maker,
                // What the server needs to plan with: how much it holds, that it takes text only, and no tool calling.
                "context_length": spec.context,
                "architecture": ["input_modalities": ["text"], "output_modalities": ["text"]],
                "supported_parameters": ["temperature", "top_p", "max_tokens", "stop"],
                "top_provider": ["context_length": spec.context, "max_completion_tokens": min(8192, spec.context / 2)],
            ]
        }
        return (try? JSONSerialization.data(withJSONObject: ["object": "list", "data": data])) ?? Data("{\"data\":[]}".utf8)
    }

    // MARK: a chat completion

    private static func chatRequest(_ json: [String: Any]) -> LocalChatRequest? {
        guard let model = json["model"] as? String, let messages = json["messages"] as? [[String: Any]] else { return nil }
        let turns: [LocalChatRequest.Turn] = messages.compactMap { message in
            guard let role = message["role"] as? String else { return nil }
            let text: String
            if let plain = message["content"] as? String { text = plain }
            else if let parts = message["content"] as? [[String: Any]] { text = parts.compactMap { $0["type"] as? String == "text" ? $0["text"] as? String : nil }.joined(separator: "\n") }
            else { text = "" }
            // A tool's result or a developer's note reads as a user's words to a model with no tools.
            let mapped = role == "developer" ? "system" : (role == "tool" ? "user" : role)
            return text.isEmpty && mapped != "assistant" ? nil : LocalChatRequest.Turn(role: mapped, text: text)
        }
        let stop: [String] = (json["stop"] as? [String]) ?? (json["stop"] as? String).map { [$0] } ?? []
        return LocalChatRequest(
            model: model, turns: turns,
            maxTokens: (json["max_completion_tokens"] as? Int) ?? (json["max_tokens"] as? Int),
            temperature: (json["temperature"] as? Double).map(Float.init),
            topP: (json["top_p"] as? Double).map(Float.init),
            stop: stop
        )
    }

    @MainActor private static func complete(_ chat: LocalChatRequest, streaming: Bool, into continuation: AsyncThrowingStream<Event, Error>.Continuation) async {
        let id = "chatcmpl-" + UUID().uuidString.prefix(12).lowercased()
        let created = Int(Date().timeIntervalSince1970)
        func chunk(_ delta: [String: Any], finish: String? = nil, usage: [String: Any]? = nil) -> Data {
            var object: [String: Any] = ["id": id, "object": "chat.completion.chunk", "created": created, "model": chat.model]
            object["choices"] = usage == nil ? [["index": 0, "delta": delta, "finish_reason": finish as Any? ?? NSNull()]] : []
            if let usage { object["usage"] = usage }
            let json = (try? JSONSerialization.data(withJSONObject: object)) ?? Data()
            return Data("data: ".utf8) + json + Data("\n\n".utf8)
        }
        do {
            if streaming {
                continuation.yield(.head(status: 200, headers: ["content-type": "text/event-stream", "cache-control": "no-cache"]))
                continuation.yield(.body(chunk(["role": "assistant", "content": ""])))
            }
            var text = "", thinking = ""
            var finish = "stop", prompt = 0, generated = 0
            for try await piece in LocalEngine.shared.generate(chat) {
                switch piece {
                case .text(let words):
                    text += words
                    if streaming { continuation.yield(.body(chunk(["content": words]))) }
                case .thinking(let words):
                    thinking += words
                    if streaming { continuation.yield(.body(chunk(["reasoning_content": words]))) }
                case .done(let promptTokens, let generatedTokens, let reason):
                    prompt = promptTokens; generated = generatedTokens; finish = reason
                }
            }
            let usage: [String: Any] = ["prompt_tokens": prompt, "completion_tokens": generated, "total_tokens": prompt + generated]
            if streaming {
                continuation.yield(.body(chunk([:], finish: finish)))
                continuation.yield(.body(chunk([:], usage: usage)))
                continuation.yield(.body(Data("data: [DONE]\n\n".utf8)))
            } else {
                var message: [String: Any] = ["role": "assistant", "content": text]
                if !thinking.isEmpty { message["reasoning_content"] = thinking }
                let object: [String: Any] = ["id": id, "object": "chat.completion", "created": created, "model": chat.model, "choices": [["index": 0, "message": message, "finish_reason": finish]], "usage": usage]
                continuation.yield(.head(status: 200, headers: ["content-type": "application/json"]))
                continuation.yield(.body((try? JSONSerialization.data(withJSONObject: object)) ?? Data()))
            }
            continuation.finish()
        } catch is CancellationError {
            continuation.finish()
        } catch {
            if streaming {
                // The answer began: the error goes in the stream, where the server reads it.
                let object: [String: Any] = ["error": ["message": error.localizedDescription, "type": "server_error"]]
                continuation.yield(.body(Data("data: ".utf8) + ((try? JSONSerialization.data(withJSONObject: object)) ?? Data()) + Data("\n\n".utf8)))
                continuation.finish()
            } else {
                fail(continuation, status: 500, message: error.localizedDescription, code: "server_error")
            }
        }
    }

    private static func fail(_ continuation: AsyncThrowingStream<Event, Error>.Continuation, status: Int, message: String, code: String) {
        let body: [String: Any] = ["error": ["message": message, "type": "invalid_request_error", "code": code]]
        continuation.yield(.head(status: status, headers: ["content-type": "application/json"]))
        continuation.yield(.body((try? JSONSerialization.data(withJSONObject: body)) ?? Data()))
        continuation.finish()
    }
}
