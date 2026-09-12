import Foundation

public struct ULID: Hashable, Sendable, RawRepresentable {
	public let rawValue: String

	public init?(rawValue: String) {
		let alphabet = CharacterSet(charactersIn: "0123456789ABCDEFGHJKMNPQRSTVWXYZ")
		guard rawValue.count == 26, rawValue.unicodeScalars.allSatisfy({ alphabet.contains($0) }) else {
			return nil
		}
		self.rawValue = rawValue
	}

	public static func generate(at now: Date) -> ULID {
		fatalError("not implemented")
	}
}

public struct DeviceID: Hashable, Sendable, RawRepresentable {
	public let rawValue: String

	public init(rawValue: String) {
		self.rawValue = rawValue
	}

	public init() {
		self.rawValue = UUID().uuidString
	}
}

public struct ChatID: Hashable, Sendable, ExpressibleByStringLiteral {
	public let rawValue: String

	public init?(rawValue: String) {
		guard !rawValue.isEmpty, rawValue != "desktop", !rawValue.hasPrefix("plan:") else {
			return nil
		}
		self.rawValue = rawValue
	}

	public init(stringLiteral value: String) {
		guard let parsed = ChatID(rawValue: value) else {
			fatalError("invalid chat id")
		}
		self = parsed
	}

	public static let main: ChatID = "main"
}

public struct Nonce: Hashable, Sendable, RawRepresentable {
	public let rawValue: UUID

	public init(rawValue: UUID) {
		self.rawValue = rawValue
	}

	public init() {
		self.rawValue = UUID()
	}
}

public struct CivilDate: Hashable, Sendable, Comparable, ExpressibleByStringLiteral, CustomStringConvertible {
	public let rawValue: String

	public init?(rawValue: String) {
		guard Self.isRealDateKey(rawValue) else { return nil }
		self.rawValue = rawValue
	}

	public init(stringLiteral value: String) {
		guard let parsed = CivilDate(rawValue: value) else {
			fatalError("invalid civil date")
		}
		self = parsed
	}

	public var description: String { rawValue }

	public static func < (lhs: CivilDate, rhs: CivilDate) -> Bool {
		lhs.rawValue < rhs.rawValue
	}

	public static func isRealDateKey(_ value: String) -> Bool {
		let formatter = DateFormatter()
		formatter.calendar = Calendar(identifier: .gregorian)
		formatter.locale = Locale(identifier: "en_US_POSIX")
		formatter.timeZone = TimeZone(secondsFromGMT: 0)
		formatter.dateFormat = "yyyy-MM-dd"
		formatter.isLenient = false
		return formatter.date(from: value) != nil
	}

	public func adding(days: Int) -> CivilDate {
		fatalError("not implemented")
	}
}

public struct DateKey: Hashable, Sendable, Comparable {
	public let rawValue: Int

	public init?(rawValue: Int) {
		guard rawValue >= 1000_01_01, rawValue <= 9999_12_31 else { return nil }
		self.rawValue = rawValue
	}

	public static func from(_ date: CivilDate) -> DateKey {
		fatalError("not implemented")
	}

	public var civil: CivilDate {
		fatalError("not implemented")
	}

	public static func < (lhs: DateKey, rhs: DateKey) -> Bool {
		lhs.rawValue < rhs.rawValue
	}
}

public struct IANATimeZone: Hashable, Sendable {
	public let identifier: String

	public init?(identifier: String) {
		guard TimeZone(identifier: identifier) != nil else { return nil }
		self.identifier = identifier
	}

	public var timeZone: TimeZone {
		TimeZone(identifier: identifier) ?? .gmt
	}
}

public enum SportID: String, Sendable {
	case cycling
}

public enum JSONValue: Sendable, Equatable {
	case null
	case bool(Bool)
	case number(Double)
	case string(String)
	case array([JSONValue])
	case object([String: JSONValue])

	public static func parse(_ raw: String) throws -> JSONValue {
		fatalError("not implemented")
	}

	public func canonicalDigestInput() -> String {
		fatalError("not implemented")
	}
}

public func canonicalJSON(_ value: JSONValue) -> String {
	fatalError("not implemented")
}

public func sha256Hex(_ utf8: String) -> String {
	fatalError("not implemented")
}

public func estimateTokens(_ text: String) -> Int {
	fatalError("not implemented")
}
