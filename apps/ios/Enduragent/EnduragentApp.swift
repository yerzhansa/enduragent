import SwiftUI

@main
struct EnduragentApp: App {
	var body: some Scene {
		WindowGroup {
			#if DEBUG
			RecordSyncDebugView()
			#else
			EmptyView()
			#endif
		}
	}
}
