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
		switch self {
		case .en: "English"
		case .es: "Español"
		case .fr: "Français"
		case .it: "Italiano"
		case .de: "Deutsch"
		case .nl: "Nederlands"
		case .da: "Dansk"
		case .sv: "Svenska"
		case .nb: "Norsk bokmål"
		case .fi: "Suomi"
		case .ptPT: "Português (Portugal)"
		case .ptBR: "Português (Brasil)"
		case .pl: "Polski"
		case .ko: "한국어"
		case .ja: "日本語"
		case .zhHans: "简体中文"
		case .zhHant: "繁體中文"
		}
	}

	public var englishName: String {
		switch self {
		case .en: "English"
		case .es: "Spanish"
		case .fr: "French"
		case .it: "Italian"
		case .de: "German"
		case .nl: "Dutch"
		case .da: "Danish"
		case .sv: "Swedish"
		case .nb: "Norwegian Bokmål"
		case .fi: "Finnish"
		case .ptPT: "Portuguese (Portugal)"
		case .ptBR: "Portuguese (Brazil)"
		case .pl: "Polish"
		case .ko: "Korean"
		case .ja: "Japanese"
		case .zhHans: "Simplified Chinese"
		case .zhHant: "Traditional Chinese"
		}
	}

	public var defaultLocale: String {
		switch self {
		case .en: "en-GB"
		case .es: "es-ES"
		case .fr: "fr-FR"
		case .it: "it-IT"
		case .de: "de-DE"
		case .nl: "nl-NL"
		case .da: "da-DK"
		case .sv: "sv-SE"
		case .nb: "nb-NO"
		case .fi: "fi-FI"
		case .ptPT: "pt-PT"
		case .ptBR: "pt-BR"
		case .pl: "pl-PL"
		case .ko: "ko-KR"
		case .ja: "ja-JP"
		case .zhHans: "zh-Hans-CN"
		case .zhHant: "zh-Hant-TW"
		}
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

	public init(language: LanguageTag, source: LanguageSource, locale: String) {
		self.language = language
		self.source = source
		self.locale = locale
	}
}

public struct CatalogKey: Hashable, Sendable, RawRepresentable {
	public let rawValue: String

	public init(rawValue: String) {
		self.rawValue = rawValue
	}
}

public struct Language {
	public static func resolve(
		saved: LanguageTag?,
		messageHint: LanguageTag?,
		surface: LanguageTag?
	) -> LanguageResolution {
		if let saved {
			return LanguageResolution(language: saved, source: .preference, locale: saved.defaultLocale)
		}
		if let messageHint {
			return LanguageResolution(language: messageHint, source: .message, locale: messageHint.defaultLocale)
		}
		if let surface {
			return LanguageResolution(language: surface, source: .surface, locale: surface.defaultLocale)
		}
		return LanguageResolution(language: .en, source: .default, locale: LanguageTag.en.defaultLocale)
	}

	public static func detectMessageLanguage(_ text: String) -> LanguageTag? {
		MessageLanguage.detect(text)
	}

	public static func uiTag(systemLanguages: [String]) -> LanguageTag {
		normalizeLocaleHint(systemLanguages) ?? .en
	}

	public static func normalizeLocaleHint(_ hint: String) -> LanguageTag? {
		normalizeLocaleHint([hint])
	}

	public static func normalizeLocaleHint(_ hints: [String]) -> LanguageTag? {
		for entry in hints {
			for candidate in entry.split(separator: ":", omittingEmptySubsequences: false) {
				let trimmed = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
				let head = trimmed.split(maxSplits: 1, omittingEmptySubsequences: false, whereSeparator: { $0 == "." || $0 == "@" })
					.first.map(String.init) ?? ""
				let normalized = head.replacingOccurrences(of: "_", with: "-").lowercased()
				if normalized.isEmpty || normalized == "c" || normalized == "posix" { continue }
				let pieces = normalized.split(separator: "-", omittingEmptySubsequences: false).map(String.init)
				guard let base = pieces.first else { continue }
				let parts = Array(pieces.dropFirst())
				if base == "no" || base == "nn" { return .nb }
				if base == "pt" { return parts.contains("br") ? .ptBR : .ptPT }
				if base == "zh" {
					if parts.contains("hant") { return .zhHant }
					if parts.contains("hans") { return .zhHans }
					let traditionalRegion = parts.contains("tw") || parts.contains("hk") || parts.contains("mo")
					return traditionalRegion ? .zhHant : .zhHans
				}
				if let tag = LanguageTag(rawValue: base) { return tag }
			}
		}
		return nil
	}
}

