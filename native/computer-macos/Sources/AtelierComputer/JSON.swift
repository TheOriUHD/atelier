import Foundation

/// Any JSON value: request envelopes, ids and params before they are decoded into their types.
public enum JSONValue: Sendable, Equatable {
  case null
  case bool(Bool)
  case int(Int64)
  case double(Double)
  case string(String)
  case array([JSONValue])
  case object([String: JSONValue])

  public subscript(key: String) -> JSONValue? {
    if case .object(let object) = self { return object[key] }
    return nil
  }
}

extension JSONValue: Codable {
  public init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    if c.decodeNil() {
      self = .null
    } else if let value = try? c.decode(Bool.self) {
      self = .bool(value)
    } else if let value = try? c.decode(Int64.self) {
      self = .int(value)
    } else if let value = try? c.decode(Double.self) {
      self = .double(value)
    } else if let value = try? c.decode(String.self) {
      self = .string(value)
    } else if let value = try? c.decode([JSONValue].self) {
      self = .array(value)
    } else if let value = try? c.decode([String: JSONValue].self) {
      self = .object(value)
    } else {
      throw DecodingError.dataCorruptedError(in: c, debugDescription: "not a JSON value")
    }
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.singleValueContainer()
    switch self {
    case .null: try c.encodeNil()
    case .bool(let value): try c.encode(value)
    case .int(let value): try c.encode(value)
    case .double(let value): try c.encode(value)
    case .string(let value): try c.encode(value)
    case .array(let value): try c.encode(value)
    case .object(let value): try c.encode(value)
    }
  }
}

/// A result of any type, for the response envelope.
struct AnyEncodable: Encodable {
  let value: any Encodable

  func encode(to encoder: Encoder) throws {
    try value.encode(to: encoder)
  }
}

enum JSON {
  static func encoder() -> JSONEncoder {
    let encoder = JSONEncoder()
    // Base64 and paths are full of slashes; `\/` is valid JSON but only makes lines longer.
    encoder.outputFormatting = [.withoutEscapingSlashes]
    return encoder
  }

  /// Decodes a request's params into their type; anything that doesn't fit is `InvalidParams`.
  static func decode<T: Decodable>(_ type: T.Type, from params: JSONValue?) throws -> T {
    let value: JSONValue
    switch params {
    case nil, .null?: value = .object([:])
    case .object?: value = params!
    default: throw RPCError.invalidParams("params must be an object")
    }
    do {
      let data = try encoder().encode(value)
      return try JSONDecoder().decode(T.self, from: data)
    } catch let error as DecodingError {
      throw RPCError.invalidParams("invalid params: " + describe(error))
    } catch {
      throw RPCError.invalidParams("invalid params")
    }
  }

  static func describe(_ error: DecodingError) -> String {
    func path(_ keys: [CodingKey]) -> String {
      let joined = keys.map { $0.intValue.map { "[\($0)]" } ?? $0.stringValue }.joined(separator: ".")
      return joined.isEmpty ? "params" : joined
    }
    switch error {
    case .keyNotFound(let key, let context):
      return "missing \(path(context.codingPath + [key]))"
    case .typeMismatch(let type, let context):
      return "\(path(context.codingPath)) must be \(typeName(type))"
    case .valueNotFound(let type, let context):
      return "\(path(context.codingPath)) must be \(typeName(type)), not null"
    case .dataCorrupted(let context):
      return "\(path(context.codingPath)): \(context.debugDescription)"
    @unknown default:
      return "\(error)"
    }
  }

  private static func typeName(_ type: Any.Type) -> String {
    switch type {
    case is String.Type: "a string"
    case is Bool.Type: "a boolean"
    case is Int.Type, is Double.Type, is Int64.Type: "a number"
    case is [String].Type: "an array of strings"
    default: "\(type)"
    }
  }
}
