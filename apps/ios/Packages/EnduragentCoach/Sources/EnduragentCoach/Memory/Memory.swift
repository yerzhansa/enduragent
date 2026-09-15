import Foundation

public struct SectionName: RawRepresentable, Hashable, Sendable {
	public let rawValue: String

	public init(rawValue: String) {
		self.rawValue = rawValue
	}

	public static let person = SectionName(rawValue: "person")
	public static let schedule = SectionName(rawValue: "schedule")
	public static let goals = SectionName(rawValue: "goals")
	public static let preferences = SectionName(rawValue: "preferences")
	public static let notes = SectionName(rawValue: "notes")
	public static let medicalHistory = SectionName(rawValue: "medical-history")
	public static let cyclingProfile = SectionName(rawValue: "cycling-profile")
	public static let cyclingEquipment = SectionName(rawValue: "cycling-equipment")
	public static let cyclingHistory = SectionName(rawValue: "cycling-history")

	public var inject: Bool {
		switch rawValue {
		case SectionName.notes.rawValue, SectionName.cyclingEquipment.rawValue, SectionName.cyclingHistory.rawValue:
			return false
		default:
			return true
		}
	}

	public static let cyclingEffective: [SectionName] = [
		.person, .schedule, .goals, .preferences, .notes, .medicalHistory,
		.cyclingProfile, .cyclingEquipment, .cyclingHistory,
	]

	public static var declaredNames: Set<String> {
		Set(cyclingEffective.map(\.rawValue))
	}

	public var hint: String {
		switch rawValue {
		case SectionName.person.rawValue:
			return "name, weight, age, available training days"
		case SectionName.schedule.rawValue:
			return "weekly availability, time windows, blackout days"
		case SectionName.goals.rawValue:
			return "target events, race dates, fitness targets"
		case SectionName.preferences.rawValue:
			return "coaching style, communication preferences"
		case SectionName.notes.rawValue:
			return "anything not covered by other sections"
		case SectionName.medicalHistory.rawValue:
			return "chronic conditions, medications, long-term injuries"
		case SectionName.cyclingProfile.rawValue:
			return "FTP, max/resting HR, W/kg, experience level"
		case SectionName.cyclingEquipment.rawValue:
			return "bikes, trainer, power meter, sensors"
		case SectionName.cyclingHistory.rawValue:
			return "cycling injuries, FTP test history, ride recovery patterns"
		default:
			return rawValue
		}
	}

	public var sectionDescription: String {
		switch rawValue {
		case SectionName.person.rawValue:
			return
				"Name, weight (kg), age, available training days per week. "
				+ "Sport-specific physiology (FTP, VDOT, max HR) goes to the sport-prefixed profile section."
		case SectionName.schedule.rawValue:
			return "Weekly training availability, time windows, blackout days"
		case SectionName.goals.rawValue:
			return
				"Target events, race dates, fitness targets, milestones "
				+ "(e.g., 'sub-3:30 century in October', 'reach 280W FTP by Q3')"
		case SectionName.preferences.rawValue:
			return "Coaching style, training environment, communication preferences"
		case SectionName.notes.rawValue:
			return "Anything else important not covered by other sections"
		case SectionName.medicalHistory.rawValue:
			return "Chronic conditions, medications, long-term injuries — facts that persist across sports"
		case SectionName.cyclingProfile.rawValue:
			return
				"FTP (watts), max HR, resting HR, W/kg ratio, experience level. "
				+ "Body data lives in `person`; this is cycling-specific physiology."
		case SectionName.cyclingEquipment.rawValue:
			return "Bikes, trainer, power meter, head unit, indoor setup"
		case SectionName.cyclingHistory.rawValue:
			return
				"Cycling-specific injuries (knee, lower back, fit issues), FTP test history, "
				+ "recovery patterns from rides, ride-related sleep/HRV trends. "
				+ "Chronic conditions belong in `medical-history`, not here."
		default:
			return rawValue
		}
	}
}

public enum LedgerKind: String, Sendable {
	case decision
	case override
	case illness
	case experiment
	case outcome
}

public enum LedgerSource: String, Sendable {
	case flush
	case chat
}

public enum JournalOp: String, Sendable {
	case writeSection = "write-section"
	case savePlan = "save-plan"
	case renameSections = "rename-sections"
}

public enum FlushTrigger: String, Sendable {
	case trim
	case preCompaction
	case overflow
	case explicitReset
	case staleReset
	case softThreshold
}

public struct MemoryHit: Sendable, Equatable {
	public var date: CivilDate
	public var kind: Kind
	public var text: String

	public init(date: CivilDate, kind: Kind, text: String) {
		self.date = date
		self.kind = kind
		self.text = text
	}

