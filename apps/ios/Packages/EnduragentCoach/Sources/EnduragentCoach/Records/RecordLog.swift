import Foundation
import SwiftData
import Synchronization

public struct RecordQuery: Sendable, Equatable {
	public var kinds: Set<RecordKind>
	public var chatId: ChatID?
	public var from: CivilDate?
	public var to: CivilDate?
	public var deviceLocalOnly: Bool

	public init(
		kinds: Set<RecordKind>,
		chatId: ChatID? = nil,
		from: CivilDate? = nil,
		to: CivilDate? = nil,
		deviceLocalOnly: Bool = false
	) {
		self.kinds = kinds
		self.chatId = chatId
		self.from = from
		self.to = to
		self.deviceLocalOnly = deviceLocalOnly
	}
}

public protocol RecordLog: Sendable {
	var deviceId: DeviceID { get }

	func append(_ record: AthleteRecord) async throws
	func fetch(_ query: RecordQuery) async throws -> [AthleteRecord]
}

public struct ForeignDeviceLocalRecord: Error, Sendable, Equatable {
	public var recordDeviceId: DeviceID
	public var logDeviceId: DeviceID

	public init(recordDeviceId: DeviceID, logDeviceId: DeviceID) {
		self.recordDeviceId = recordDeviceId
		self.logDeviceId = logDeviceId
	}
}

public struct MixedRecordLocalityQuery: Error, Sendable, Equatable {
	public var kinds: Set<RecordKind>

	public init(kinds: Set<RecordKind>) {
		self.kinds = kinds
	}
}

public struct RecordDecodeFailure: Error, Sendable, Equatable {
	public var reason: String

	public init(reason: String) {
		self.reason = reason
	}
}

public final class InMemoryRecordLog: RecordLog, @unchecked Sendable {
	public let deviceId: DeviceID
	private let records = Mutex<[AthleteRecord]>([])

	public init(deviceId: DeviceID = DeviceID()) {
		self.deviceId = deviceId
	}

	public func append(_ record: AthleteRecord) async throws {
		if record.locality == .deviceLocal, record.deviceId != deviceId {
			throw ForeignDeviceLocalRecord(recordDeviceId: record.deviceId, logDeviceId: deviceId)
		}
		records.withLock { $0.append(record) }
	}

	public func fetch(_ query: RecordQuery) async throws -> [AthleteRecord] {
		records.withLock { $0.filter { recordMatches($0, query, logDeviceId: deviceId) } }
	}
}

public struct SwiftDataRecordLog: RecordLog {
	public let deviceId: DeviceID
	private let synced: ModelContainer
	private let local: ModelContainer

	public init(deviceId: DeviceID, synced: ModelContainerHandle, local: ModelContainerHandle) {
		self.deviceId = deviceId
		self.synced = synced.container
		self.local = local.container
	}

	public func append(_ record: AthleteRecord) async throws {
		if record.locality == .deviceLocal, record.deviceId != deviceId {
			throw ForeignDeviceLocalRecord(recordDeviceId: record.deviceId, logDeviceId: deviceId)
		}
		let context = ModelContext(container(for: record.locality))
		context.insert(try StoredAthleteRecord(record: record))
		try context.save()
	}

	public func fetch(_ query: RecordQuery) async throws -> [AthleteRecord] {
		if query.kinds.isEmpty {
			return []
		}
		let localities = Set(query.kinds.map(\.locality))
		guard localities.count == 1, let locality = localities.first else {
			throw MixedRecordLocalityQuery(kinds: query.kinds)
		}
		let context = ModelContext(container(for: locality))
		let rows = try context.fetch(FetchDescriptor<StoredAthleteRecord>())
		return try rows.map { try $0.athleteRecord() }
			.filter { recordMatches($0, query, logDeviceId: deviceId) }
			.sorted { $0.hlc < $1.hlc }
	}

