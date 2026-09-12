import Foundation

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

public struct ICloudKeychainStore: SecretStore {
	public init() {
		fatalError("not implemented")
	}

	public func appAccountToken() throws -> UUID { fatalError("not implemented") }
	public func openRouterKey() throws -> String? { fatalError("not implemented") }
	public func storeOpenRouterKey(_ key: String) throws { fatalError("not implemented") }
	public func intervalsCredential() throws -> IntervalsCredential? { fatalError("not implemented") }
	public func storeIntervalsCredential(_ credential: IntervalsCredential) throws { fatalError("not implemented") }
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