	public enum Kind: Sendable, Equatable {
		case dailyNote
		case ledger(LedgerKind)
		case journal
	}
}

public struct MemoryView: Sendable, Equatable {
	public var sections: [String: String]
	public var todayNotes: String?
	public var planHeadline: PlanHeadline?
	public var orphanNames: [String]

	public init(sections: [String: String], todayNotes: String?, planHeadline: PlanHeadline?, orphanNames: [String]) {
		self.sections = sections
		self.todayNotes = todayNotes
		self.planHeadline = planHeadline
		self.orphanNames = orphanNames
	}
}

public struct PlanHeadline: Sendable, Equatable {
	public var name: String
	public var primaryGoal: String?
	public var totalWeeks: Int?
	public var status: PlanStatus?

	public init(name: String, primaryGoal: String?, totalWeeks: Int?, status: PlanStatus?) {
		self.name = name
		self.primaryGoal = primaryGoal
		self.totalWeeks = totalWeeks
		self.status = status
	}
}

public struct MemoryQueryFailure: Error, Equatable, Sendable {
	public var message: String

	public init(message: String) {
		self.message = message
	}
}

public enum MemoryFlushPolicy {
	public static let maxSteps = 5
	public static let maxAttempts = 2
	public static let sectionSoftWarnChars = 4000
	public static let flushShrinkMinChars = 200
	public static let flushShrinkRatio = 0.7
	public static let flushZeroWriteMinMessages = 4
	public static let memorySectionBudgetChars = 1500
	public static let compactionStart = "### Compaction summary"
	public static let compactionEnd = "### End of compaction summary"
	public static let stampPrefix = "_updated: "
	public static let consumedFlushKeyPrefix = "flush-consumed:"
	public static let historyPreviewChars = 200
}

public struct Memory: Sendable {
	private let store: any RecordLog
	private let clock: any Clock

	public init(store: any RecordLog, clock: any Clock) {
		self.store = store
		self.clock = clock
	}

	public func query(from: CivilDate, to: CivilDate, contains: String?) async throws -> [MemoryHit] {
		if from > to {
			throw MemoryQueryFailure(
				message: "Error: 'from' (\(from.rawValue)) is after 'to' (\(to.rawValue)). Swap the bounds."
			)
		}
		let days = IntervalsPolicy.inclusiveDayCount(from: from, to: to)
		if days > MemoryQuery.maxRangeDays {
			throw MemoryQueryFailure(
				message:
					"Error: range is \(days) days; the maximum is \(MemoryQuery.maxRangeDays). Query a narrower range."
			)
		}
		let snapshot = try await loadSnapshot()
		let needle = contains?.lowercased()
		var collected: [(hit: MemoryHit, order: Int)] = []
		var order = 0

		for date in eachDate(from: from, to: to) {
			let text = snapshot.dailyText(on: date)
			if text.isEmpty { continue }
			if let needle {
				let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
					.filter { $0.lowercased().contains(needle) }
					.map(String.init)
				if lines.isEmpty { continue }
				collected.append(
					(MemoryHit(date: date, kind: .dailyNote, text: lines.joined(separator: "\n")), order)
				)
			} else {
				collected.append((MemoryHit(date: date, kind: .dailyNote, text: text), order))
			}
			order += 1
		}

		for record in snapshot.ledgerRecords {
			guard record.civilDate >= from, record.civilDate <= to else { continue }
			guard case .ledgerEvent(let body) = record.body else { continue }
			let line = serializeLedger(record, body: body)
			if let needle, !line.lowercased().contains(needle) { continue }
			collected.append(
				(MemoryHit(date: record.civilDate, kind: .ledger(body.kind), text: line), order)
			)
			order += 1
		}

		for record in snapshot.journalRecords {
			guard record.civilDate >= from, record.civilDate <= to else { continue }
			guard case .journal(let body) = record.body else { continue }
			let parsed = parseJournalPreview(body.preview)
			let section = parsed.section
			let oldBody = parsed.oldBody
			let newBody = parsed.newBody ?? body.preview
			if let needle {
				let haystacks = [section, oldBody, newBody]
				if !haystacks.contains(where: { $0?.lowercased().contains(needle) == true }) {
					continue
				}
			}
			let summary = historyBodySummary(section ?? body.op.rawValue, query: needle)
			let was = historyBodySummary(oldBody, query: needle)
			let now = historyBodySummary(newBody, query: needle)
			collected.append(
				(
					MemoryHit(
						date: record.civilDate,
						kind: .journal,
						text: "\(summary) — was: \(was) / now: \(now)"
					),
					order
				)
			)
			order += 1
		}

		return collected.sorted { lhs, rhs in
			if lhs.hit.date != rhs.hit.date {
				return lhs.hit.date > rhs.hit.date
			}
			let leftKind = kindOrder(lhs.hit.kind)
			let rightKind = kindOrder(rhs.hit.kind)
			if leftKind != rightKind {
				return leftKind < rightKind
			}
			return lhs.order < rhs.order
		}.map(\.hit)
	}