	private func container(for locality: RecordLocality) -> ModelContainer {
		switch locality {
		case .synced: return synced
		case .deviceLocal: return local
		}
	}
}

public struct ModelContainerHandle: Sendable {
	let container: ModelContainer
}

@Model
final class StoredAthleteRecord {
	var ulid: String = ""
	var deviceId: String = ""
	var hlcWallMs: Int64 = 0
	var hlcLogical: Int64 = 0
	var hlcDeviceId: String = ""
	var timeZone: String = ""
	var civilDate: String = ""
	var kind: String = ""
	var body: Data = Data()

	init(record: AthleteRecord) throws {
		self.ulid = record.ulid.rawValue
		self.deviceId = record.deviceId.rawValue
		self.hlcWallMs = record.hlc.wallMs
		self.hlcLogical = Int64(record.hlc.logical)
		self.hlcDeviceId = record.hlc.deviceId.rawValue
		self.timeZone = record.timeZone.identifier
		self.civilDate = record.civilDate.rawValue
		self.kind = record.body.kind.rawValue
		self.body = try encodeRecordBody(record.body)
	}

	func athleteRecord() throws -> AthleteRecord {
		guard let ulid = ULID(rawValue: ulid) else {
			throw RecordDecodeFailure(reason: "ulid")
		}
		guard let timeZone = IANATimeZone(identifier: timeZone) else {
			throw RecordDecodeFailure(reason: "timeZone")
		}
		guard let civilDate = CivilDate(rawValue: civilDate) else {
			throw RecordDecodeFailure(reason: "civilDate")
		}
		let body = try decodeRecordBody(body)
		if body.kind.rawValue != kind {
			throw RecordDecodeFailure(reason: "kind")
		}
		return AthleteRecord(
			ulid: ulid,
			deviceId: DeviceID(rawValue: deviceId),
			hlc: HybridLogicalClock(
				wallMs: hlcWallMs,
				logical: UInt32(hlcLogical),
				deviceId: DeviceID(rawValue: hlcDeviceId)
			),
			timeZone: timeZone,
			civilDate: civilDate,
			body: body
		)
	}
}

func recordMatches(_ record: AthleteRecord, _ query: RecordQuery, logDeviceId: DeviceID) -> Bool {
	guard query.kinds.contains(record.body.kind) else { return false }
	if record.locality == .deviceLocal, record.deviceId != logDeviceId {
		return false
	}
	if query.deviceLocalOnly, record.deviceId != logDeviceId {
		return false
	}
	if let from = query.from, record.civilDate < from {
		return false
	}
	if let to = query.to, record.civilDate > to {
		return false
	}
	if let chatId = query.chatId {
		guard let recordChatId = recordChatId(record.body), recordChatId == chatId else {
			return false
		}
	}
	return true
}

func recordChatId(_ body: RecordBody) -> ChatID? {
	switch body {
	case .userMessage(let body): return body.chatId
	case .assistantMessage(let body): return body.chatId
	case .windowStart(let body): return body.chatId
	case .compactionSummary(let body): return body.chatId
	case .pendingProposal(let body): return body.chatId
	case .proposalCleared(let body): return body.chatId
	case .flushPending(let body): return body.chatId
	default: return nil
	}
}

private struct UserMessagePayload: Codable {
	var chatId: String
	var athleteText: String
	var timedText: String
	var slash: String?
}

private struct AssistantMessagePayload: Codable {
	var chatId: String
	var text: String
	var templateHash: String
	var assembledHash: String
}

private struct WindowStartPayload: Codable {
	var chatId: String
	var firstIncludedUlid: String
}

private struct CompactionSummaryPayload: Codable {
	var chatId: String
	var markdown: String
}

private struct MemorySectionPayload: Codable {
	var name: String
	var content: String
}

private struct DailyNotePayload: Codable {
	var note: String
}

private struct LedgerEventPayload: Codable {
	var kind: String
	var text: String
	var source: String
}

private struct JournalPayload: Codable {
	var op: String
	var preview: String
}

