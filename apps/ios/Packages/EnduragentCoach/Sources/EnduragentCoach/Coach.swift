import Foundation

public actor Coach {
	public let memory: Memory
	public let planning: Planning

	private let sport: SportID
	private let transport: any ModelTransport
	private let intervals: any IntervalsClient
	private let store: any RecordLog
	private let clock: any Clock
	private var language: LanguagePreference
	private let tools: ToolRuntime
	private let runner: TurnRunner
	private var mailboxes: [ChatID: ChatMailbox]

	public init(
		sport: SportID,
		transport: any ModelTransport,
		intervals: any IntervalsClient,
		store: any RecordLog,
		clock: any Clock,
		language: LanguagePreference
	) {
		self.sport = sport
		self.transport = transport
		self.intervals = intervals
		self.store = store
		self.clock = clock
		self.language = language
		self.memory = Memory(store: store, clock: clock)
		let planning = Planning(store: store, intervals: intervals, clock: clock)
		self.planning = planning
		let tools = ToolRuntime(intervals: intervals, store: store, planning: planning, clock: clock)
		self.tools = tools
		self.runner = TurnRunner(
			transport: transport,
			intervals: intervals,
			store: store,
			clock: clock,
			tools: tools,
			planning: planning
		)
		self.mailboxes = [:]
	}

	public nonisolated func send(_ text: String, chatId: ChatID) -> AsyncThrowingStream<CoachEvent, Error> {
		AsyncThrowingStream { continuation in
			let task = Task {
				do {
					let stream = await self.streamFromMailbox(text, chatId: chatId)
					for try await event in stream {
						continuation.yield(event)
					}
					continuation.finish()
				} catch {
					continuation.finish(throwing: error)
				}
			}
			continuation.onTermination = { termination in
				guard case .cancelled = termination else { return }
				task.cancel()
			}
		}
	}

	public func history(chatId: ChatID) async -> [ChatMessage] {
		(try? await loadHistory(chatId: chatId)) ?? []
	}

	public func pendingProposal(chatId: ChatID) async -> PendingProposal? {
		let records = (try? await store.fetch(
			RecordQuery(kinds: [.pendingProposal, .proposalCleared], chatId: chatId, deviceLocalOnly: true)
		)) ?? []
		let ordered = records.sorted { $0.hlc < $1.hlc }
		var current: ProposalBody?
		for record in ordered {
			switch record.body {
			case .pendingProposal(let body) where body.chatId == chatId:
				current = body
			case .proposalCleared(let body) where body.chatId == chatId:
				if current?.nonce == body.nonce {
					current = nil
				}
			default:
				break
			}
		}
		guard let current, current.expiresAt > clock.now else {
			return nil
		}
		return PendingProposal(
			chatId: current.chatId,
			nonce: current.nonce,
			summary: current.summary,
			description: current.description,
			expiresAt: current.expiresAt
		)
	}

	public func confirm(chatId: ChatID, nonce: Nonce) async throws -> ConfirmOutcome {
		_ = chatId
		_ = nonce
		_ = sport
		_ = transport
		_ = intervals
		_ = tools
		return .none
	}

	public func setCoachReplyLanguage(_ tag: LanguageTag?) async {
		language.coachReply = tag
		let tz = IANATimeZone(identifier: clock.timeZone.identifier) ?? IANATimeZone(identifier: "GMT")!
		let record = AthleteRecord(
			ulid: ULID.generate(at: clock.now),
			deviceId: store.deviceId,
			hlc: .tick(now: clock.now, deviceId: store.deviceId, last: nil),
			timeZone: tz,
			civilDate: IntervalsPolicy.today(now: clock.now, timeZone: clock.timeZone),
			body: .coachReplyLanguage(CoachReplyLanguageBody(tag: tag))
		)
		try? await store.append(record)
	}

	public func waitForMemoryFlush() async {
		for box in mailboxes.values {
			await box.runQueuedFlush()
		}
	}

	public func stop(chatId: ChatID) async {
		await mailbox(for: chatId).stop()
	}

	public func snapshot(chatId: ChatID) async -> ViewSeam {
		let transcript = await history(chatId: chatId)
		let pending = await pendingProposal(chatId: chatId)
		let box = mailbox(for: chatId)
		let busy = await box.busy
		let phase: TurnPhase
		if busy {
			phase = .streaming
		} else if pending != nil {
			phase = .awaitingConfirmation
		} else {
			phase = .idle
		}
		return ViewSeam(
			transcript: transcript,
			streamingText: "",
			leadFact: nil,
			commands: SlashCommand.all,
			pendingWrite: pending,
			planCards: [],
			phase: phase
		)
	}

	private func streamFromMailbox(_ text: String, chatId: ChatID) async -> AsyncThrowingStream<CoachEvent, Error> {
		await mailbox(for: chatId).send(text, language: language)
	}

	private func mailbox(for chatId: ChatID) -> ChatMailbox {
		if let existing = mailboxes[chatId] {
			return existing
		}
		let created = ChatMailbox(
			chatId: chatId,
			runner: runner,
			memory: memory,
			store: store,
			clock: clock,
			transport: transport
		)
		mailboxes[chatId] = created
		return created
	}

	private func loadHistory(chatId: ChatID) async throws -> [ChatMessage] {
		let records = try await store.fetch(
			RecordQuery(kinds: [.userMessage, .assistantMessage, .windowStart], chatId: chatId)
		)
		let ordered = records.sorted { $0.hlc < $1.hlc }
		let start = ordered.reversed().compactMap { record -> ULID? in
			if case .windowStart(let body) = record.body { return body.firstIncludedUlid }
			return nil
		}.first
		var messages: [ChatMessage] = []
		for record in ordered {
			if let start, record.ulid.rawValue < start.rawValue {
				continue
			}
			switch record.body {
			case .userMessage(let body):
				messages.append(ChatMessage(role: .user, text: body.athleteText, civilDate: record.civilDate))
			case .assistantMessage(let body):
				messages.append(ChatMessage(role: .assistant, text: body.text, civilDate: record.civilDate))
			default:
				break
			}
		}
		return messages
	}
}