	public func context() async throws -> String {
		try await renderContext(excluding: SectionName.cyclingEffective.filter { !$0.inject }.map(\.rawValue))
	}

	package func fullContext() async throws -> String {
		try await renderContext(excluding: [])
	}

	package func complementContext() async throws -> String {
		let injected = SectionName.cyclingEffective.filter(\.inject).map(\.rawValue)
		return try await renderContext(excluding: injected)
	}

	public func writeSection(_ name: SectionName, content: String, source: LedgerSource) async throws {
		let today = IntervalsPolicy.today(now: clock.now, timeZone: clock.timeZone)
		let snapshot = try await loadSnapshot()
		let previous = UnionMerge.sectionText(snapshot.sections, name: name)
		let stamped = stampUpdated(demoteEmbeddedH2(content), date: today)
		_ = MemoryFlushPolicy.sectionSoftWarnChars
		let digestBody = trimEnd(stamped)
		let logical = hasLogicalSectionContent(stamped)
		let provenance = ProvenanceBody(
			key: "memory:\(name.rawValue)",
			garmin: false,
			nonGarmin: false,
			unknown: logical,
			contentSha256: sha256Hex(digestBody)
		)
		try await append(.provenance(provenance), civilDate: today)
		let preview = JSONValue.object([
			"newBody": .string(stamped),
			"oldBody": previous.map(JSONValue.string) ?? .null,
			"section": .string(name.rawValue),
			"source": .string(source.rawValue),
		]).canonicalDigestInput()
		do {
			try await append(.journal(JournalBody(op: .writeSection, preview: preview)), civilDate: today)
		} catch {
			_ = error
		}
		try await append(.memorySection(MemorySectionBody(name: name, content: stamped)), civilDate: today)
	}

	public func appendDailyNote(_ note: String) async throws {
		let today = IntervalsPolicy.today(now: clock.now, timeZone: clock.timeZone)
		let snapshot = try await loadSnapshot()
		let existing = snapshot.dailyNotesOnly(on: today)
		if !existing.isEmpty, "\n\(existing)\n".contains("\n\(note)\n") {
			return
		}
		try await append(.dailyNote(DailyNoteBody(note: note)), civilDate: today)
	}

	public func appendEvent(date: CivilDate, kind: LedgerKind, text: String, source: LedgerSource) async throws -> Bool {
		let snapshot = try await loadSnapshot()
		let digest = UnionMerge.ledgerDigest(date: date, kind: kind, text: text)
		for record in snapshot.ledgerRecords {
			guard case .ledgerEvent(let body) = record.body else { continue }
			if UnionMerge.ledgerDigest(date: record.civilDate, kind: body.kind, text: body.text) == digest {
				return false
			}
		}
		let body = LedgerEventBody(kind: kind, text: text, source: source)
		let line = serializeLedgerLine(date: date, kind: kind, text: text, source: source, wallMs: wallMs(clock.now))
		try await append(
			.provenance(
				ProvenanceBody(
					key: "ledger:\(sha256Hex(line))",
					garmin: false,
					nonGarmin: false,
					unknown: true,
					contentSha256: sha256Hex(line)
				)
			),
			civilDate: date
		)
		try await append(.ledgerEvent(body), civilDate: date)
		return true
	}

	public func flush(trigger: FlushTrigger, chatId: ChatID, transport: any ModelTransport) async throws {
		let pending = try await oldestUnconsumedFlush(chatId: chatId)
		let effectiveTrigger: FlushTrigger = {
			if let pending, case .flushPending(let body) = pending.body {
				return body.trigger
			}
			return trigger
		}()
		let conversation = try await loadFlushMessages(trigger: effectiveTrigger, chatId: chatId, pending: pending)
		if conversation.isEmpty, pending == nil {
			return
		}
		var attempt = 0
		var lastWrites = 0
		var lastLedger = 0
		while attempt < MemoryFlushPolicy.maxAttempts {
			attempt += 1
			let outcome = try await runFlushGenerate(conversation: conversation, transport: transport)
			lastWrites = outcome.writes
			lastLedger = outcome.ledgerAppends
			let zeroWrite =
				outcome.writes == 0
				&& outcome.ledgerAppends == 0
				&& conversation.count >= MemoryFlushPolicy.flushZeroWriteMinMessages
			if effectiveTrigger == .staleReset, zeroWrite, attempt < MemoryFlushPolicy.maxAttempts {
				continue
			}
			break
		}
		_ = lastWrites
		_ = lastLedger
		if let pending {
			try await markConsumed(pending)
		}
	}