private struct ProvenancePayload: Codable {
	var key: String
	var garmin: Bool
	var nonGarmin: Bool
	var unknown: Bool
	var contentSha256: String
}

private struct DurationPayload: Codable {
	var value: Double
	var unit: String
}

private struct PowerPayload: Codable {
	var kind: String
	var value: Double?
	var low: Double?
	var high: Double?
}

private struct CadencePayload: Codable {
	var value: Int?
	var low: Int?
	var high: Int?
}

private struct SimpleStepPayload: Codable {
	var type: String
	var duration: DurationPayload
	var power: PowerPayload?
	var cadence: CadencePayload?
	var label: String?
}

private struct SetStepPayload: Codable {
	var repeatCount: Int
	var interval: SimpleStepPayload
	var recovery: SimpleStepPayload
}

private enum StepPayload: Codable {
	case simple(SimpleStepPayload)
	case set(SetStepPayload)
}

private struct WorkoutPayload: Codable {
	var name: String
	var steps: [StepPayload]
}

private enum GatedToolInputPayload: Codable {
	case createWorkout(date: String, workout: WorkoutPayload)
	case createStrengthWorkout(date: String, name: String, description: String)
	case deleteWorkout(eventId: Int)
	case updateWorkout(eventId: Int, date: String?, name: String?, description: String?)
	case planSave(name: String, primaryGoal: String?, totalWeeks: Int?, status: String?)
}

private struct ProposalPayload: Codable {
	var chatId: String
	var nonce: UUID
	var tool: String
	var toolInput: GatedToolInputPayload
	var summary: String
	var description: String
	var expiresAt: TimeInterval
}

private struct ProposalClearedPayload: Codable {
	var chatId: String
	var nonce: UUID
	var reason: String
}

private struct FlushPendingPayload: Codable {
	var chatId: String
	var trigger: String
	var messageUlids: [String]
}

private struct CoachReplyLanguagePayload: Codable {
	var tag: String?
}

private struct PlanningDevicePayload: Codable {
	var planningDeviceId: String
	var planUlid: String
	var activatedAt: TimeInterval
}

private struct JSONValuePayload: Codable {
	var value: JSONValue

	init(_ value: JSONValue) {
		self.value = value
	}

	init(from decoder: Decoder) throws {
		let container = try decoder.singleValueContainer()
		if container.decodeNil() {
			value = .null
			return
		}
		if let flag = try? container.decode(Bool.self) {
			value = .bool(flag)
			return
		}
		if let number = try? container.decode(Double.self) {
			value = .number(number)
			return
		}
		if let string = try? container.decode(String.self) {
			value = .string(string)
			return
		}
		if let items = try? container.decode([JSONValuePayload].self) {
			value = .array(items.map(\.value))
			return
		}
		if let fields = try? container.decode([String: JSONValuePayload].self) {
			value = .object(fields.mapValues(\.value))
			return
		}
		throw RecordDecodeFailure(reason: "json")
	}

	func encode(to encoder: Encoder) throws {
		var container = encoder.singleValueContainer()
		switch value {
		case .null:
			try container.encodeNil()
		case .bool(let flag):
			try container.encode(flag)
		case .number(let number):
			try container.encode(number)
		case .string(let string):
			try container.encode(string)
		case .array(let items):
			try container.encode(items.map(JSONValuePayload.init))
		case .object(let fields):
			try container.encode(fields.mapValues(JSONValuePayload.init))
		}
	}
}

private struct PlanningCommandPayload: Codable {
	var commandName: String
	var commandId: String
	var requestDigest: String
	var status: String
	var result: JSONValuePayload?
}

private struct PlanRevisionPayload: Codable {
	var planUlid: String
	var version: Int
	var status: String
	var snapshot: JSONValuePayload
}

private struct MirrorJobPayload: Codable {
	var planUlid: String
	var kind: String
	var windowStart: Int
	var windowEnd: Int
	var failureCount: Int
}

