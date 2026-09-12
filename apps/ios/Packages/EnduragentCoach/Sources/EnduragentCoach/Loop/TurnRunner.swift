import Foundation

package struct TurnState: Sendable, Equatable {
	package var chatId: ChatID
	package var messages: [ChatMessage]
	package var windowStart: ULID?
	package var pending: ProposalBody?
	package var writesCommitted: Int
	package var flushedThisTurn: Bool
	package var lastFlushMessageCount: Int
	package var steps: Int
}

public enum TurnPolicy {
	public static let maxSteps = 10
	public static let maxGenerateCalls = 40
	public static let maxAttempts = 4
	public static let wallClock: Duration = .seconds(10 * 60)
	public static let chatCallDeadline: Duration = .seconds(600)
	public static let compactionTimeout: Duration = .seconds(120)
	public static let toolResultTokenCap = 24_000
	public static let athleteContextChars = 20_000
	public static let historyBudgetFloor = 8_000
	public static let historyTokenBudgetRatio = 0.3
	public static let contextWindowCap = 200_000
	public static let overflowRetries = 3
	public static let dailyResetHour = 4
	public static let dailyResetGrace: Duration = .seconds(30 * 60)
	public static let proposalTTL: Duration = .seconds(10 * 60)
	public static let ungatedPrefixTokenCeiling = 13_200
	public static let gatedPrefixTokenCeiling = 13_600
}

public struct TurnBudgetExceeded: Error, Equatable, Sendable {
	public var kind: Kind

	public enum Kind: Sendable, Equatable {
		case generateCalls
		case generateAttempts
		case wallClock
	}
}

public struct TurnBudget: Sendable {
	public var generatesRemaining: Int
	public var attemptsRemaining: Int
	public var deadline: ContinuousClock.Instant

	public static func start(clock: ContinuousClock = ContinuousClock()) -> TurnBudget {
		TurnBudget(
			generatesRemaining: TurnPolicy.maxGenerateCalls,
			attemptsRemaining: TurnPolicy.maxAttempts,
			deadline: clock.now.advanced(by: TurnPolicy.wallClock)
		)
	}

	public mutating func chargeGenerate() throws {
		guard generatesRemaining > 0 else {
			throw TurnBudgetExceeded(kind: .generateCalls)
		}
		generatesRemaining -= 1
	}

	public mutating func chargeAttempt() throws {
		guard attemptsRemaining > 0 else {
			throw TurnBudgetExceeded(kind: .generateAttempts)
		}
		attemptsRemaining -= 1
	}

	public func remaining(until now: ContinuousClock.Instant) -> Duration {
		now < deadline ? deadline - now : .zero
	}

	public func checkDeadline(now: ContinuousClock.Instant = ContinuousClock().now) throws {
		if now >= deadline {
			throw TurnBudgetExceeded(kind: .wallClock)
		}
	}
}

