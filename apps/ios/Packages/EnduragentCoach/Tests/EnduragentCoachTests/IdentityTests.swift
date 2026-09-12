import Foundation
import Testing
@testable import EnduragentCoach

@Suite struct IdentityTests {
	@Test func ulidLengthAndTimeOrder() {
		let earlier = Date(timeIntervalSince1970: 899_164_800)
		let later = Date(timeIntervalSince1970: 899_164_801)
		let first = ULID.generate(at: earlier)
		let second = ULID.generate(at: later)
		#expect(first.rawValue.count == 26)
		#expect(second.rawValue.count == 26)
		#expect(ULID(rawValue: first.rawValue) == first)
		#expect(first.rawValue < second.rawValue)
		#expect(ulidTimestamp(first.rawValue) == UInt64((earlier.timeIntervalSince1970 * 1000).rounded(.down)))
		#expect(ulidTimestamp(second.rawValue) == UInt64((later.timeIntervalSince1970 * 1000).rounded(.down)))
	}

	@Test func civilDateAndDateKeyRoundTripEveryDayOf1998() {
		var date = CivilDate(rawValue: "1998-01-01")!
		var count = 0
		while date.rawValue.hasPrefix("1998") {
			#expect(date.adding(days: 0) == date)
			let key = DateKey.from(date)
			#expect(key.civil == date)
			let next = date.adding(days: 1)
			if next.rawValue.hasPrefix("1998") {
				#expect(date < next)
			}
			date = next
			count += 1
			#expect(count <= 366)
		}
		#expect(count == 365)
		#expect(CivilDate(rawValue: "1998-12-31")!.adding(days: 1).rawValue == "1999-01-01")
	}

	@Test func jsonParseCanonicalSha256AndStringify() throws {
		let parsed = try JSONValue.parse("{\"b\":1,\"a\":[true,null,\"x\"]}")
		#expect(
			canonicalJSON(parsed)
				== """
				{
				  "a": [
				    true,
				    null,
				    "x"
				  ],
				  "b": 1
				}
				"""
		)
		#expect(parsed.canonicalDigestInput() == "{\"a\":[true,null,\"x\"],\"b\":1}")
		#expect(sha256Hex("hello") == "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824")
		let quotes = JSONValue.array([.string("say \"hi\""), .string("a\\b"), .string("line\n")]).canonicalDigestInput()
		#expect(quotes == "[\"say \\\"hi\\\"\",\"a\\\\b\",\"line\\n\"]")
	}

	@Test func estimateTokensMatchesDesktop() throws {
		let rows = try loadLedgerDigestTable()
		for row in rows {
			#expect(estimateTokens(row.text) == row.estimateTokens)
		}
	}
}

private func ulidTimestamp(_ raw: String) -> UInt64 {
	let alphabet = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ")
	var value: UInt64 = 0
	for character in raw.prefix(10) {
		value = value * 32 + UInt64(alphabet.firstIndex(of: character)!)
	}
	return value
}

struct LedgerDigestRow: Codable, Equatable {
	var date: String
	var kind: String
	var text: String
	var digestInput: String
	var digest: String
	var estimateTokens: Int
}

func loadLedgerDigestTable() throws -> [LedgerDigestRow] {
	guard
		let url = Bundle.module.url(
			forResource: "ledger-digest-table",
			withExtension: "json",
			subdirectory: "Fixtures"
		)
	else {
		throw URLError(.fileDoesNotExist)
	}
	return try JSONDecoder().decode([LedgerDigestRow].self, from: Data(contentsOf: url))
}