private struct WorkoutMatchPayload: Codable {
	var planWorkoutId: String
	var activityId: String
	var decision: String
}

private struct WorkoutDriftPayload: Codable {
	var planWorkoutId: String
	var askedAt: TimeInterval
}

private enum BodyEnvelope: Codable {
	case userMessage(UserMessagePayload)
	case assistantMessage(AssistantMessagePayload)
	case windowStart(WindowStartPayload)
	case compactionSummary(CompactionSummaryPayload)
	case memorySection(MemorySectionPayload)
	case dailyNote(DailyNotePayload)
	case ledgerEvent(LedgerEventPayload)
	case journal(JournalPayload)
	case provenance(ProvenancePayload)
	case pendingProposal(ProposalPayload)
	case proposalCleared(ProposalClearedPayload)
	case flushPending(FlushPendingPayload)
	case coachReplyLanguage(CoachReplyLanguagePayload)
	case planningDevice(PlanningDevicePayload)
	case planningCommand(PlanningCommandPayload)
	case planRevision(PlanRevisionPayload)
	case mirrorJob(MirrorJobPayload)
	case workoutMatch(WorkoutMatchPayload)
	case workoutDrift(WorkoutDriftPayload)
}

private func encodeRecordBody(_ body: RecordBody) throws -> Data {
	let encoder = JSONEncoder()
	encoder.outputFormatting = [.sortedKeys]
	return try encoder.encode(BodyEnvelope(body))
}

private func decodeRecordBody(_ data: Data) throws -> RecordBody {
	try JSONDecoder().decode(BodyEnvelope.self, from: data).recordBody()
}

extension BodyEnvelope {
	init(_ body: RecordBody) {
		switch body {
		case .userMessage(let value):
			self = .userMessage(
				UserMessagePayload(
					chatId: value.chatId.rawValue,
					athleteText: value.athleteText,
					timedText: value.timedText,
					slash: value.slash?.rawValue
				)
			)
		case .assistantMessage(let value):
			self = .assistantMessage(
				AssistantMessagePayload(
					chatId: value.chatId.rawValue,
					text: value.text,
					templateHash: value.templateHash,
					assembledHash: value.assembledHash
				)
			)
		case .windowStart(let value):
			self = .windowStart(
				WindowStartPayload(chatId: value.chatId.rawValue, firstIncludedUlid: value.firstIncludedUlid.rawValue)
			)
		case .compactionSummary(let value):
			self = .compactionSummary(
				CompactionSummaryPayload(chatId: value.chatId.rawValue, markdown: value.markdown)
			)
		case .memorySection(let value):
			self = .memorySection(MemorySectionPayload(name: value.name.rawValue, content: value.content))
		case .dailyNote(let value):
			self = .dailyNote(DailyNotePayload(note: value.note))
		case .ledgerEvent(let value):
			self = .ledgerEvent(
				LedgerEventPayload(kind: value.kind.rawValue, text: value.text, source: value.source.rawValue)
			)
		case .journal(let value):
			self = .journal(JournalPayload(op: value.op.rawValue, preview: value.preview))
		case .provenance(let value):
			self = .provenance(
				ProvenancePayload(
					key: value.key,
					garmin: value.garmin,
					nonGarmin: value.nonGarmin,
					unknown: value.unknown,
					contentSha256: value.contentSha256
				)
			)
		case .pendingProposal(let value):
			self = .pendingProposal(
				ProposalPayload(
					chatId: value.chatId.rawValue,
					nonce: value.nonce.rawValue,
					tool: value.tool.rawValue,
					toolInput: GatedToolInputPayload(value.toolInput),
					summary: value.summary,
					description: value.description,
					expiresAt: value.expiresAt.timeIntervalSince1970
				)
			)
		case .proposalCleared(let value):
			self = .proposalCleared(
				ProposalClearedPayload(
					chatId: value.chatId.rawValue,
					nonce: value.nonce.rawValue,
					reason: value.reason.rawValue
				)
			)
		case .flushPending(let value):
			self = .flushPending(
				FlushPendingPayload(
					chatId: value.chatId.rawValue,
					trigger: value.trigger.rawValue,
					messageUlids: value.messageUlids.map(\.rawValue)
				)
			)
		case .coachReplyLanguage(let value):
			self = .coachReplyLanguage(CoachReplyLanguagePayload(tag: value.tag?.rawValue))
		case .planningDevice(let value):
			self = .planningDevice(
				PlanningDevicePayload(
					planningDeviceId: value.planningDeviceId.rawValue,
					planUlid: value.planUlid.rawValue,
					activatedAt: value.activatedAt.timeIntervalSince1970
				)
			)
		case .planningCommand(let value):
			self = .planningCommand(
				PlanningCommandPayload(
					commandName: value.commandName.rawValue,
					commandId: value.commandId,
					requestDigest: value.requestDigest,
					status: value.status.rawValue,
					result: value.result.map(JSONValuePayload.init)
				)
			)
		case .planRevision(let value):
			self = .planRevision(
				PlanRevisionPayload(
					planUlid: value.planUlid.rawValue,
					version: value.version,
					status: value.status.rawValue,
					snapshot: JSONValuePayload(value.snapshot)
				)
			)
		case .mirrorJob(let value):
			self = .mirrorJob(
				MirrorJobPayload(
					planUlid: value.planUlid.rawValue,
					kind: value.kind.rawValue,
					windowStart: value.windowStart.rawValue,
					windowEnd: value.windowEnd.rawValue,
					failureCount: value.failureCount
				)
			)
		case .workoutMatch(let value):
			self = .workoutMatch(
				WorkoutMatchPayload(
					planWorkoutId: value.planWorkoutId.rawValue,
					activityId: value.activityId,
					decision: value.decision.rawValue
				)
			)
		case .workoutDrift(let value):
			self = .workoutDrift(
				WorkoutDriftPayload(
					planWorkoutId: value.planWorkoutId.rawValue,
					askedAt: value.askedAt.timeIntervalSince1970
				)
			)
		}
	}

