import SwiftUI
import NanocodexApps

@main
struct NativeAppsDemo: App {
    init() {
        let root = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let allowed = Set(["cigarettes", "calories", "form", "generated-cigarettes", "generated-calories", "generated-packing"])
        for argument in ProcessInfo.processInfo.arguments where argument.hasPrefix("--reset-state=") {
            for name in argument.dropFirst("--reset-state=".count).split(separator: ",").map(String.init) where allowed.contains(name) {
                try? FileManager.default.removeItem(at: root.appendingPathComponent(name + ".json"))
                try? FileManager.default.removeItem(at: root.appendingPathComponent(name + "-agent-prompt.txt"))
            }
        }
    }
    var body: some Scene { WindowGroup { DemoLauncher() } }
}

struct DemoLauncher: View {
    @State private var session: NativeAppSession?
    @State private var failure: String?
    private let root = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    var body: some View {
        NavigationStack {
            Group {
                if let session { NativeAppView(session: session) }
                else if let failure { Text(failure).accessibilityIdentifier("fixture-error") }
                else {
                    List {
                        Button("Generated Smoke Log") { open("generated-cigarettes") }
                        Button("Generated Meal Notes") { open("generated-calories") }
                        Button("Generated Pack Light") { open("generated-packing") }
                        Button("Cigarette tracker") { open("cigarettes") }
                        Button("Calorie journal") { open("calories") }
                        Button("Native form and list") { open("form") }
                    }.navigationTitle("Swift Apps")
                }
            }
            .toolbar {
                if session != nil || failure != nil {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Apps") { session?.invalidate(); session = nil; failure = nil }
                    }
                }
            }
        }
    }
    private func open(_ name: String) {
        do {
            guard let sourceURL = Bundle.main.url(forResource: name, withExtension: "swift", subdirectory: "Fixtures") else { throw CocoaError(.fileNoSuchFile) }
            let source = try String(contentsOf: sourceURL, encoding: .utf8)
            let stateURL = root.appendingPathComponent(name + ".json")
            let host = NativeAppHost(
                loadState: {
                    guard FileManager.default.fileExists(atPath: stateURL.path) else { return [:] }
                    return try JSONDecoder().decode([String: AppValue].self, from: Data(contentsOf: stateURL))
                },
                saveState: { values in try JSONEncoder().encode(values).write(to: stateURL, options: .atomic) },
                runAgent: { prompt in
                    try Data(prompt.utf8).write(to: root.appendingPathComponent(name + "-agent-prompt.txt"), options: .atomic)
                    return "Fixture coach: take a short walk and log your next choice."
                })
            session = try NativeAppSession(source: source, host: host)
        } catch { failure = error.localizedDescription }
    }
}
