import Foundation

package enum OpenRouterSSEParser {
	package static func events(from text: String) -> AsyncThrowingStream<TransportEvent, Error> {
		AsyncThrowingStream { continuation in
			do {
				var state = ParseState()
				for line in splitLines(text) {
					for event in try state.consume(line: line) {
						continuation.yield(event)
					}
					if state.isComplete {
						break
					}
				}
				if !state.isComplete {
					for event in try state.finish() {
						continuation.yield(event)
					}
				}
				continuation.finish()
			} catch {
				continuation.finish(throwing: error)
			}
		}
	}

	package static func parse<S: AsyncSequence>(
		lines: S,
		yield: @Sendable (TransportEvent) -> Void
	) async throws where S.Element == String {
		var state = ParseState()
		for try await line in lines {
			try Task.checkCancellation()
			for event in try state.consume(line: line) {
				yield(event)
			}
			if state.isComplete {
				return
			}
		}
		if !state.isComplete {
			for event in try state.finish() {
				yield(event)
			}
		}
	}
}

private func splitLines(_ text: String) -> [String] {
	text.split(separator: "\n", omittingEmptySubsequences: false).map { line in
		if line.last == "\r" {
			return String(line.dropLast())
		}
		return String(line)
	}
}

private struct ParseState {
	private var partials: [Int: PartialToolCall] = [:]
	private var lastFinishReason: String?
	private var usageSteps: [UsageStep] = []
	private var finished = false
	var isComplete: Bool { finished }

	mutating func consume(line: String) throws -> [TransportEvent] {
		if line.isEmpty {
			return []
		}
		if line.hasPrefix(":") {
			return [.heartbeat]
		}
		guard line.hasPrefix("data:") else {
			return []
		}
		var payload = String(line.dropFirst(5))
		if payload.first == " " {
			payload.removeFirst()
		}
		if payload == "[DONE]" {
			return try finish()
		}
		if payload.isEmpty {
			return []
		}
		return try consume(json: payload)
	}

	mutating func finish() throws -> [TransportEvent] {
		if finished {
			return []
		}
		finished = true
		var events = try emitToolCalls()
		switch lastFinishReason {
		case "stop":
			events.append(.finished(reason: .stop, usage: summedUsage()))
		case "tool_calls", "tool-calls":
			events.append(.finished(reason: .toolCalls, usage: summedUsage()))
		case "length":
			events.append(.finished(reason: .length, usage: summedUsage()))
		case let value?:
			throw UnknownFinishReasonError(reason: value)
		case nil:
			throw UnknownFinishReasonError(reason: "")
		}
		return events
	}

	private mutating func consume(json payload: String) throws -> [TransportEvent] {
		guard let data = payload.data(using: .utf8) else {
			throw OpenRouterParseError.malformedSSE
		}
		let raw: Any
		do {
			raw = try JSONSerialization.jsonObject(with: data)
		} catch {
			throw OpenRouterParseError.malformedSSE
		}
		guard let object = raw as? [String: Any] else {
			throw OpenRouterParseError.malformedSSE
		}
		if let usage = object["usage"] as? [String: Any] {
			usageSteps.append(UsageStep(usage))
		}
		guard let choices = object["choices"] as? [Any],
			let choice = choices.first as? [String: Any]
		else {
			return [.heartbeat]
		}
		if let reason = choice["finish_reason"] as? String {
			lastFinishReason = reason
		}
		let delta = choice["delta"] as? [String: Any] ?? [:]
		var events: [TransportEvent] = []
		var emitted = false
		if let content = delta["content"] as? String, !content.isEmpty {
			events.append(.textDelta(content))
			emitted = true
		}
		if let toolCalls = delta["tool_calls"] as? [Any], !toolCalls.isEmpty {
			try merge(toolCalls: toolCalls)
			events.append(.heartbeat)
			emitted = true
		}
		if !emitted {
			events.append(.heartbeat)
		}
		return events
	}

	private mutating func merge(toolCalls: [Any]) throws {
		for item in toolCalls {
			guard let fragment = item as? [String: Any] else {
				throw OpenRouterParseError.malformedSSE
			}
			let index = intValue(fragment["index"]) ?? 0
			var partial = partials[index] ?? PartialToolCall()
			if let id = fragment["id"] as? String, !id.isEmpty {
				partial.id = id
			}
			if let function = fragment["function"] as? [String: Any] {
				if let name = function["name"] as? String, !name.isEmpty {
					partial.name = name
				}
				if let arguments = function["arguments"] as? String {
					partial.arguments += arguments
				}
			}
			partials[index] = partial
		}
	}

	private mutating func emitToolCalls() throws -> [TransportEvent] {
		let ordered = partials.keys.sorted().compactMap { partials[$0] }
		partials.removeAll()
		return try ordered.map { partial in
			guard let name = ToolName(rawValue: partial.name) else {
				throw OpenRouterParseError.unknownTool(partial.name)
			}
			return .toolCall(
				WireToolCall(
					id: partial.id,
					name: name,
					arguments: partial.arguments
				)
			)
		}
	}

	private func summedUsage() -> Usage {
		let input = usageSteps.reduce(0) { $0 + $1.inputTokens }
		let output = usageSteps.reduce(0) { $0 + $1.outputTokens }
		let costs = usageSteps.map(\.cost)
		let cost: Double?
		if !usageSteps.isEmpty, costs.allSatisfy({ $0 != nil }) {
			cost = costs.compactMap { $0 }.reduce(0, +)
		} else {
			cost = nil
		}
		return Usage(inputTokens: input, outputTokens: output, cost: cost)
	}
}

private struct PartialToolCall {
	var id = ""
	var name = ""
	var arguments = ""
}

private struct UsageStep {
	var inputTokens: Int
	var outputTokens: Int
	var cost: Double?

	init(_ usage: [String: Any]) {
		inputTokens = intValue(usage["prompt_tokens"]) ?? 0
		outputTokens = intValue(usage["completion_tokens"]) ?? 0
		if let number = usage["cost"] as? NSNumber,
			CFGetTypeID(number) != CFBooleanGetTypeID()
		{
			let value = number.doubleValue
			cost = value.isFinite && value >= 0 ? value : nil
		} else {
			cost = nil
		}
	}
}

private func intValue(_ raw: Any?) -> Int? {
	if let value = raw as? Int {
		return value
	}
	if let value = raw as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID() {
		return value.intValue
	}
	return nil
}

package enum OpenRouterParseError: Error, Equatable, Sendable {
	case malformedSSE
	case unknownTool(String)
}