	func recordBody() throws -> RecordBody {
		switch self {
		case .userMessage(let payload):
			return .userMessage(
				UserMessageBody(
					chatId: try decodeChatID(payload.chatId),
					athleteText: payload.athleteText,
					timedText: payload.timedText,
					slash: try payload.slash.map(decodeSlash)
				)
			)
		case .assistantMessage(let payload):
			return .assistantMessage(
				AssistantMessageBody(
					chatId: try decodeChatID(payload.chatId),
					text: payload.text,
					templateHash: payload.templateHash,
					assembledHash: payload.assembledHash
				)
			)
		case .windowStart(let payload):
			return .windowStart(
				WindowStartBody(chatId: try decodeChatID(payload.chatId), firstIncludedUlid: try decodeULID(payload.firstIncludedUlid))
			)
		case .compactionSummary(let payload):
			return .compactionSummary(
				CompactionSummaryBody(chatId: try decodeChatID(payload.chatId), markdown: payload.markdown)
			)
		case .memorySection(let payload):
			return .memorySection(
				MemorySectionBody(name: SectionName(rawValue: payload.name), content: payload.content)
			)
		case .dailyNote(let payload):
			return .dailyNote(DailyNoteBody(note: payload.note))
		case .ledgerEvent(let payload):
			guard let kind = LedgerKind(rawValue: payload.kind), let source = LedgerSource(rawValue: payload.source) else {
				throw RecordDecodeFailure(reason: "ledger")
			}
			return .ledgerEvent(LedgerEventBody(kind: kind, text: payload.text, source: source))
		case .journal(let payload):
			guard let op = JournalOp(rawValue: payload.op) else {
				throw RecordDecodeFailure(reason: "journal")
			}
			return .journal(JournalBody(op: op, preview: payload.preview))
		case .provenance(let payload):
			return .provenance(
				ProvenanceBody(
					key: payload.key,
					garmin: payload.garmin,
					nonGarmin: payload.nonGarmin,
					unknown: payload.unknown,
					contentSha256: payload.contentSha256
				)
			)
		case .pendingProposal(let payload):
			guard let tool = GatedToolName(rawValue: payload.tool) else {
				throw RecordDecodeFailure(reason: "tool")
			}
			return .pendingProposal(
				ProposalBody(
					chatId: try decodeChatID(payload.chatId),
					nonce: Nonce(rawValue: payload.nonce),
					tool: tool,
					toolInput: try payload.toolInput.gatedToolInput(),
					summary: payload.summary,
					description: payload.description,
					expiresAt: Date(timeIntervalSince1970: payload.expiresAt)
				)
			)
		case .proposalCleared(let payload):
			guard let reason = ProposalClearReason(rawValue: payload.reason) else {
				throw RecordDecodeFailure(reason: "clear")
			}
			return .proposalCleared(
				ProposalClearedBody(
					chatId: try decodeChatID(payload.chatId),
					nonce: Nonce(rawValue: payload.nonce),
					reason: reason
				)
			)
		case .flushPending(let payload):
			guard let trigger = FlushTrigger(rawValue: payload.trigger) else {
				throw RecordDecodeFailure(reason: "flush")
			}
			return .flushPending(
				FlushPendingBody(
					chatId: try decodeChatID(payload.chatId),
					trigger: trigger,
					messageUlids: try payload.messageUlids.map(decodeULID)
				)
			)
		case .coachReplyLanguage(let payload):
			let tag: LanguageTag?
			if let raw = payload.tag {
				guard let parsed = LanguageTag(rawValue: raw) else {
					throw RecordDecodeFailure(reason: "language")
				}
				tag = parsed
			} else {
				tag = nil
			}
			return .coachReplyLanguage(CoachReplyLanguageBody(tag: tag))
		case .planningDevice(let payload):
			return .planningDevice(
				PlanningDeviceBody(
					planningDeviceId: DeviceID(rawValue: payload.planningDeviceId),
					planUlid: try decodeULID(payload.planUlid),
					activatedAt: Date(timeIntervalSince1970: payload.activatedAt)
				)
			)
		case .planningCommand(let payload):
			guard let name = PlanningCommandName(rawValue: payload.commandName),
				  let status = PlanningCommandStatus(rawValue: payload.status)
			else {
				throw RecordDecodeFailure(reason: "planningCommand")
			}
			return .planningCommand(
				PlanningCommandBody(
					commandName: name,
					commandId: payload.commandId,
					requestDigest: payload.requestDigest,
					status: status,
					result: payload.result?.value
				)
			)
		case .planRevision(let payload):
			guard let status = PlanStatus(rawValue: payload.status) else {
				throw RecordDecodeFailure(reason: "planStatus")
			}
			return .planRevision(
				PlanRevisionBody(
					planUlid: try decodeULID(payload.planUlid),
					version: payload.version,
					status: status,
					snapshot: payload.snapshot.value
				)
			)
		case .mirrorJob(let payload):
			guard let kind = MirrorJobKind(rawValue: payload.kind),
				  let windowStart = DateKey(rawValue: payload.windowStart),
				  let windowEnd = DateKey(rawValue: payload.windowEnd)
			else {
				throw RecordDecodeFailure(reason: "mirror")
			}
			return .mirrorJob(
				MirrorJobBody(
					planUlid: try decodeULID(payload.planUlid),
					kind: kind,
					windowStart: windowStart,
					windowEnd: windowEnd,
					failureCount: payload.failureCount
				)
			)
		case .workoutMatch(let payload):
			guard let decision = MatchDecision(rawValue: payload.decision) else {
				throw RecordDecodeFailure(reason: "match")
			}
			return .workoutMatch(
				WorkoutMatchBody(
					planWorkoutId: try decodeULID(payload.planWorkoutId),
					activityId: payload.activityId,
					decision: decision
				)
			)
		case .workoutDrift(let payload):
			return .workoutDrift(
				WorkoutDriftBody(
					planWorkoutId: try decodeULID(payload.planWorkoutId),
					askedAt: Date(timeIntervalSince1970: payload.askedAt)
				)
			)
		}
	}
}

