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

public struct OpenRouterTransport: ModelTransport {
	public init(apiKey: String, baseURL: URL = URL(string: "https://openrouter.ai/api/v1")!) {
		fatalError("not implemented")
	}

	public func stream(_ request: CompletionRequest) -> AsyncThrowingStream<TransportEvent, Error> {
		fatalError("not implemented")
	}
}

public enum OpenRouterHTTP {
	public static func body(for request: CompletionRequest) -> JSONValue {
		fatalError("not implemented")
	}
}