	public func view() async throws -> MemoryView {
		let snapshot = try await loadSnapshot()
		var sections: [String: String] = [:]
		for name in SectionName.cyclingEffective {
			if let content = UnionMerge.sectionText(snapshot.sections, name: name) {
				sections[name.rawValue] = content
			}
		}
		for orphan in snapshot.orphanNames {
			if let content = UnionMerge.sectionText(snapshot.sections, name: SectionName(rawValue: orphan)) {
				sections[orphan] = content
			}
		}
		let today = IntervalsPolicy.today(now: clock.now, timeZone: clock.timeZone)
		let notes = injectableDailyLines(snapshot.dailyText(on: today)).joined(separator: "\n")
		let trimmed = trimEnd(notes)
		return MemoryView(
			sections: sections,
			todayNotes: trimmed.isEmpty ? nil : trimmed,
			planHeadline: nil,
			orphanNames: snapshot.orphanNames
		)
	}

	package func hiddenSectionsHaveLogicalContent() async throws -> Bool {
		let snapshot = try await loadSnapshot()
		for name in SectionName.cyclingEffective where !name.inject {
			if let content = UnionMerge.sectionText(snapshot.sections, name: name), hasLogicalSectionContent(content) {
				return true
			}
		}
		return false
	}

	private func renderContext(excluding: [String]) async throws -> String {
		let snapshot = try await loadSnapshot()
		let exclude = Set(excluding)
		var parts: [String] = []
		var blocks: [String] = []
		for name in SectionName.cyclingEffective where name.inject && !exclude.contains(name.rawValue) {
			if let content = UnionMerge.sectionText(snapshot.sections, name: name), !content.isEmpty {
				blocks.append("## \(name.rawValue)\n\(content)")
			}
		}
		for orphan in snapshot.orphanNames where !exclude.contains(orphan) {
			if let content = UnionMerge.sectionText(snapshot.sections, name: SectionName(rawValue: orphan)),
			   !content.isEmpty
			{
				blocks.append("## \(orphan)\n\(content)")
			}
		}
		if !blocks.isEmpty {
			parts.append("## Athlete Memory\n" + blocks.joined(separator: "\n\n") + "\n")
		}
		let today = IntervalsPolicy.today(now: clock.now, timeZone: clock.timeZone)
		let daily = injectableDailyLines(snapshot.dailyText(on: today)).joined(separator: "\n")
		if !trimEnd(daily).isEmpty {
			parts.append("## Today's Notes\n" + daily)
		}
		if let headline = snapshot.planHeadline {
			var lines: [String] = []
			lines.append("- Name: \(headline.name)")
			if let goal = headline.primaryGoal {
				lines.append("- Goal: \(goal)")
			}
			if let weeks = headline.totalWeeks {
				lines.append("- Duration: \(weeks) weeks")
			}
			if let status = headline.status {
				lines.append("- Status: \(status.rawValue)")
			}
			if !lines.isEmpty {
				parts.append("## Current Plan\n" + lines.joined(separator: "\n"))
			}
		}
		return parts.joined(separator: "\n\n")
	}

	private func runFlushGenerate(
		conversation: [ChatMessage],
		transport: any ModelTransport
	) async throws -> (writes: Int, ledgerAppends: Int) {
		let current = (try? await fullContext()) ?? ""
		let today = IntervalsPolicy.today(now: clock.now, timeZone: clock.timeZone)
		let fenced = PromptAssembly.wrapAthleteContext(current.isEmpty ? "No athlete data stored yet." : current)
		var messages: [WireMessage] = [
			WireMessage(role: .system, content: MemoryFlushPrompt.system, toolCalls: [], toolCallId: nil),
		]
		messages.append(contentsOf: conversation.map(wireMessage(from:)))
		messages.append(
			WireMessage(
				role: .user,
				content: MemoryFlushPrompt.userPrompt(
					sections: SectionName.cyclingEffective,
					currentMemory: fenced,
					today: today.rawValue
				),
				toolCalls: [],
				toolCallId: nil
			)
		)
		let schemas = MemoryFlushPrompt.toolSchemas()
		var writes = 0
		var ledgerAppends = 0
		var steps = 0
		while steps < MemoryFlushPolicy.maxSteps {
			steps += 1
			let request = CompletionRequest.openRouter(
				messages: messages,
				tools: schemas,
				deadline: TurnPolicy.chatCallDeadline
			)
			let step = try await collectFlush(transport: transport, request: request)
			if step.calls.isEmpty {
				break
			}
			messages.append(
				WireMessage(role: .assistant, content: step.text, toolCalls: step.calls, toolCallId: nil)
			)
			for call in step.calls {
				let (payload, wroteSection, wroteLedger) = try await executeFlushTool(call)
				if wroteSection { writes += 1 }
				if wroteLedger { ledgerAppends += 1 }
				messages.append(
					WireMessage(role: .tool, content: payload, toolCalls: [], toolCallId: call.id)
				)
			}
		}
		return (writes, ledgerAppends)
	}