extension GatedToolInputPayload {
	init(_ input: GatedToolInput) {
		switch input {
		case .createWorkout(let date, let workout):
			self = .createWorkout(date: date.rawValue, workout: WorkoutPayload(workout))
		case .createStrengthWorkout(let date, let name, let description):
			self = .createStrengthWorkout(date: date.rawValue, name: name, description: description)
		case .deleteWorkout(let eventId):
			self = .deleteWorkout(eventId: eventId.rawValue)
		case .updateWorkout(let input):
			self = .updateWorkout(
				eventId: input.eventId.rawValue,
				date: input.date?.rawValue,
				name: input.name,
				description: input.description
			)
		case .planSave(let headline):
			self = .planSave(
				name: headline.name,
				primaryGoal: headline.primaryGoal,
				totalWeeks: headline.totalWeeks,
				status: headline.status?.rawValue
			)
		}
	}

	func gatedToolInput() throws -> GatedToolInput {
		switch self {
		case .createWorkout(let date, let workout):
			return .createWorkout(date: try decodeCivilDate(date), workout: try workout.workout())
		case .createStrengthWorkout(let date, let name, let description):
			return .createStrengthWorkout(date: try decodeCivilDate(date), name: name, description: description)
		case .deleteWorkout(let eventId):
			return .deleteWorkout(eventId: EventID(rawValue: eventId))
		case .updateWorkout(let eventId, let date, let name, let description):
			return .updateWorkout(
				UpdateWorkoutInput(
					eventId: EventID(rawValue: eventId),
					date: try date.map(decodeCivilDate),
					name: name,
					description: description
				)
			)
		case .planSave(let name, let primaryGoal, let totalWeeks, let status):
			let parsedStatus: PlanStatus?
			if let status {
				guard let value = PlanStatus(rawValue: status) else {
					throw RecordDecodeFailure(reason: "planSave")
				}
				parsedStatus = value
			} else {
				parsedStatus = nil
			}
			return .planSave(
				PlanHeadline(name: name, primaryGoal: primaryGoal, totalWeeks: totalWeeks, status: parsedStatus)
			)
		}
	}
}

