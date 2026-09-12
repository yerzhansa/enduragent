import Foundation

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

public final class InMemoryRecordLog: RecordLog, @unchecked Sendable {
	public let deviceId: DeviceID

	public init(deviceId: DeviceID = DeviceID()) {
		self.deviceId = deviceId
	}

	public func append(_ record: AthleteRecord) async throws {
		fatalError("not implemented")
	}

	public func fetch(_ query: RecordQuery) async throws -> [AthleteRecord] {
		fatalError("not implemented")
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