package struct TurnRunner: Sendable {
	private let transport: any ModelTransport
	private let intervals: any IntervalsClient
	private let store: any RecordLog
	private let clock: any Clock
	private let tools: ToolRuntime
	private let planning: Planning

	package init(
		transport: any ModelTransport,
		intervals: any IntervalsClient,
		store: any RecordLog,
		clock: any Clock,
		tools: ToolRuntime,
		planning: Planning
	) {
		self.transport = transport
		self.intervals = intervals
		self.store = store
		self.clock = clock
		self.tools = tools
		self.planning = planning
	}

	package func run(
		text: String,
		chatId: ChatID,
		language: LanguagePreference,
		emit: @escaping @Sendable (CoachEvent) -> Void
	) async throws {
		_ = planning
		let slash = SlashRouting.parse(text)
		if slash == .plan {
			emit(.finished)
			return
		}
		if slash == .language {
			emit(.languagePicker)
			emit(.finished)
			return
		}

		await tools.beginTurn()
		var writer = RecordWriter(store: store, clock: clock)
		try await writer.refreshClock()

		var transcript = try await loadTranscript(chatId: chatId)
		if shouldDailyReset(last: transcript.lastDate) {
			try await writer.append(
				.flushPending(FlushPendingBody(chatId: chatId, trigger: .staleReset, messageUlids: transcript.ulids))
			)
			let marker = ULID.generate(at: clock.now)
			try await writer.append(
				.windowStart(WindowStartBody(chatId: chatId, firstIncludedUlid: marker))
			)
			transcript = Transcript(messages: [], ulids: [], lastDate: nil, windowStart: marker)
		}

		let memory = Memory(store: store, clock: clock)
		let context = (try? await memory.context()) ?? ""
		let view = (try? await memory.view()) ?? MemoryView(
			sections: [:],
			todayNotes: nil,
			planHeadline: nil,
			orphanNames: []
		)
		let schemas = tools.toolsForTurn(chatId: chatId, memory: view)
		let prefix = PromptAssembly.cyclingPrefix(gated: true)
		let snapshot = await loadSnapshot()
		let resolution = LanguageResolution(
			language: language.coachReply ?? language.ui,
			source: language.coachReply == nil ? .surface : .preference,
			locale: language.ui.rawValue
		)
		let replyLanguage = PromptAssembly.replyLanguageSection(resolution: resolution)
		let volatile = PromptAssembly.volatile(
			context: context,
			snapshot: snapshot,
			timeZoneName: clock.timeZone.identifier,
			replyLanguage: replyLanguage
		)
		let system = prefix + "\n\n" + volatile
		let systemTokens = estimateTokens(system)
		let trim = HistoryWindow.trim(messages: transcript.messages, systemTokens: systemTokens)
		if !trim.dropped.isEmpty {
			if let first = trim.kept.first, let ulid = transcript.ulid(for: first) {
				try await writer.append(
					.windowStart(WindowStartBody(chatId: chatId, firstIncludedUlid: ulid))
				)
			}
			try await writer.append(
				.compactionSummary(CompactionSummaryBody(chatId: chatId, markdown: compactionStub(trim.dropped)))
			)
			try? await memory.flush(trigger: .trim, chatId: chatId, transport: transport)
		}
		let kept = trim.kept
		let historyTokens = kept.reduce(0) { $0 + estimateTokens($1.text) }
		let shouldFlush = HistoryWindow.shouldSoftFlush(
			historyTokens: historyTokens,
			budget: trim.budget,
			messagesSinceFlush: kept.count
		)

		let timed = PromptAssembly.appendCurrentTime(
			athleteText: text,
			now: clock.now,
			timeZone: clock.timeZone
		)
		var wire = kept.map(wireMessage(from:))
		wire.append(WireMessage(role: .user, content: timed, toolCalls: [], toolCallId: nil))

		var state = TurnState(
			chatId: chatId,
			messages: kept,
			windowStart: transcript.windowStart,
			pending: nil,
			writesCommitted: 0,
			flushedThisTurn: false,
			lastFlushMessageCount: 0,
			steps: 0
		)

		var budget = TurnBudget.start()
		var streamed = ""
		var overflowTries = 0
		var pendingProposal: PendingProposal?

		attemptLoop: while true {
			try Task.checkCancellation()
			try budget.chargeAttempt()
			try budget.checkDeadline()

			if let remaining = clock.backgroundRemaining, remaining < ChatWatchdog.ttft {
				try await writer.append(
					.flushPending(
						FlushPendingBody(chatId: chatId, trigger: .softThreshold, messageUlids: transcript.ulids)
					)
				)
				emit(.interrupted(text: streamed))
				return
			}

			if shouldCompact(wire: wire, system: system) {
				if overflowTries >= TurnPolicy.overflowRetries {
					throw TurnFailure(message: PromptStaticBlocks.compactionFailureCopy)
				}
				try await compact(wire: &wire, budget: &budget, chatId: chatId, writer: &writer)
				overflowTries += 1
			}

			streamed = ""
			pendingProposal = nil
			state.steps = 0
			var lastText = ""
			var lastReason: FinishReason = .stop
			var lastUsage = Usage(inputTokens: 0, outputTokens: 0, cost: nil)

			stepLoop: while state.steps < TurnPolicy.maxSteps {
				try Task.checkCancellation()
				if let remaining = clock.backgroundRemaining, remaining < ChatWatchdog.ttft {
					try await writer.append(
						.flushPending(
							FlushPendingBody(chatId: chatId, trigger: .softThreshold, messageUlids: transcript.ulids)
						)
					)
					emit(.interrupted(text: streamed))
					return
				}

				try budget.chargeGenerate()
				let deadline = minDuration(
					TurnPolicy.chatCallDeadline,
					budget.remaining(until: ContinuousClock().now)
				)
				var messages = [WireMessage(role: .system, content: system, toolCalls: [], toolCallId: nil)]
				messages.append(contentsOf: wire)
				let request = CompletionRequest.openRouter(
					messages: messages,
					tools: schemas,
					deadline: deadline
				)
				let step: GenerateStep
				do {
					step = try await generateStep(request: request, emit: emit, streamed: &streamed)
				} catch let timeout as WatchdogTimeout {
					emit(.failed(message: timeout == .ttft ? "CHAT_TTFT_TIMEOUT" : "CHAT_INTER_CHUNK_TIMEOUT"))
					return
				}

				state.steps += 1
				lastText = step.text
				lastReason = step.reason
				lastUsage = step.usage

				if step.reason == .length, step.usage.inputTokens >= TurnPolicy.contextWindowCap {
					if overflowTries >= TurnPolicy.overflowRetries {
						throw TurnFailure(message: PromptStaticBlocks.compactionFailureCopy)
					}
					overflowTries += 1
					try await compact(wire: &wire, budget: &budget, chatId: chatId, writer: &writer)
					continue attemptLoop
				}

				if step.toolCalls.isEmpty {
					break stepLoop
				}

				let ids = Set(step.toolCalls.map(\.id))
				let watchdogPause = ChatWatchdog()
				await watchdogPause.pauseForTools(ids)
				wire.append(
					WireMessage(role: .assistant, content: step.text, toolCalls: step.toolCalls, toolCallId: nil)
				)

				let outcomes = try await runTools(step.toolCalls, chatId: chatId, state: state, emit: emit)
				for (call, outcome) in outcomes {
					if case .pending(let proposal) = outcome {
						pendingProposal = proposal
						emit(.proposalPending(proposal))
					}
					wire.append(
						WireMessage(
							role: .tool,
							content: encodeToolOutcome(outcome),
							toolCalls: [],
							toolCallId: call.id
						)
					)
				}
				await watchdogPause.pauseForTools([])
				await watchdogPause.disarm()

				if state.steps == TurnPolicy.maxSteps {
					break stepLoop
				}
			}

			var assistantText = lastText
			if assistantText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
			   lastReason == .toolCalls || lastReason == .length
			{
				try budget.chargeGenerate()
				let recovery = try await generateStep(
					request: CompletionRequest.openRouter(
						messages: [
							WireMessage(role: .system, content: system, toolCalls: [], toolCallId: nil),
						] + wire + [
							WireMessage(
								role: .user,
								content: PromptStaticBlocks.recoveryPrompt,
								toolCalls: [],
								toolCallId: nil
							),
						],
						tools: [],
						deadline: minDuration(
							TurnPolicy.chatCallDeadline,
							budget.remaining(until: ContinuousClock().now)
						)
					),
					emit: emit,
					streamed: &streamed
				)
				assistantText = recovery.text
			}
			if assistantText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
				assistantText = PromptStaticBlocks.stepLimitCopy
				emit(.textDelta(assistantText))
			}

			if !assistantText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
				let templateHash = sha256Hex(prefix + schemas.map(\.name.rawValue).joined() + "deepseek/deepseek-v4-flash")
				let assembledHash = sha256Hex(system + timed + assistantText)
				try await writer.append(
					.userMessage(
						UserMessageBody(chatId: chatId, athleteText: text, timedText: timed, slash: slash)
					)
				)
				try await writer.append(
					.assistantMessage(
						AssistantMessageBody(
							chatId: chatId,
							text: assistantText,
							templateHash: templateHash,
							assembledHash: assembledHash
						)
					)
				)
			}

			if shouldFlush {
				try await writer.append(
					.flushPending(FlushPendingBody(chatId: chatId, trigger: .softThreshold, messageUlids: transcript.ulids))
				)
			}

			_ = lastUsage
			_ = pendingProposal
			emit(.finished)
			return
		}
	}

	private func generateStep(
		request: CompletionRequest,
		emit: @escaping @Sendable (CoachEvent) -> Void,
		streamed: inout String
	) async throws -> GenerateStep {
		let watchdog = ChatWatchdog()
		await watchdog.arm()
		do {
			let step = try await withThrowingTaskGroup(of: GenerateStep.self) { group in
				group.addTask {
					try await self.collect(request: request, watchdog: watchdog, emit: emit)
				}
				group.addTask {
					if let kind = await watchdog.fired() {
						throw kind
					}
					throw CancellationError()
				}
				guard let first = await group.nextResult() else {
					throw CancellationError()
				}
				await watchdog.disarm()
				group.cancelAll()
				while await group.nextResult() != nil {}
				switch first {
				case .success(let step):
					return step
				case .failure(let error):
					throw error
				}
			}
			streamed += step.text
			return step
		} catch {
			await watchdog.disarm()
			throw error
		}
	}

	private func collect(
		request: CompletionRequest,
		watchdog: ChatWatchdog,
		emit: @escaping @Sendable (CoachEvent) -> Void
	) async throws -> GenerateStep {
		var text = ""
		var calls: [WireToolCall] = []
		var reason: FinishReason = .stop
		var usage = Usage(inputTokens: 0, outputTokens: 0, cost: nil)
		var finished = false
		let stream = transport.stream(request)
		for try await event in stream {
			try Task.checkCancellation()
			switch event {
			case .textDelta(let delta):
				if delta.isEmpty {
					continue
				}
				await watchdog.beat()
				text += delta
				emit(.textDelta(delta))
			case .toolCall(let call):
				calls.append(call)
			case .heartbeat:
				break
			case .finished(let finishReason, let finishUsage):
				reason = finishReason
				usage = finishUsage
				finished = true
			}
		}
		_ = finished
		return GenerateStep(text: text, toolCalls: calls, reason: reason, usage: usage)
	}

	private func runTools(
		_ calls: [WireToolCall],
		chatId: ChatID,
		state: TurnState,
		emit: @escaping @Sendable (CoachEvent) -> Void
	) async throws -> [(WireToolCall, ToolOutcome)] {
		try await withThrowingTaskGroup(of: (Int, WireToolCall, ToolOutcome).self) { group in
			for (index, call) in calls.enumerated() {
				group.addTask {
					emit(.toolStarted(name: call.name.rawValue, callId: call.id))
					let arguments = (try? JSONValue.parse(call.arguments)) ?? .string(call.arguments)
					let outcome = try await self.tools.execute(
						name: call.name,
						arguments: arguments,
						chatId: chatId,
						state: state
					)
					emit(.toolFinished(name: call.name.rawValue, callId: call.id))
					return (index, call, outcome)
				}
			}
			var rows: [(Int, WireToolCall, ToolOutcome)] = []
			for try await row in group {
				rows.append(row)
			}
			return rows.sorted { $0.0 < $1.0 }.map { ($0.1, $0.2) }
		}
	}

	private func compact(
		wire: inout [WireMessage],
		budget: inout TurnBudget,
		chatId: ChatID,
		writer: inout RecordWriter
	) async throws {
		try budget.chargeGenerate()
		let keep = Array(wire.suffix(4))
		let dropped = Array(wire.dropLast(min(4, wire.count)))
		let request = CompletionRequest.openRouter(
			messages: [
				WireMessage(
					role: .system,
					content: "Summarize the conversation. Required headings: ## Athlete Profile, ## Training Status, ## Coach Stance, ## Discussion Context, ## Pending Questions.",
					toolCalls: [],
					toolCallId: nil
				),
				WireMessage(
					role: .user,
					content: dropped.map(\.content).joined(separator: "\n"),
					toolCalls: [],
					toolCallId: nil
				),
			],
			tools: [],
			deadline: TurnPolicy.compactionTimeout
		)
		var unused = ""
		let summary: String
		do {
			summary = try await generateStep(request: request, emit: { _ in }, streamed: &unused).text
		} catch {
			summary = compactionStub(dropped.map { ChatMessage(role: .user, text: $0.content, civilDate: nil) })
		}
		if let first = keep.first {
			try await writer.append(
				.windowStart(
					WindowStartBody(
						chatId: chatId,
						firstIncludedUlid: ULID.generate(at: clock.now)
					)
				)
			)
			_ = first
		}
		try await writer.append(
			.compactionSummary(CompactionSummaryBody(chatId: chatId, markdown: summary))
		)
		var next: [WireMessage] = [
			WireMessage(
				role: .system,
				content: "[Previous conversation summary]\n\(summary)",
				toolCalls: [],
				toolCallId: nil
			),
		]
		next.append(contentsOf: keep)
		wire = next
	}

	private func loadSnapshot() async -> AthleteSnapshot? {
		let today = IntervalsPolicy.today(now: clock.now, timeZone: clock.timeZone)
		let oldest = today.adding(days: -(7 - 1))
		guard let days = try? await intervals.fetchWellness(oldest: oldest, newest: today) else {
			return nil
		}
		guard let latest = days.last else {
			return nil
		}
		return AthleteSnapshot(fitness: latest.fitness, fatigue: latest.fatigue, form: latest.form)
	}

	private func loadTranscript(chatId: ChatID) async throws -> Transcript {
		let records = try await store.fetch(
			RecordQuery(kinds: [.userMessage, .assistantMessage, .windowStart, .compactionSummary], chatId: chatId)
		)
		let ordered = records.sorted { $0.hlc < $1.hlc }
		let start = ordered.reversed().compactMap { record -> ULID? in
			if case .windowStart(let body) = record.body { return body.firstIncludedUlid }
			return nil
		}.first
		var messages: [ChatMessage] = []
		var ulids: [ULID] = []
		var lastDate: Date?
		for record in ordered {
			if let start, record.ulid.rawValue < start.rawValue {
				continue
			}
			switch record.body {
			case .userMessage(let body):
				messages.append(ChatMessage(role: .user, text: body.athleteText, civilDate: record.civilDate))
				ulids.append(record.ulid)
				lastDate = Date(timeIntervalSince1970: Double(record.hlc.wallMs) / 1000)
			case .assistantMessage(let body):
				messages.append(ChatMessage(role: .assistant, text: body.text, civilDate: record.civilDate))
				ulids.append(record.ulid)
				lastDate = Date(timeIntervalSince1970: Double(record.hlc.wallMs) / 1000)
			default:
				break
			}
		}
		return Transcript(messages: messages, ulids: ulids, lastDate: lastDate, windowStart: start)
	}

	private func shouldDailyReset(last: Date?) -> Bool {
		guard let last else { return false }
		let resetAt = dailyResetDate(now: clock.now, timeZone: clock.timeZone, hour: TurnPolicy.dailyResetHour)
		guard last < resetAt else { return false }
		let grace = durationSeconds(TurnPolicy.dailyResetGrace)
		if clock.now.timeIntervalSince(last) < grace {
			return false
		}
		return true
	}
}