extension WorkoutPayload {
	init(_ workout: IntervalsWorkoutInput) {
		self.init(name: workout.name, steps: workout.steps.map(StepPayload.init))
	}

	func workout() throws -> IntervalsWorkoutInput {
		IntervalsWorkoutInput(name: name, steps: try steps.map { try $0.step() })
	}
}

extension StepPayload {
	init(_ step: WorkoutStep) {
		switch step {
		case .simple(let simple):
			self = .simple(SimpleStepPayload(simple))
		case .set(let set):
			self = .set(SetStepPayload(set))
		}
	}

	func step() throws -> WorkoutStep {
		switch self {
		case .simple(let payload):
			return .simple(try payload.simpleStep())
		case .set(let payload):
			return .set(try payload.setStep())
		}
	}
}

extension SimpleStepPayload {
	init(_ step: SimpleStep) {
		self.init(
			type: step.type.rawValue,
			duration: DurationPayload(value: step.duration.value, unit: step.duration.unit.rawValue),
			power: step.power.map {
				PowerPayload(kind: $0.kind.rawValue, value: $0.value, low: $0.low, high: $0.high)
			},
			cadence: step.cadence.map {
				CadencePayload(value: $0.value, low: $0.low, high: $0.high)
			},
			label: step.label
		)
	}