	private func collectFlush(
		transport: any ModelTransport,
		request: CompletionRequest
	) async throws -> (text: String, calls: [WireToolCall], reason: FinishReason) {
		var text = ""
		var calls: [WireToolCall] = []
		var reason: FinishReason = .stop
		for try await event in transport.stream(request) {
			switch event {
			case .textDelta(let delta):
				text += delta
			case .toolCall(let call):
				calls.append(call)
			case .heartbeat:
				break
			case .finished(let finishReason, _):
				reason = finishReason
			}
		}
		_ = reason
		return (text, calls, reason)
	}

	private func executeFlushTool(_ call: WireToolCall) async throws -> (String, Bool, Bool) {
		let arguments = (try? JSONValue.parse(call.arguments)) ?? .object([:])
		switch call.name {
		case .memoryWrite:
			let fields = arguments.objectFields
			guard let section = fields["section"]?.stringValue, let content = fields["content"]?.stringValue else {
				return (JSONValue.object(["error": .string("section_required")]).canonicalDigestInput(), false, false)
			}
			try await writeSection(SectionName(rawValue: section), content: content, source: .flush)
			return (JSONValue.object(["saved": .bool(true)]).canonicalDigestInput(), true, false)
		case .ledgerAppend:
			let fields = arguments.objectFields
			guard
				let dateRaw = fields["date"]?.stringValue,
				let date = CivilDate(rawValue: dateRaw),
				let kindRaw = fields["kind"]?.stringValue,
				let kind = LedgerKind(rawValue: kindRaw),
				let text = fields["text"]?.stringValue,
				!text.isEmpty
			else {
				return (
					JSONValue.object(["error": .string("invalid_event")]).canonicalDigestInput(),
					false,
					false
				)
			}
			let recorded = try await appendEvent(date: date, kind: kind, text: text, source: .flush)
			if recorded {
				return (JSONValue.object(["recorded": .bool(true)]).canonicalDigestInput(), false, true)
			}
			return (
				JSONValue.object(["duplicate": .bool(true), "recorded": .bool(false)]).canonicalDigestInput(),
				false,
				false
			)
		default:
			return (JSONValue.object(["error": .string("unsupported")]).canonicalDigestInput(), false, false)
		}
	}

	private func oldestUnconsumedFlush(chatId: ChatID) async throws -> AthleteRecord? {
		let pending = try await store.fetch(
			RecordQuery(kinds: [.flushPending], chatId: chatId, deviceLocalOnly: true)
		).sorted { $0.hlc < $1.hlc }
		let consumed = try await consumedFlushIDs()
		return pending.first { record in
			!consumed.contains(record.ulid.rawValue)
		}
	}

	private func consumedFlushIDs() async throws -> Set<String> {
		let records = try await store.fetch(RecordQuery(kinds: [.provenance]))
		var ids: Set<String> = []
		for record in records {
			guard case .provenance(let body) = record.body else { continue }
			if body.key.hasPrefix(MemoryFlushPolicy.consumedFlushKeyPrefix) {
				ids.insert(String(body.key.dropFirst(MemoryFlushPolicy.consumedFlushKeyPrefix.count)))
			}
		}
		return ids
	}

	private func markConsumed(_ pending: AthleteRecord) async throws {
		let today = IntervalsPolicy.today(now: clock.now, timeZone: clock.timeZone)
		try await append(
			.provenance(
				ProvenanceBody(
					key: MemoryFlushPolicy.consumedFlushKeyPrefix + pending.ulid.rawValue,
					garmin: false,
					nonGarmin: false,
					unknown: false,
					contentSha256: sha256Hex(pending.ulid.rawValue)
				)
			),
			civilDate: today
		)
	}

