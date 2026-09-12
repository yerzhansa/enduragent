import Foundation
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
		records.withLock { $0.filter { matches($0, query) } }
	}

	private func matches(_ record: AthleteRecord, _ query: RecordQuery) -> Bool {
		guard query.kinds.contains(record.body.kind) else { return false }
		if record.locality == .deviceLocal, record.deviceId != deviceId {
			return false
		}
		if query.deviceLocalOnly, record.deviceId != deviceId {
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
}

private func recordChatId(_ body: RecordBody) -> ChatID? {
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

public struct SwiftDataRecordLog: RecordLog {
	public let deviceId: DeviceID

	public init(deviceId: DeviceID, synced: ModelContainerHandle, local: ModelContainerHandle) {
		fatalError("not implemented")
	}

	public func append(_ record: AthleteRecord) async throws {
		fatalError("not implemented")
	}

	public func fetch(_ query: RecordQuery) async throws -> [AthleteRecord] {
		fatalError("not implemented")
	}
}

public struct ModelContainerHandle: Sendable {
	public init() {
		fatalError("not implemented")
	}
}