	func simpleStep() throws -> SimpleStep {
		guard let type = StepType(rawValue: type), let unit = DurationInput.Unit(rawValue: duration.unit) else {
			throw RecordDecodeFailure(reason: "step")
		}
		let power: PowerTarget?
		if let payload = self.power {
			guard let kind = PowerKind(rawValue: payload.kind) else {
				throw RecordDecodeFailure(reason: "power")
			}
			power = PowerTarget(kind: kind, value: payload.value, low: payload.low, high: payload.high)
		} else {
			power = nil
		}
		return SimpleStep(
			type: type,
			duration: DurationInput(value: duration.value, unit: unit),
			power: power,
			cadence: cadence.map { CadenceTarget(value: $0.value, low: $0.low, high: $0.high) },
			label: label
		)
	}
}

extension SetStepPayload {
	init(_ step: SetStep) {
		self.init(
			repeatCount: step.repeatCount,
			interval: SimpleStepPayload(step.interval),
			recovery: SimpleStepPayload(step.recovery)
		)
	}

	func setStep() throws -> SetStep {
		SetStep(repeatCount: repeatCount, interval: try interval.simpleStep(), recovery: try recovery.simpleStep())
	}
}

private func decodeChatID(_ raw: String) throws -> ChatID {
	guard let value = ChatID(rawValue: raw) else {
		throw RecordDecodeFailure(reason: "chatId")
	}
	return value
}

private func decodeULID(_ raw: String) throws -> ULID {
	guard let value = ULID(rawValue: raw) else {
		throw RecordDecodeFailure(reason: "ulid")
	}
	return value
}

private func decodeCivilDate(_ raw: String) throws -> CivilDate {
	guard let value = CivilDate(rawValue: raw) else {
		throw RecordDecodeFailure(reason: "civilDate")
	}
	return value
}

private func decodeSlash(_ raw: String) throws -> SlashCommand {
	guard let value = SlashCommand(rawValue: raw) else {
		throw RecordDecodeFailure(reason: "slash")
	}
	return value
}

extension RecordKind: CaseIterable {
	public static var allCases: [RecordKind] {
		[
			.userMessage, .assistantMessage, .windowStart, .compactionSummary, .memorySection, .dailyNote,
			.ledgerEvent, .journal, .provenance, .pendingProposal, .proposalCleared, .flushPending,
			.coachReplyLanguage, .planningDevice, .planningCommand, .planRevision, .mirrorJob, .workoutMatch,
			.workoutDrift,
		]
	}
}

public enum RecordLogSamples {
	public static func userMessage(text: String) -> RecordBody {
		.userMessage(UserMessageBody(chatId: .main, athleteText: text, timedText: text, slash: nil))
	}

	public static func pendingProposal(expiresAt: Date) -> RecordBody {
		.pendingProposal(
			ProposalBody(
				chatId: .main,
				nonce: Nonce(),
				tool: .intervalsCreateStrengthWorkout,
				toolInput: .createStrengthWorkout(date: "1998-06-13", name: "Core", description: "20 min"),
				summary: "Core session",
				description: "Core · 20 min",
				expiresAt: expiresAt
			)
		)
	}

	public static func record(deviceId: DeviceID, now: Date, body: RecordBody) -> AthleteRecord {
		AthleteRecord(
			ulid: ULID.generate(at: now),
			deviceId: deviceId,
			hlc: HybridLogicalClock.tick(now: now, deviceId: deviceId, last: nil),
			timeZone: IANATimeZone(identifier: TimeZone.current.identifier) ?? IANATimeZone(identifier: "GMT")!,
			civilDate: sampleCivilDate(now),
			body: body
		)
	}
}

private func sampleCivilDate(_ now: Date) -> CivilDate {
	let formatter = DateFormatter()
	formatter.calendar = Calendar(identifier: .gregorian)
	formatter.locale = Locale(identifier: "en_US_POSIX")
	formatter.timeZone = .current
	formatter.dateFormat = "yyyy-MM-dd"
	return CivilDate(rawValue: formatter.string(from: now))!
}