public protocol Phrasebook: Sendable {
	func say(_ key: CatalogKey, _ vars: [String: String]) -> String
}

public struct CatalogPhrasebook: Phrasebook {
	public let tag: LanguageTag
	public let locale: String

	public init(tag: LanguageTag, locale: String) {
		self.tag = tag
		self.locale = locale
	}

	public func say(_ key: CatalogKey, _ vars: [String: String] = [:]) -> String {
		let resolved = render(key.rawValue, tag: tag, vars: vars)
		let fallback = render(key.rawValue, tag: .en, vars: vars)
		let text: String
		if resolved.isEmpty || resolved == key.rawValue {
			text = fallback == key.rawValue ? "" : fallback
		} else {
			text = resolved
		}
		return text
	}

	private func render(_ key: String, tag: LanguageTag, vars: [String: String]) -> String {
		guard let template = CatalogStore.template(key: key, tag: tag, count: parsedCount(vars["count"])) else {
			return ""
		}
		return interpolate(template, vars: vars)
	}
}

private enum CatalogStore {
	static let file: XCStringsFile = load()

	static func template(key: String, tag: LanguageTag, count: Int?) -> String? {
		let (lookupKey, forcedForm) = splitPluralKey(key)
		guard let entry = file.strings[lookupKey] else { return nil }
		let localization = entry.localizations[tag.rawValue] ?? entry.localizations[LanguageTag.en.rawValue]
		guard let localization else { return nil }
		if let unit = localization.stringUnit?.value {
			return unit
		}
		guard let forms = localization.variations?.plural else { return nil }
		if let forcedForm, let value = forms[forcedForm]?.stringUnit?.value {
			return value
		}
		if let count {
			let category = pluralCategory(tag: tag, count: count)
			return forms[category]?.stringUnit?.value ?? forms["other"]?.stringUnit?.value
		}
		return forms["other"]?.stringUnit?.value ?? forms.lazy.compactMap(\.value.stringUnit?.value).first
	}

	private static func load() -> XCStringsFile {
		let urls = [
			Bundle.module.url(forResource: "Localizable", withExtension: "xcstrings"),
			Bundle.module.url(forResource: "Localizable", withExtension: "xcstrings", subdirectory: "Resources"),
		]
		guard let url = urls.compactMap({ $0 }).first else {
			return XCStringsFile(strings: [:])
		}
		guard let data = try? Data(contentsOf: url) else {
			return XCStringsFile(strings: [:])
		}
		return (try? JSONDecoder().decode(XCStringsFile.self, from: data)) ?? XCStringsFile(strings: [:])
	}
}

private struct XCStringsFile: Decodable, Sendable {
	var strings: [String: XCStringEntry]
}

private struct XCStringEntry: Decodable, Sendable {
	var localizations: [String: XCLocalization]
}

private struct XCLocalization: Decodable, Sendable {
	var stringUnit: XCStringUnit?
	var variations: XCVariations?
}

private struct XCVariations: Decodable, Sendable {
	var plural: [String: XCPluralForm]?
}

private struct XCPluralForm: Decodable, Sendable {
	var stringUnit: XCStringUnit?
}

private struct XCStringUnit: Decodable, Sendable {
	var value: String
}

private func splitPluralKey(_ key: String) -> (String, String?) {
	let suffix = /_(zero|one|two|few|many|other)$/
	guard let match = key.firstMatch(of: suffix) else { return (key, nil) }
	return (String(key[..<match.range.lowerBound]), String(match.1))
}

private func parsedCount(_ raw: String?) -> Int? {
	guard let raw else { return nil }
	if let value = Int(raw) { return value }
	guard let value = Double(raw) else { return nil }
	if value.rounded(.towardZero) == value { return Int(value) }
	return nil
}