	private func loadFlushMessages(
		trigger: FlushTrigger,
		chatId: ChatID,
		pending: AthleteRecord?
	) async throws -> [ChatMessage] {
		let records = try await store.fetch(
			RecordQuery(kinds: [.userMessage, .assistantMessage, .windowStart], chatId: chatId)
		)
		let ignoreWindow =
			trigger == .trim || trigger == .preCompaction || trigger == .overflow || trigger == .explicitReset
		if let pending, case .flushPending(let body) = pending.body, !body.messageUlids.isEmpty {
			let wanted = Set(body.messageUlids.map(\.rawValue))
			let byUlid = Dictionary(uniqueKeysWithValues: records.map { ($0.ulid.rawValue, $0) })
			var messages: [ChatMessage] = []
			for ulid in body.messageUlids {
				guard let record = byUlid[ulid.rawValue] ?? records.first(where: { $0.ulid.rawValue == ulid.rawValue })
				else { continue }
				_ = wanted
				switch record.body {
				case .userMessage(let message):
					messages.append(ChatMessage(role: .user, text: message.athleteText, civilDate: record.civilDate))
				case .assistantMessage(let message):
					messages.append(ChatMessage(role: .assistant, text: message.text, civilDate: record.civilDate))
				default:
					break
				}
			}
			let current = UnionMerge.conversation(records, chatId: chatId, deviceId: store.deviceId)
			return mergeUnique(messages, current)
		}
		if ignoreWindow {
			return records.sorted { $0.hlc < $1.hlc }.compactMap { record in
				switch record.body {
				case .userMessage(let body) where body.chatId == chatId:
					return ChatMessage(role: .user, text: body.athleteText, civilDate: record.civilDate)
				case .assistantMessage(let body) where body.chatId == chatId:
					return ChatMessage(role: .assistant, text: body.text, civilDate: record.civilDate)
				default:
					return nil
				}
			}
		}
		return UnionMerge.conversation(records, chatId: chatId, deviceId: store.deviceId)
	}

	private func mergeUnique(_ first: [ChatMessage], _ second: [ChatMessage]) -> [ChatMessage] {
		var seen: Set<String> = []
		var out: [ChatMessage] = []
		for message in first + second {
			let key = message.role.rawValue + "\u{1e}" + message.text
			if seen.insert(key).inserted {
				out.append(message)
			}
		}
		return out
	}

	private func loadSnapshot() async throws -> MemorySnapshot {
		let sections = try await store.fetch(RecordQuery(kinds: [.memorySection]))
		let daily = try await store.fetch(RecordQuery(kinds: [.dailyNote]))
		let ledger = try await store.fetch(RecordQuery(kinds: [.ledgerEvent]))
		let journal = try await store.fetch(RecordQuery(kinds: [.journal]))
		let compaction = try await store.fetch(RecordQuery(kinds: [.compactionSummary]))
		return MemorySnapshot(
			sections: sections,
			daily: daily,
			ledgerRecords: ledger.sorted { $0.hlc < $1.hlc },
			journalRecords: journal.sorted { $0.hlc < $1.hlc },
			compaction: compaction,
			orphanNames: orphanNames(in: sections)
		)
	}

	private func orphanNames(in records: [AthleteRecord]) -> [String] {
		let declared = SectionName.declaredNames
		var seen: Set<String> = []
		var names: [String] = []
		for record in records.sorted(by: { $0.hlc < $1.hlc }) {
			guard case .memorySection(let body) = record.body else { continue }
			if declared.contains(body.name.rawValue) { continue }
			if seen.insert(body.name.rawValue).inserted {
				names.append(body.name.rawValue)
			}
		}
		return names
	}

	private func append(_ body: RecordBody, civilDate: CivilDate) async throws {
		let last = try await maxHLC()
		let tz = IANATimeZone(identifier: clock.timeZone.identifier) ?? IANATimeZone(identifier: "GMT")!
		let record = AthleteRecord(
			ulid: ULID.generate(at: clock.now),
			deviceId: store.deviceId,
			hlc: .tick(now: clock.now, deviceId: store.deviceId, last: last),
			timeZone: tz,
			civilDate: civilDate,
			body: body
		)
		try await store.append(record)
	}

	private func maxHLC() async throws -> HybridLogicalClock? {
		let synced = RecordKind.allCases.filter { $0.locality == .synced }
		let local = RecordKind.allCases.filter { $0.locality == .deviceLocal }
		let first = try await store.fetch(RecordQuery(kinds: Set(synced)))
		let second = try await store.fetch(RecordQuery(kinds: Set(local), deviceLocalOnly: true))
		return (first + second).map(\.hlc).max()
	}
}

public enum MemoryQuery {
	public static let maxRangeDays = 366
	public static let maxResultChars = 20_000
	public static let truncationNotice = "[truncated — narrow the date range or add a query term]"
	public static let emptySuffix = ": no daily notes, events, or history found."

	public static func render(_ hits: [MemoryHit], from: CivilDate, to: CivilDate, query: String? = nil) -> String {
		let header = "Memory query \(from.rawValue)..\(to.rawValue)" + (query.map { " matching \"\($0)\"" } ?? "")
		if hits.isEmpty {
			return header + emptySuffix
		}
		var grouped: [(CivilDate, [MemoryHit])] = []
		for hit in hits {
			if grouped.last?.0 == hit.date {
				grouped[grouped.count - 1].1.append(hit)
			} else {
				grouped.append((hit.date, [hit]))
			}
		}
		let sections = grouped.map { date, rows in
			let lines = rows.map(renderLine)
			return "## \(date.rawValue)\n" + lines.joined(separator: "\n")
		}
		let result = ([header] + sections).joined(separator: "\n\n")
		if result.utf16.count > maxResultChars {
			return truncateUtf16Safe(result, maxChars: maxResultChars) + "\n" + truncationNotice
		}
		return result
	}
}

