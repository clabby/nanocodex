import SwiftUI
struct CigaretteTracker: View {
    @Persisted("count") var count = 0
    @Persisted("coach") var coach = ""
    var body: some View {
        Form {
            Section("Today") {
                Text("Cigarettes: \(count)").font(.title)
                Button("Log cigarette") { count += 1 }
                Button("Undo last cigarette") { count = max(0, count - 1) }
            }
            Section("Support") {
                Button("Ask coach") { coach = await Agent.run("Help me reduce cigarettes. Today: \(count)") }
                Text(coach)
            }
        }.navigationTitle("Cigarette tracker")
    }
}
