import Foundation
import Testing
@testable import EnduragentCoach

@Suite struct KeychainStoreTests {
	@Test func appAccountTokenIsStable() throws {
		let memory = MemorySecretStoreBacking()
		let first = ICloudKeychainStore(backing: memory)
		let second = ICloudKeychainStore(backing: memory)
		let token = try first.appAccountToken()
		#expect(try first.appAccountToken() == token)
		#expect(try second.appAccountToken() == token)
	}

	@Test func openRouterKeyAndIntervalsCredentialRoundTrip() throws {
		let store = ICloudKeychainStore(backing: MemorySecretStoreBacking())
		#expect(try store.openRouterKey() == nil)
		#expect(try store.intervalsCredential() == nil)
		try store.storeOpenRouterKey("test-or-key")
		#expect(try store.openRouterKey() == "test-or-key")
		try store.storeOpenRouterKey("test-or-key-rotated")
		#expect(try store.openRouterKey() == "test-or-key-rotated")
		try store.storeIntervalsCredential(.apiKey("icu-key"))
		#expect(try store.intervalsCredential() == .apiKey("icu-key"))
		try store.storeIntervalsCredential(.oauth(access: "a", refresh: "r"))
		#expect(try store.intervalsCredential() == .oauth(access: "a", refresh: "r"))
	}

	@Test(.enabled(if: ProcessInfo.processInfo.environment["ENDURAGENT_KEYCHAIN_TESTS"] == "1"))
	func appAccountTokenIsStableOnSecItem() throws {
		let first = ICloudKeychainStore()
		let second = ICloudKeychainStore()
		let token = try first.appAccountToken()
		#expect(try first.appAccountToken() == token)
		#expect(try second.appAccountToken() == token)
	}
}

final class MemorySecretStoreBacking: SecretStoreBacking, @unchecked Sendable {
	private var items: [String: Data] = [:]

	func add(account: String, data: Data) throws {
		if items[account] != nil {
			throw KeychainStoreError(status: errSecDuplicateItem)
		}
		items[account] = data
	}

	func copy(account: String) throws -> Data? {
		items[account]
	}

	func update(account: String, data: Data) throws {
		guard items[account] != nil else {
			throw KeychainStoreError(status: errSecItemNotFound)
		}
		items[account] = data
	}
}