private struct MemorySnapshot {
	var sections: [AthleteRecord]
	var daily: [AthleteRecord]
	var ledgerRecords: [AthleteRecord]
	var journalRecords: [AthleteRecord]
	var compaction: [AthleteRecord]
	var orphanNames: [String]
	var planHeadline: PlanHeadline? { nil }

	func dailyNotesOnly(on date: CivilDate) -> String {
		daily.sorted { $0.hlc < $1.hlc }.compactMap { record -> String? in
			guard record.civilDate == date, case .dailyNote(let body) = record.body else { return nil }
			return body.note
		}.joined(separator: "\n")
	}

	func dailyText(on date: CivilDate) -> String {
		var notes = dailyNotesOnly(on: date)
		if notes.contains(MemoryFlushPolicy.compactionStart) {
			return notes
		}
		let extras = compaction.sorted { $0.hlc < $1.hlc }.compactMap { record -> String? in
			guard record.civilDate == date, case .compactionSummary(let body) = record.body else { return nil }
			return formatCompactionNote(body.markdown)
		}
		for extra in extras {
			notes = notes.isEmpty ? extra : notes + "\n" + extra
		}
		return notes
	}
}

private struct JournalPreview {
	var section: String?
	var oldBody: String?
	var newBody: String?
}

private func parseJournalPreview(_ preview: String) -> JournalPreview {
	guard let parsed = try? JSONValue.parse(preview) else {
		return JournalPreview(section: nil, oldBody: nil, newBody: preview)
	}
	let fields = parsed.objectFields
	return JournalPreview(
		section: fields["section"]?.stringValue,
		oldBody: fields["oldBody"]?.stringValue,
		newBody: fields["newBody"]?.stringValue
	)
}

private func demoteEmbeddedH2(_ content: String) -> String {
	content.split(separator: "\n", omittingEmptySubsequences: false).map { line in
		let text = String(line)
		if text.hasPrefix("## ") {
			return "### " + text.dropFirst(3)
		}
		return text
	}.joined(separator: "\n")
}

private func stampUpdated(_ content: String, date: CivilDate) -> String {
	var body = content
	if body.hasPrefix(MemoryFlushPolicy.stampPrefix) {
		if let newline = body.firstIndex(of: "\n") {
			body = String(body[body.index(after: newline)...])
		} else {
			body = ""
		}
	}
	if body.isEmpty {
		return MemoryFlushPolicy.stampPrefix + date.rawValue
	}
	return MemoryFlushPolicy.stampPrefix + date.rawValue + "\n" + body
}

private func hasLogicalSectionContent(_ stamped: String) -> Bool {
	guard let newline = stamped.firstIndex(of: "\n") else { return false }
	return !stamped[stamped.index(after: newline)...]
		.trimmingCharacters(in: .whitespacesAndNewlines)
		.isEmpty
}

package func injectableDailyLines(_ daily: String) -> [String] {
	var inSummary = false
	var lines: [String] = []
	for raw in daily.split(separator: "\n", omittingEmptySubsequences: false) {
		let line = String(raw)
		let trimmed = trimEnd(line)
		if trimmed == MemoryFlushPolicy.compactionStart {
			inSummary = true
			continue
		}
		if trimmed == MemoryFlushPolicy.compactionEnd {
			inSummary = false
			continue
		}
		if inSummary, isAtMostH3(line) {
			inSummary = false
			lines.append(line)
			continue
		}
		if inSummary {
			continue
		}
		lines.append(line)
	}
	return lines
}

private func isAtMostH3(_ line: String) -> Bool {
	line.hasPrefix("# ") || line.hasPrefix("## ") || line.hasPrefix("### ")
}

private func formatCompactionNote(_ summary: String) -> String {
	let demoted = summary.split(separator: "\n", omittingEmptySubsequences: false).map { line -> String in
		let text = String(line)
		if text.hasPrefix("## "), !text.hasPrefix("### ") {
			return "#### " + text.dropFirst(3)
		}
		return text
	}.joined(separator: "\n")
	return
		MemoryFlushPolicy.compactionStart
		+ "\n\n"
		+ demoted
		+ "\n"
		+ MemoryFlushPolicy.compactionEnd
}

