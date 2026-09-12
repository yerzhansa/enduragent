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
		fatalError("not implemented")
	}

	public func history(chatId: ChatID) async -> [ChatMessage] {
		fatalError("not implemented")
	}

	public func pendingProposal(chatId: ChatID) async -> PendingProposal? {
		fatalError("not implemented")
	}

	public func confirm(chatId: ChatID, nonce: Nonce) async throws -> ConfirmOutcome {
		fatalError("not implemented")
	}

	public func setCoachReplyLanguage(_ tag: LanguageTag?) async {
		fatalError("not implemented")
	}

	public func waitForMemoryFlush() async {
		fatalError("not implemented")
	}

	public func stop(chatId: ChatID) async {
		fatalError("not implemented")
	}

	public func snapshot(chatId: ChatID) async -> ViewSeam {
		fatalError("not implemented")
	}
}
