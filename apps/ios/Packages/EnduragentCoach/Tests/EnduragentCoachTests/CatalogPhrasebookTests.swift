import Foundation
import Testing
@testable import EnduragentCoach

@Suite struct CatalogPhrasebookTests {
	@Test func catalogCountsMatchTheGenerator() {
		#expect(Catalog.englishLeafCount == 2416)
		#expect(Catalog.keyCount == 2452)
	}

	@Test func italianCancelUsesTheItalianCatalog() {
		let book = CatalogPhrasebook(tag: .it, locale: "it-IT")
		#expect(book.say(Catalog.commonCancel) == "Annulla")
	}

	@Test func polishCountThreeSelectsTheFewForm() {
		let book = CatalogPhrasebook(tag: .pl, locale: "pl-PL")
		#expect(book.say(Catalog.archiveTurnCount, ["count": "3", "formattedCount": "3"]) == "3 wiadomości")
		#expect(book.say(Catalog.trainingViewRideCount, ["count": "3", "number": "3"]) == "3 przejazdy")
		#expect(book.say(Catalog.trainingViewRideCount, ["count": "1", "number": "1"]) == "1 przejazd")
		#expect(book.say(Catalog.trainingViewRideCount, ["count": "5", "number": "5"]) == "5 przejazdów")
	}

	@Test func japanesePluralsUseOtherOnly() {
		let book = CatalogPhrasebook(tag: .ja, locale: "ja-JP")
		#expect(book.say(Catalog.archiveTurnCount, ["count": "1", "formattedCount": "1"]) == "1件のメッセージ")
		#expect(book.say(Catalog.archiveTurnCount, ["count": "3", "formattedCount": "3"]) == "3件のメッセージ")
	}

	@Test func brazilianPortugueseDoesNotFallBackToPortugal() {
		let brazilian = CatalogPhrasebook(tag: .ptBR, locale: "pt-PT")
		let portugal = CatalogPhrasebook(tag: .ptPT, locale: "pt-BR")
		#expect(brazilian.say(Catalog.archiveAthlete) == "Você")
		#expect(portugal.say(Catalog.archiveAthlete) == "Tu")
		#expect(brazilian.say(Catalog.archiveAthlete) != portugal.say(Catalog.archiveAthlete))
	}

	@Test func missingKeyReturnsEnglishNeverTheRawKey() {
		let book = CatalogPhrasebook(tag: .it, locale: "it-IT")
		#expect(book.say(Catalog.commonCancel) != Catalog.commonCancel.rawValue)
		let missing = CatalogKey(rawValue: "not.a.catalog.key")
		let value = book.say(missing)
		#expect(value != missing.rawValue)
		#expect(value == CatalogPhrasebook(tag: .en, locale: "en-GB").say(missing))
	}

	@Test func namedSubstitutionDoesNotEscapeValues() {
		let book = CatalogPhrasebook(tag: .en, locale: "en-GB")
		#expect(book.say(Catalog.trainingPowerPercent, ["value": "42"]) == "42%")
	}
}