private func eachDate(from: CivilDate, to: CivilDate) -> [CivilDate] {
	var dates: [CivilDate] = []
	var cursor = from
	while cursor <= to {
		dates.append(cursor)
		if cursor == to { break }
		cursor = cursor.adding(days: 1)
	}
	return dates
}

private func kindOrder(_ kind: MemoryHit.Kind) -> Int {
	switch kind {
	case .dailyNote: return 0
	case .ledger: return 1
	case .journal: return 2
	}
}

private func renderLine(_ hit: MemoryHit) -> String {
	switch hit.kind {
	case .dailyNote:
		return hit.text
	case .ledger:
		return "event: \(hit.text)"
	case .journal:
		return "history: \(hit.text)"
	}
}

private func serializeLedger(_ record: AthleteRecord, body: LedgerEventBody) -> String {
	serializeLedgerLine(
		date: record.civilDate,
		kind: body.kind,
		text: body.text,
		source: body.source,
		wallMs: record.hlc.wallMs
	)
}

private func serializeLedgerLine(
	date: CivilDate,
	kind: LedgerKind,
	text: String,
	source: LedgerSource,
	wallMs: Int64
) -> String {
	let ts = isoFromWallMs(wallMs)
	return
		"{\"ts\":\(JSONValue.string(ts).canonicalDigestInput()),"
		+ "\"date\":\(JSONValue.string(date.rawValue).canonicalDigestInput()),"
		+ "\"kind\":\(JSONValue.string(kind.rawValue).canonicalDigestInput()),"
		+ "\"text\":\(JSONValue.string(text).canonicalDigestInput()),"
		+ "\"source\":\(JSONValue.string(source.rawValue).canonicalDigestInput())}"
}

private func isoFromWallMs(_ wallMs: Int64) -> String {
	let date = Date(timeIntervalSince1970: TimeInterval(wallMs) / 1000)
	var calendar = Calendar(identifier: .gregorian)
	calendar.timeZone = TimeZone(secondsFromGMT: 0)!
	let parts = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
	let millis = wallMs % 1000
	return String(
		format: "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ",
		parts.year!,
		parts.month!,
		parts.day!,
		parts.hour!,
		parts.minute!,
		parts.second!,
		millis
	)
}

private func wallMs(_ date: Date) -> Int64 {
	Int64((date.timeIntervalSince1970 * 1000).rounded(.down))
}

private func historyBodySummary(_ body: String?, query: String?) -> String {
	let text = (body ?? "").trimmingCharacters(in: .whitespacesAndNewlines).replacing(/\s+/, with: " ")
	if text.utf16.count <= MemoryFlushPolicy.historyPreviewChars {
		return text
	}
	let lowered = text.lowercased()
	let match = query.flatMap { lowered.range(of: $0)?.lowerBound }
	if query == nil || match == nil {
		return truncateUtf16Safe(text, maxChars: MemoryFlushPolicy.historyPreviewChars)
	}
	let utf16 = Array(text.utf16)
	let queryUnits = Array((query ?? "").utf16)
	let matchIndex = lowered.utf16.distance(from: lowered.utf16.startIndex, to: match!)
	var start = max(
		0,
		min(
			matchIndex + queryUnits.count / 2 - MemoryFlushPolicy.historyPreviewChars / 2,
			utf16.count - MemoryFlushPolicy.historyPreviewChars
		)
	)
	if start < utf16.count {
		let unit = utf16[start]
		if (0xDC00...0xDFFF).contains(unit), start > 0 {
			start -= 1
		}
	}
	let window = truncateUtf16Safe(
		String(utf16CodeUnits: Array(utf16.suffix(from: start)), count: utf16.count - start),
		maxChars: MemoryFlushPolicy.historyPreviewChars
	)
	let leading = start > 0 ? "…" : ""
	let trailing = start + window.utf16.count < utf16.count ? "…" : ""
	return "\(leading)\(window)\(trailing)"
}

private func wireMessage(from message: ChatMessage) -> WireMessage {
	WireMessage(
		role: message.role == .user ? .user : .assistant,
		content: message.text,
		toolCalls: [],
		toolCallId: nil
	)
}

private func truncateUtf16Safe(_ text: String, maxChars: Int) -> String {
	if maxChars <= 0 {
		return ""
	}
	let units = Array(text.utf16)
	if units.count <= maxChars {
		return text
	}
	var cut = maxChars
	let prev = units[maxChars - 1]
	if (0xD800...0xDBFF).contains(prev), maxChars > 1 {
		cut = maxChars - 1
	}
	return String(utf16CodeUnits: Array(units.prefix(cut)), count: cut)
}

private func trimEnd(_ text: String) -> String {
	var end = text.endIndex
	while end > text.startIndex {
		let prev = text.index(before: end)
		if text[prev].isWhitespace {
			end = prev
		} else {
			break
		}
	}
	return String(text[..<end])
}
