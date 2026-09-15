import Foundation
import Testing
@testable import EnduragentCoach

@Suite struct LanguageTests {
	@Test func registryMatchesSeventeenTagTable() {
		let expected: [(LanguageTag, String, String, String)] = [
			(.en, "English", "English", "en-GB"),
			(.es, "Español", "Spanish", "es-ES"),
			(.fr, "Français", "French", "fr-FR"),
			(.it, "Italiano", "Italian", "it-IT"),
			(.de, "Deutsch", "German", "de-DE"),
			(.nl, "Nederlands", "Dutch", "nl-NL"),
			(.da, "Dansk", "Danish", "da-DK"),
			(.sv, "Svenska", "Swedish", "sv-SE"),
			(.nb, "Norsk bokmål", "Norwegian Bokmål", "nb-NO"),
			(.fi, "Suomi", "Finnish", "fi-FI"),
			(.ptPT, "Português (Portugal)", "Portuguese (Portugal)", "pt-PT"),
			(.ptBR, "Português (Brasil)", "Portuguese (Brazil)", "pt-BR"),
			(.pl, "Polski", "Polish", "pl-PL"),
			(.ko, "한국어", "Korean", "ko-KR"),
			(.ja, "日本語", "Japanese", "ja-JP"),
			(.zhHans, "简体中文", "Simplified Chinese", "zh-Hans-CN"),
			(.zhHant, "繁體中文", "Traditional Chinese", "zh-Hant-TW"),
		]
		#expect(LanguageTag.contractOrder == expected.map(\.0))
		#expect(LanguageTag.allCases.count == 17)
		for (tag, endonym, englishName, locale) in expected {
			#expect(tag.endonym == endonym)
			#expect(tag.englishName == englishName)
			#expect(tag.defaultLocale == locale)
			#expect(LanguageTag(rawValue: tag.rawValue) == tag)
		}
	}

	@Test func resolvePrefersSavedThenMessageThenSurfaceThenEnglish() {
		#expect(
			Language.resolve(saved: .it, messageHint: .fr, surface: .nl)
				== LanguageResolution(language: .it, source: .preference, locale: "it-IT")
		)
		#expect(
			Language.resolve(saved: nil, messageHint: .fr, surface: .nl)
				== LanguageResolution(language: .fr, source: .message, locale: "fr-FR")
		)
		#expect(
			Language.resolve(saved: nil, messageHint: nil, surface: .nl)
				== LanguageResolution(language: .nl, source: .surface, locale: "nl-NL")
		)
		#expect(
			Language.resolve(saved: nil, messageHint: nil, surface: nil)
				== LanguageResolution(language: .en, source: .default, locale: "en-GB")
		)
	}

	@Test func resolveUsesDefaultLocaleOfTheResolvedTag() {
		for tag in LanguageTag.contractOrder {
			let resolved = Language.resolve(saved: tag, messageHint: nil, surface: nil)
			#expect(resolved.locale == tag.defaultLocale)
			#expect(resolved.source == .preference)
		}
	}

	@Test func normalizeLocaleHintMatchesDesktop() {
		let cases: [(String, LanguageTag?)] = [
			("it_IT.UTF-8", .it),
			("C", nil),
			("C.UTF-8", nil),
			("POSIX", nil),
			("pt-br", .ptBR),
			("nl-BE", .nl),
			("fr-BE", .fr),
			("de-BE", .de),
			("pt", .ptPT),
			("zh", .zhHans),
			("zh-TW", .zhHant),
			("zh-HK", .zhHant),
			("zh-CN", .zhHans),
			("zh-SG", .zhHans),
			("zh-Hans-TW", .zhHans),
			("zh-Hant-CN", .zhHant),
			("no", .nb),
			("nn", .nb),
			("en_US:en", .en),
			("ru_RU:fr_FR:en", .fr),
			("it_IT.UTF-8@euro", .it),
			("xx", nil),
			("", nil),
		]
		for (hint, expected) in cases {
			#expect(Language.normalizeLocaleHint(hint) == expected)
		}
		#expect(Language.normalizeLocaleHint(["ru", "fr-BE", "it"]) == .fr)
		#expect(Language.normalizeLocaleHint(["C:xx", "pt-br:en"]) == .ptBR)
		#expect(Language.normalizeLocaleHint([String]()) == nil)
		for tag in LanguageTag.contractOrder {
			#expect(Language.normalizeLocaleHint(tag.rawValue) == tag)
		}
	}

	@Test func uiTagUsesFirstSupportedSystemLanguageElseEnglish() {
		#expect(Language.uiTag(systemLanguages: ["it-IT", "en-US"]) == .it)
		#expect(Language.uiTag(systemLanguages: ["pt-BR"]) == .ptBR)
		#expect(Language.uiTag(systemLanguages: ["pt"]) == .ptPT)
		#expect(Language.uiTag(systemLanguages: ["zh-Hant-TW"]) == .zhHant)
		#expect(Language.uiTag(systemLanguages: ["ru-RU", "ja-JP"]) == .ja)
		#expect(Language.uiTag(systemLanguages: ["C", "xx"]) == .en)
		#expect(Language.uiTag(systemLanguages: []) == .en)
	}

	@Test func languageSlashYieldsLanguageCommandAndStartsNoModelTurn() {
		#expect(SlashRouting.parse("/language") == .language)
		#expect(SlashRouting.parse("  /language  ") == .language)
		#expect(SlashRouting.parse("/language it") == .language)
		#expect(SlashCommand.language.startsModelTurn == false)
		#expect(SlashRouting.parse("/review") != .language)
	}

	@Test func writeResolveEvidenceWhenPresent() throws {
		let directory = URL(fileURLWithPath: "/tmp/ios-c7")
		guard FileManager.default.fileExists(atPath: directory.path) else { return }
		var detect: [[String: String]] = []
		for language in LanguageTag.contractOrder {
			for message in DetectFixtures.messages[language] ?? [] {
				let found = Language.detectMessageLanguage(message)?.rawValue ?? ""
				detect.append(["input": message, "output": found, "expected": language.rawValue])
			}
		}
		for sample in ["", "ok", "/review", "the und et", "bonjour"] {
			detect.append(["input": sample, "output": Language.detectMessageLanguage(sample)?.rawValue ?? ""])
		}
		var normalize: [[String: String]] = []
		for hint in ["it_IT.UTF-8", "C", "pt-br", "pt", "zh-TW", "no", "nn", "ru_RU:fr_FR:en"] {
			normalize.append(["input": hint, "output": Language.normalizeLocaleHint(hint)?.rawValue ?? ""])
		}
		var resolve: [[String: String]] = []
		for saved in [Optional<LanguageTag>.none, .it] {
			for message in [Optional<LanguageTag>.none, .fr] {
				for surface in [Optional<LanguageTag>.none, .nl] {
					let result = Language.resolve(saved: saved, messageHint: message, surface: surface)
					resolve.append([
						"saved": saved?.rawValue ?? "",
						"message": message?.rawValue ?? "",
						"surface": surface?.rawValue ?? "",
						"language": result.language.rawValue,
						"source": result.source.rawValue,
						"locale": result.locale,
					])
				}
			}
		}
		let payload: [String: Any] = ["detect": detect, "normalize": normalize, "resolve": resolve]
		let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
		try data.write(to: directory.appendingPathComponent("resolve-swift.json"))
	}
}
