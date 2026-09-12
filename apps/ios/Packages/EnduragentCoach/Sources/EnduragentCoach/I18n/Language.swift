import Foundation

public enum LanguageTag: String, Sendable, CaseIterable {
	case en
	case es
	case fr
	case it
	case de
	case nl
	case da
	case sv
	case nb
	case fi
	case ptPT = "pt-PT"
	case ptBR = "pt-BR"
	case pl
	case ko
	case ja
	case zhHans = "zh-Hans"
	case zhHant = "zh-Hant"

	public var endonym: String {
		fatalError("not implemented")
	}

	public var englishName: String {
		fatalError("not implemented")
	}

	public var defaultLocale: String {
		fatalError("not implemented")
	}

	public static let contractOrder: [LanguageTag] = [
		.en, .es, .fr, .it, .de, .nl, .da, .sv, .nb, .fi, .ptPT, .ptBR, .pl, .ko, .ja, .zhHans, .zhHant,
	]
}

public enum LanguageSource: String, Sendable {
	case preference
	case message
	case surface
	case `default`
}

public struct LanguageResolution: Sendable, Equatable {
	public var language: LanguageTag
	public var source: LanguageSource
	public var locale: String
}

public struct CatalogKey: Hashable, Sendable, RawRepresentable {
	public let rawValue: String

	public init(rawValue: String) {
		self.rawValue = rawValue
	}
}

public enum Catalog {
	public static let englishLeafCount = 2416
	public static let keyCount = 2452
	public static let chatComposerSend = CatalogKey(rawValue: "chat.composer.send")
	public static let coachFallbackStepLimit = CatalogKey(rawValue: "coach.fallback.stepLimit")
	public static let coachConfirmationExecuted = CatalogKey(rawValue: "coach.confirmation.executed")
	public static let coachHistoryResetReply = CatalogKey(rawValue: "coach.history.resetReply")
	public static let commonCancel = CatalogKey(rawValue: "common.cancel")
	public static let archiveTurnCount = CatalogKey(rawValue: "archive.turnCount")
}

public struct Language {
	public static func resolve(
		saved: LanguageTag?,
		messageHint: LanguageTag?,
		surface: LanguageTag?
	) -> LanguageResolution {
		fatalError("not implemented")
	}

	public static func detectMessageLanguage(_ text: String) -> LanguageTag? {
		fatalError("not implemented")
	}

	public static func uiTag(systemLanguages: [String]) -> LanguageTag {
		fatalError("not implemented")
	}
}

public protocol Phrasebook: Sendable {
	func say(_ key: CatalogKey, _ vars: [String: String]) -> String
}

public struct CatalogPhrasebook: Phrasebook {
	public init(tag: LanguageTag, locale: String) {
		fatalError("not implemented")
	}

	public func say(_ key: CatalogKey, _ vars: [String: String] = [:]) -> String {
		fatalError("not implemented")
	}
}
