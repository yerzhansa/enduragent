import Foundation
import Testing
@testable import EnduragentCoach

@Suite
struct DisplayZonesTests {
	@Test func ftp280MatchesDesktopRows() throws {
		let rows = try DisplayZones.calculate(ftpWatts: 280)
		#expect(
			rows == [
				"< 154W",
				"157-210W",
				"213-252W",
				"246-263W",
				"255-294W",
				"297-336W",
			]
		)
	}

	@Test func ftpTablesMatchTypeScriptBytes() throws {
		let expected = try JSONValue.parse(String(data: try fixtureData("zones-ts"), encoding: .utf8)!)
		let actual = try DisplayZones.json(ftpWatts: [200, 250, 280, 400])
		#expect(actual.canonicalDigestInput() == expected.canonicalDigestInput())
		#expect(Array(actual.canonicalDigestInput().utf8) == Array(expected.canonicalDigestInput().utf8))
		writeEvidence("zones-swift.json", canonicalJSON(actual))
	}

	@Test func ftpOutsideRangeThrows() {
		#expect(throws: IntervalsError.self) {
			_ = try DisplayZones.calculate(ftpWatts: 49)
		}
		#expect(throws: IntervalsError.self) {
			_ = try DisplayZones.calculate(ftpWatts: 601)
		}
	}
}
