import Foundation

public struct CompletionRequest: Sendable, Equatable {
	public var model: String
	public var messages: [WireMessage]
	public var tools: [ToolSchema]
	public var stream: Bool
	public var includeUsage: Bool
	public var deadline: Duration

	public static func openRouter(
		messages: [WireMessage],
		tools: [ToolSchema],
		deadline: Duration
	) -> CompletionRequest {
		CompletionRequest(
			model: "deepseek/deepseek-v4-flash",
			messages: messages,
			tools: tools,
			stream: true,
			includeUsage: true,
			deadline: deadline
		)
	}
}

public struct WireMessage: Sendable, Equatable {
	public var role: Role
	public var content: String
	public var toolCalls: [WireToolCall]
	public var toolCallId: String?

	public enum Role: String, Sendable {
		case system
		case user
		case assistant
		case tool
	}
}

public struct WireToolCall: Sendable, Equatable {
	public var id: String
	public var name: ToolName
	public var arguments: String
}

public enum TransportEvent: Sendable, Equatable {
	case textDelta(String)
	case toolCall(WireToolCall)
	case heartbeat
	case finished(reason: FinishReason, usage: Usage)
}

public enum FinishReason: String, Sendable {
	case stop
	case toolCalls = "tool-calls"
	case length
}

public struct Usage: Sendable, Equatable {
	public var inputTokens: Int
	public var outputTokens: Int
	public var cost: Double?
}

public protocol ModelTransport: Sendable {
	func stream(_ request: CompletionRequest) -> AsyncThrowingStream<TransportEvent, Error>
}

public struct ProviderAuthError: Error, Equatable, Sendable {
	public var statusCode: Int
	public var body: String

	public init(statusCode: Int, body: String) {
		self.statusCode = statusCode
		self.body = body
	}
}

public struct UnknownFinishReasonError: Error, Equatable, Sendable {
	public var reason: String

	public init(reason: String) {
		self.reason = reason
	}
}

public struct OpenRouterHTTPError: Error, Equatable, Sendable {
	public var statusCode: Int
	public var body: String

	public init(statusCode: Int, body: String) {
		self.statusCode = statusCode
		self.body = body
	}
}

public struct OpenRouterTransport: ModelTransport {
	private let apiKey: String
	private let baseURL: URL
	private let makeSession: @Sendable (TimeInterval) -> URLSession

	public init(apiKey: String, baseURL: URL = URL(string: "https://openrouter.ai/api/v1")!) {
		self.init(apiKey: apiKey, baseURL: baseURL, makeSession: Self.makeDefaultSession)
	}

	package init(
		apiKey: String,
		baseURL: URL = URL(string: "https://openrouter.ai/api/v1")!,
		makeSession: @escaping @Sendable (TimeInterval) -> URLSession
	) {
		self.apiKey = apiKey
		self.baseURL = baseURL
		self.makeSession = makeSession
	}

	public func stream(_ request: CompletionRequest) -> AsyncThrowingStream<TransportEvent, Error> {
		AsyncThrowingStream { continuation in
			let task = Task {
				let session = makeSession(OpenRouterHTTP.timeInterval(from: request.deadline))
				defer { session.finishTasksAndInvalidate() }
				do {
					let urlRequest = try OpenRouterHTTP.urlRequest(
						apiKey: apiKey,
						baseURL: baseURL,
						request: request
					)
					let (bytes, response) = try await session.bytes(for: urlRequest)
					guard let http = response as? HTTPURLResponse else {
						throw URLError(.badServerResponse)
					}
					if http.statusCode == 401 {
						throw ProviderAuthError(
							statusCode: 401,
							body: try await OpenRouterHTTP.utf8String(from: bytes)
						)
					}
					if http.statusCode != 200 {
						throw OpenRouterHTTPError(
							statusCode: http.statusCode,
							body: try await OpenRouterHTTP.utf8String(from: bytes)
						)
					}
					try await OpenRouterSSEParser.parse(lines: bytes.lines) { event in
						continuation.yield(event)
					}
					continuation.finish()
				} catch {
					continuation.finish(throwing: error)
				}
			}
			continuation.onTermination = { _ in
				task.cancel()
			}
		}
	}

	private static let makeDefaultSession: @Sendable (TimeInterval) -> URLSession = { timeout in
		let configuration = URLSessionConfiguration.ephemeral
		configuration.timeoutIntervalForRequest = timeout
		return URLSession(configuration: configuration)
	}
}

public enum OpenRouterHTTP {
	public static func body(for request: CompletionRequest) -> JSONValue {
		var object: [String: JSONValue] = [
			"model": .string(request.model),
			"messages": .array(request.messages.map(encode(message:))),
			"stream": .bool(request.stream),
			"usage": .object(["include": .bool(request.includeUsage)]),
		]
		if !request.tools.isEmpty {
			object["tools"] = .array(request.tools.map(encode(tool:)))
			object["tool_choice"] = .string("auto")
		}
		return .object(object)
	}

	package static func urlRequest(
		apiKey: String,
		baseURL: URL,
		request: CompletionRequest
	) throws -> URLRequest {
		var urlRequest = URLRequest(url: baseURL.appending(path: "chat/completions"))
		urlRequest.httpMethod = "POST"
		urlRequest.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
		urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
		urlRequest.httpBody = try OpenRouterJSON.data(from: body(for: request))
		return urlRequest
	}

	package static func timeInterval(from duration: Duration) -> TimeInterval {
		let components = duration.components
		return TimeInterval(components.seconds)
			+ TimeInterval(components.attoseconds) / 1_000_000_000_000_000_000
	}

	package static func utf8String(from bytes: URLSession.AsyncBytes) async throws -> String {
		var data = Data()
		for try await byte in bytes {
			data.append(byte)
		}
		return String(decoding: data, as: UTF8.self)
	}

	private static func encode(message: WireMessage) -> JSONValue {
		var object: [String: JSONValue] = [
			"role": .string(message.role.rawValue),
			"content": .string(message.content),
		]
		if !message.toolCalls.isEmpty {
			object["tool_calls"] = .array(message.toolCalls.map(encode(toolCall:)))
		}
		if let toolCallId = message.toolCallId {
			object["tool_call_id"] = .string(toolCallId)
		}
		return .object(object)
	}

	private static func encode(toolCall: WireToolCall) -> JSONValue {
		.object([
			"id": .string(toolCall.id),
			"type": .string("function"),
			"function": .object([
				"name": .string(toolCall.name.rawValue),
				"arguments": .string(toolCall.arguments),
			]),
		])
	}

	private static func encode(tool: ToolSchema) -> JSONValue {
		.object([
			"type": .string("function"),
			"function": .object([
				"name": .string(tool.name.rawValue),
				"description": .string(tool.description),
				"parameters": tool.parameters,
			]),
		])
	}
}

package enum OpenRouterJSON {
	package static func data(from value: JSONValue) throws -> Data {
		try JSONSerialization.data(withJSONObject: jsonObject(from: value))
	}

	package static func jsonObject(from value: JSONValue) -> Any {
		switch value {
		case .null:
			return NSNull()
		case .bool(let value):
			return value
		case .number(let value):
			return value
		case .string(let value):
			return value
		case .array(let values):
			return values.map(jsonObject(from:))
		case .object(let values):
			return values.mapValues(jsonObject(from:))
		}
	}
}
