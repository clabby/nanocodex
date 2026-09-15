import SwiftUI

@main
struct NanocodexInboxApp: App {
    init() { InboxModel.shared.configureAgentNotifications() }
    @StateObject private var model = InboxModel.shared
    @Environment(\.scenePhase) private var scenePhase
    var body: some Scene {
        WindowGroup("Nanocodex", id: "inbox") {
            #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("--spotify-loopback-smoke") {
                SpotifyLoopbackSmokeView()
            } else {
                content
            }
            #else
            content
            #endif
        }
        .backgroundTask(.appRefresh(InboxModel.handRefreshIdentifier)) {
            await model.refreshHandInBackground()
        }
    }

    private var content: some View {
        InboxView(model: model)
                .onAppear { Task { await model.start() } }
                .onReceive(NotificationCenter.default.publisher(for: UIApplication.didReceiveMemoryWarningNotification)) { _ in
                    model.releaseInactiveHistory()
                }
                .onOpenURL { url in
                    if url.scheme == "nanocodex", url.host == "connect", url.path == "/spotify", url.query == nil {
                        model.openSpotifySettings = true
                    } else { model.openAgentActivity(url) }
                }
                .onChange(of: scenePhase, initial: true) { _, phase in
                    if phase == .background {
                        model.voice.stop()
                        model.setActive(false)
                    } else if phase == .active {
                        model.setActive(true)
                    } else if phase == .inactive {
                        model.prepareHandForBackground()
                    }
                }
    }
}