private struct GenerateStep: Sendable {
	var text: String
	var toolCalls: [WireToolCall]
	var reason: FinishReason
	var usage: Usage
}

private struct Transcript: Sendable {
	var messages: [ChatMessage]
	var ulids: [ULID]
	var lastDate: Date?
	var windowStart: ULID?

	func ulid(for message: ChatMessage) -> ULID? {
		guard let index = messages.firstIndex(of: message) else { return nil }
		return ulids[index]
	}
}

private struct TurnFailure: Error {
	var message: String
}

private struct RecordWriter {
	let store: any RecordLog
	let clock: any Clock
	var lastHLC: HybridLogicalClock?

	mutating func refreshClock() async throws {
		let synced = try await store.fetch(
			RecordQuery(kinds: [
				.userMessage, .assistantMessage, .windowStart, .compactionSummary, .coachReplyLanguage,
			])
		)
		let local = try await store.fetch(
			RecordQuery(
				kinds: [.flushPending, .pendingProposal, .proposalCleared],
				deviceLocalOnly: true
			)
		)
		lastHLC = (synced + local).map(\.hlc).max()
	}

	mutating func append(_ body: RecordBody) async throws {
		let tz = IANATimeZone(identifier: clock.timeZone.identifier) ?? IANATimeZone(identifier: "GMT")!
		let record = AthleteRecord(
			ulid: ULID.generate(at: clock.now),
			deviceId: store.deviceId,
			hlc: .tick(now: clock.now, deviceId: store.deviceId, last: lastHLC),
			timeZone: tz,
			civilDate: IntervalsPolicy.today(now: clock.now, timeZone: clock.timeZone),
			body: body
		)
		lastHLC = record.hlc
		try await store.append(record)
	}
}

