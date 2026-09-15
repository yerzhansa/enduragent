import Foundation
import Testing
@testable import EnduragentCoach

@Suite struct SlashRoutingTests {
	@Test func parseReadsLeadingToken() {
		#expect(SlashRouting.parse("/review deep") == .review)
		#expect(SlashRouting.parse("/status") == .status)
		#expect(SlashRouting.parse("/workout tomorrow") == .workout)
		#expect(SlashRouting.parse("/plan") == .plan)
		#expect(SlashRouting.parse("/language") == .language)
		#expect(SlashRouting.parse("hello /review") == nil)
		#expect(SlashRouting.parse("/review")?.startsModelTurn == true)
		#expect(SlashRouting.parse("/plan")?.startsModelTurn == false)
		#expect(SlashRouting.parse("/language")?.startsModelTurn == false)
	}
}
