import Foundation
import Security

public struct CreditBalance: Sendable, Equatable {
	public var credits: Int
}

public struct CreditPack: Sendable, Equatable {
	public var productId: String
	public var displayCredits: Int
}

public enum IntervalsCredential: Sendable, Equatable {
	case apiKey(String)
	case oauth(access: String, refresh: String)
}

public protocol SecretStore: Sendable {
	func appAccountToken() throws -> UUID
	func openRouterKey() throws -> String?
	func storeOpenRouterKey(_ key: String) throws
	func intervalsCredential() throws -> IntervalsCredential?
	func storeIntervalsCredential(_ credential: IntervalsCredential) throws
}

public struct KeychainStoreError: Error, Sendable, Equatable {
	public var status: OSStatus

	public init(status: OSStatus) {
		self.status = status
	}
}

package protocol SecretStoreBacking: Sendable {
	func add(account: String, data: Data) throws
	func copy(account: String) throws -> Data?
	func update(account: String, data: Data) throws
}

public struct ICloudKeychainStore: SecretStore {
	package static let serviceName = "icu.enduragent.ios"
	package static let accessGroupName = "icu.enduragent.ios"

	private let backing: any SecretStoreBacking

	public init() {
		self.backing = SecItemSecretStoreBacking(service: Self.serviceName, accessGroup: nil)
	}

	package init(backing: any SecretStoreBacking) {
		self.backing = backing
	}

	public func appAccountToken() throws -> UUID {
		if let token = try readToken() {
			return token
		}
		let token = UUID()
		do {
			try backing.add(account: KeychainAccount.appAccountToken, data: Data(token.uuidString.utf8))
			return token
		} catch let error as KeychainStoreError where error.status == errSecDuplicateItem {
			if let existing = try readToken() {
				return existing
			}
			throw error
		}
	}

	public func openRouterKey() throws -> String? {
		try readString(account: KeychainAccount.openRouterKey)
	}

	public func storeOpenRouterKey(_ key: String) throws {
		try write(account: KeychainAccount.openRouterKey, data: Data(key.utf8))
	}

	public func intervalsCredential() throws -> IntervalsCredential? {
		guard let data = try backing.copy(account: KeychainAccount.intervalsCredential) else {
			return nil
		}
		return try JSONDecoder().decode(StoredIntervalsCredential.self, from: data).credential
	}

	public func storeIntervalsCredential(_ credential: IntervalsCredential) throws {
		let encoded = try JSONEncoder().encode(StoredIntervalsCredential(credential))
		try write(account: KeychainAccount.intervalsCredential, data: encoded)
	}

	private func readToken() throws -> UUID? {
		guard let raw = try readString(account: KeychainAccount.appAccountToken) else {
			return nil
		}
		guard let token = UUID(uuidString: raw) else {
			throw KeychainStoreError(status: errSecDecode)
		}
		return token
	}

	private func readString(account: String) throws -> String? {
		guard let data = try backing.copy(account: account) else {
			return nil
		}
		guard let string = String(data: data, encoding: .utf8) else {
			throw KeychainStoreError(status: errSecDecode)
		}
		return string
	}

	private func write(account: String, data: Data) throws {
		if try backing.copy(account: account) == nil {
			try backing.add(account: account, data: data)
		} else {
			try backing.update(account: account, data: data)
		}
	}
}

public protocol CreditsClient: Sendable {
	func purchase(_ pack: CreditPack, signedTransaction: Data) async throws -> CreditBalance
	func grantStarter(deviceCheck: Data) async throws -> CreditBalance
	func recover(signedTransaction: Data) async throws -> CreditBalance
	func balance() async throws -> CreditBalance
}

public struct PhoneCreditsClient: CreditsClient {
	public init(secrets: any SecretStore, workerBase: URL) {
		fatalError("not implemented")
	}

	public func purchase(_ pack: CreditPack, signedTransaction: Data) async throws -> CreditBalance {
		fatalError("not implemented")
	}

	public func grantStarter(deviceCheck: Data) async throws -> CreditBalance {
		fatalError("not implemented")
	}

	public func recover(signedTransaction: Data) async throws -> CreditBalance {
		fatalError("not implemented")
	}

	public func balance() async throws -> CreditBalance {
		fatalError("not implemented")
	}
}

private enum KeychainAccount {
	static let appAccountToken = "appAccountToken"
	static let openRouterKey = "openRouterKey"
	static let intervalsCredential = "intervalsCredential"
}

private enum StoredIntervalsCredential: Codable {
	case apiKey(String)
	case oauth(access: String, refresh: String)

	init(_ credential: IntervalsCredential) {
		switch credential {
		case .apiKey(let key):
			self = .apiKey(key)
		case .oauth(let access, let refresh):
			self = .oauth(access: access, refresh: refresh)
		}
	}

	var credential: IntervalsCredential {
		switch self {
		case .apiKey(let key):
			return .apiKey(key)
		case .oauth(let access, let refresh):
			return .oauth(access: access, refresh: refresh)
		}
	}
}

private struct SecItemSecretStoreBacking: SecretStoreBacking {
	var service: String
	var accessGroup: String?

	func add(account: String, data: Data) throws {
		var query = baseQuery(account: account)
		query[kSecValueData as String] = data
		query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
		let status = SecItemAdd(query as CFDictionary, nil)
		guard status == errSecSuccess else {
			throw KeychainStoreError(status: status)
		}
	}

	func copy(account: String) throws -> Data? {
		var query = baseQuery(account: account)
		query[kSecReturnData as String] = true
		query[kSecMatchLimit as String] = kSecMatchLimitOne
		var result: AnyObject?
		let status = SecItemCopyMatching(query as CFDictionary, &result)
		if status == errSecItemNotFound {
			return nil
		}
		guard status == errSecSuccess else {
			throw KeychainStoreError(status: status)
		}
		guard let data = result as? Data else {
			throw KeychainStoreError(status: errSecDecode)
		}
		return data
	}

	func update(account: String, data: Data) throws {
		let status = SecItemUpdate(
			baseQuery(account: account) as CFDictionary,
			[kSecValueData as String: data] as CFDictionary
		)
		guard status == errSecSuccess else {
			throw KeychainStoreError(status: status)
		}
	}

	private func baseQuery(account: String) -> [String: Any] {
		var query: [String: Any] = [
			kSecClass as String: kSecClassGenericPassword,
			kSecAttrService as String: service,
			kSecAttrAccount as String: account,
			kSecAttrSynchronizable as String: kCFBooleanTrue as Any,
		]
		if let accessGroup {
			query[kSecAttrAccessGroup as String] = accessGroup
		}
		return query
	}
}