private func wireMessage(from message: ChatMessage) -> WireMessage {
	WireMessage(
		role: message.role == .user ? .user : .assistant,
		content: message.text,
		toolCalls: [],
		toolCallId: nil
	)
}

private func encodeToolOutcome(_ outcome: ToolOutcome) -> String {
	switch outcome {
	case .result(let json):
		return json.canonicalDigestInput()
	case .pending(let proposal):
		return JSONValue.object([
			"pendingConfirmation": .bool(true),
			"summary": .string(proposal.summary),
		]).canonicalDigestInput()
	case .truncated(let notice, let tokens):
		return JSONValue.object([
			"truncated": .bool(true),
			"notice": .string(notice),
			"omittedSamples": .number(0),
			"estimatedTokens": .number(Double(tokens)),
		]).canonicalDigestInput()
	}
}

private func compactionStub(_ dropped: [ChatMessage]) -> String {
	"""
	## Athlete Profile
	## Training Status
	## Coach Stance
	## Discussion Context
	\(dropped.map(\.text).joined(separator: "\n"))
	## Pending Questions
	"""
}

private func shouldCompact(wire: [WireMessage], system: String) -> Bool {
	let estimated = wire.reduce(0) { $0 + estimateTokens($1.content) } + estimateTokens(system)
	let budget = TurnPolicy.contextWindowCap - 20_000
	return estimated > budget
}

private func minDuration(_ lhs: Duration, _ rhs: Duration) -> Duration {
	lhs < rhs ? lhs : rhs
}

private func durationSeconds(_ duration: Duration) -> TimeInterval {
	let components = duration.components
	return TimeInterval(components.seconds)
		+ TimeInterval(components.attoseconds) / 1_000_000_000_000_000_000
}

private func dailyResetDate(now: Date, timeZone: TimeZone, hour: Int) -> Date {
	var calendar = Calendar(identifier: .gregorian)
	calendar.timeZone = timeZone
	var parts = calendar.dateComponents([.year, .month, .day], from: now)
	parts.hour = hour
	parts.minute = 0
	parts.second = 0
	let todayReset = calendar.date(from: parts) ?? now
	if now < todayReset {
		return calendar.date(byAdding: .day, value: -1, to: todayReset) ?? todayReset
	}
	return todayReset
}