private func pluralCategory(tag: LanguageTag, count: Int) -> String {
	let n = abs(count)
	switch tag {
	case .ja, .ko, .zhHans, .zhHant:
		return "other"
	case .pl:
		if n == 1 { return "one" }
		let mod10 = n % 10
		let mod100 = n % 100
		if (2...4).contains(mod10) && !(12...14).contains(mod100) { return "few" }
		return "many"
	case .fr, .ptBR:
		return n == 0 || n == 1 ? "one" : "other"
	case .en, .es, .it, .de, .nl, .da, .sv, .nb, .fi, .ptPT:
		return n == 1 ? "one" : "other"
	}
}

private func interpolate(_ template: String, vars: [String: String]) -> String {
	let named = template.replacing(/%#@([A-Za-z_][A-Za-z0-9_]*)@/) { match in
		vars[String(match.1)] ?? ""
	}
	return named.replacingOccurrences(of: "%%", with: "%")
}

private enum MessageLanguage {
	static func detect(_ text: String) -> LanguageTag? {
		let sample = clean(text)
		if matches(#"\p{Script=Hangul}"#, sample) { return .ko }
		if matches(#"\p{Script=Hiragana}|\p{Script=Katakana}"#, sample) { return .ja }
		if matches(#"\p{Script=Han}"#, sample) {
			return matches(#"[體訓練這個們時學車騎鐘週強級區間]"#, sample) ? .zhHant : .zhHans
		}
		let tokens = uniqueLatinTokens(sample)
		if tokens.count < 3 { return nil }
		let scores = profiles.compactMap { profile -> (language: LanguageTag, score: Int, matches: Int)? in
			var score = 0
			var matchCount = 0
			for token in tokens where profile.words.contains(token) {
				matchCount += 1
				let shared = profiles.filter { $0.words.contains(token) }.count
				score += shared == 1 ? 3 : 1
			}
			if let marker = diacritics[profile.language], matches(marker, sample) {
				score += 2
			}
			return (profile.language, score, matchCount)
		}
		.sorted { $0.score > $1.score }
		guard let best = scores.first else { return nil }
		let second = scores.dropFirst().first
		if best.matches < 3 || best.score < 6 || best.score - (second?.score ?? 0) < 3 {
			return nil
		}
		if best.language == .ptPT,
		   tokens.contains("você")
		   || tokens.contains("vocês")
		   || matches(#"treino de hoje|\b(?:celular|legal|pedalando)\b"#, sample)
		{
			return .ptBR
		}
		return best.language
	}

	private static func clean(_ text: String) -> String {
		var stripped = replace(#"^\s*(?:/[\w-]+(?:@[\w-]+)?(?:\s+|$))+"#, in: text, with: "")
		stripped = replace(#"```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)"#, in: stripped, with: " ")
		stripped = replace(#"(?:https?://|www\.)\S+"#, in: stripped, with: " ", options: .caseInsensitive)
		stripped = replace(#"\p{N}+"#, in: stripped, with: " ")
		var sample = ""
		var count = 0
		for scalar in stripped.unicodeScalars {
			if count == 512 { break }
			sample.unicodeScalars.append(scalar)
			count += 1
		}
		return sample.precomposedStringWithCanonicalMapping.lowercased()
	}

	private static func uniqueLatinTokens(_ sample: String) -> Set<String> {
		guard let regex = try? NSRegularExpression(pattern: "[\\p{Script=Latin}]+(?:['’][\\p{Script=Latin}]+)?") else {
			return []
		}
		let range = NSRange(sample.startIndex..., in: sample)
		var tokens: Set<String> = []
		regex.enumerateMatches(in: sample, options: [], range: range) { match, _, _ in
			guard let match, let tokenRange = Range(match.range, in: sample) else { return }
			tokens.insert(String(sample[tokenRange]))
		}
		return tokens
	}

	private static let profiles: [(language: LanguageTag, words: Set<String>)] = [
		(.en, words("the and of to in is that for it with as was on be this have from or by but not are my can should would how what after before today tomorrow yesterday ride training feel legs recovery easy week during want need more than also a an i me we you")),
		(.es, words("el la los las de del y en que para por con una un es mi mis al se no me como pero más hoy mañana ayer después antes entrenamiento bicicleta piernas puedo debo quiero hacer durante esta este semana tengo siento estoy suave recuperación")),
		(.fr, words("le la les de des du et en que pour avec une un est mon mes au aux je ne pas sur mais plus aujourd'hui demain hier après avant entraînement vélo jambes peux dois voudrais faire pendant cette ce semaine suis ai mes récupération sortie")),
		(.it, words("il lo la gli le di del della e che per con una un è mio mia al non mi come ma più oggi domani ieri dopo prima allenamento bicicletta gambe posso devo vorrei fare durante questa questo settimana sono ho sento recupero uscita")),
		(.de, words("der die das den dem des und in zu ist dass für mit ein eine mein meine am auf ich nicht mir wie aber mehr heute morgen gestern nach vor training fahrrad beine kann soll möchte machen während diese dieser woche habe fühle erholung fahrt")),
		(.nl, words("de het een en van te dat voor met is mijn op ik niet me hoe maar meer vandaag morgen gisteren na vóór training fiets benen kan moet wil doen tijdens deze dit week heb voel herstel rit zijn als om nog graag rustig omdat")),
		(.da, words("den det de en et og af at er for med min mine på jeg ikke mig hvordan men mere i dag morgen efter før træning cykel ben kan skal vil gøre under denne dette uge har føler restitution tur var som til gerne rolig fordi også træt træne trætte roligt kørt")),
		(.sv, words("den det de en ett och av att är för med min mina på jag inte mig hur men mer idag imorgon igår efter före träning cykel ben kan ska vill göra under denna detta vecka har känner återhämtning tur var som till gärna lugn eftersom också trött")),
		(.nb, words("den det de en et og av at er for med min mine på jeg ikke meg hvordan men mer i dag morgen etter før trening sykkel bein kan skal vil gjøre under denne dette uke har føler restitusjon tur var som til gjerne rolig fordi også sliten trene slitne syklet kjørt")),
		(.fi, words("ja on ei että se kun jos niin kuin mutta tai sekä minun olen oli ovat kanssa tänään huomenna eilen jälkeen ennen harjoitus pyörä jalat voin pitäisi haluan tehdä aikana tämä viikko minulla tuntuu palautuminen lenkki miten voinko paljon vielä nyt jotta olisi olivat haluaisin")),
		(.ptPT, words("o a os as de do da dos das e em que para por com uma um é meu minha meus minhas ao não me como mas mais hoje amanhã ontem depois antes treino bicicleta pernas posso devo quero fazer durante esta este semana tenho sinto estou recuperação pedalada")),
		(.pl, words("i w na z do że nie to jest się jak ale po przed dla czy mój moje mam jestem dzisiaj jutro wczoraj trening rower nogi mogę powinien chcę zrobić podczas ten ta tydzień czuję regeneracja jazda bardzo jeszcze ponieważ żeby oraz był były chciałbym odpoczynek")),
	]

	private static let diacritics: [LanguageTag: String] = [
		.es: #"[ñ¿¡]"#,
		.fr: #"[œç]|[àâêîôû]"#,
		.it: #"[ìòù]"#,
		.de: #"[ßü]"#,
		.da: #"[æø]"#,
		.sv: #"[äö]"#,
		.nb: #"[æø]"#,
		.fi: #"[äö]"#,
		.ptPT: #"[ãõç]"#,
		.pl: #"[ąćęłńśźż]"#,
	]

	private static func words(_ list: String) -> Set<String> {
		Set(list.split(separator: " ").map(String.init))
	}

	private static func matches(_ pattern: String, _ text: String) -> Bool {
		guard let regex = try? NSRegularExpression(pattern: pattern) else { return false }
		let range = NSRange(text.startIndex..., in: text)
		return regex.firstMatch(in: text, options: [], range: range) != nil
	}

	private static func replace(
		_ pattern: String,
		in text: String,
		with template: String,
		options: NSRegularExpression.Options = []
	) -> String {
		guard let regex = try? NSRegularExpression(pattern: pattern, options: options) else { return text }
		let range = NSRange(text.startIndex..., in: text)
		return regex.stringByReplacingMatches(in: text, options: [], range: range, withTemplate: template)
	}
}
