import SwiftUI

struct CigaretteEntry {
    var id: String
    var timestamp: Double
}

struct CigaretteTracker: View {
    @Persisted("smoke.entries") var entries: [CigaretteEntry] = []
    @Persisted("smoke.pack.price") var packPrice = "12.00"
    @Persisted("smoke.pack.size") var packSize = 20

    func todayCount() -> Int {
        let today = Clock.today()
        return entries.filter { entry in Clock.dayKey(entry.timestamp) == today }.count
    }

    func weeklyCounts() -> [Int] {
        let now = Date().timeIntervalSince1970
        var counts: [Int] = []
        for offset in 0...6 {
            let start = now - Double(7 - offset) * 86400
            let end = now - Double(6 - offset) * 86400
            let count = entries.filter { entry in entry.timestamp > start && entry.timestamp <= end }.count
            counts.append(count)
        }
        return counts
    }

    func weekCount() -> Int {
        return weeklyCounts().reduce(0) { total, count in total + count }
    }

    var body: some View {
        Form {
            Section("A moment to notice") {
                Label("Your log, one tap at a time", systemImage: "leaf")
                    .font(.headline)
                    .foregroundStyle(.teal)
                Text("Keep a clear picture of your habits without judgment.")
                    .foregroundStyle(.secondary)
            }
            Section("Today · \(Clock.today())") {
                HStack {
                    Text("\(todayCount())")
                        .font(.largeTitle)
                        .fontWeight(.bold)
                    Text(todayCount() == 1 ? "cigarette logged" : "cigarettes logged")
                        .foregroundStyle(.secondary)
                }
                Button("Log a cigarette") {
                    entries.append(CigaretteEntry(id: UUID().uuidString, timestamp: Date().timeIntervalSince1970))
                }
                .buttonStyle(.borderedProminent)
                .tint(.teal)
                Button("Undo latest cigarette") {
                    if !entries.isEmpty {
                        entries.removeLast()
                    }
                }
                .disabled(entries.isEmpty)
                if todayCount() == 0 {
                    Text("Nothing logged today. Your first tap will appear here.")
                        .foregroundStyle(.secondary)
                }
                if !entries.isEmpty {
                    Text("Latest: \(Date(timeIntervalSince1970: entries[entries.count - 1].timestamp).formatted())")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Section("Your seven-day picture") {
                BarChart(weeklyCounts())
                    .frame(height: 140)
                    .tint(.teal)
                HStack {
                    Text("Past seven days")
                    Spacer()
                    Text("\(weekCount()) " + (weekCount() == 1 ? "cigarette" : "cigarettes"))
                        .fontWeight(.semibold)
                }
                Text("Seven 24-hour periods, oldest to newest. Today's count follows your local calendar.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Section("What it adds up to") {
                TextField("Pack price", text: $packPrice)
                Stepper("Cigarettes per pack: \(packSize)", value: $packSize, in: 1...50)
                let price = max(Double(packPrice) ?? 0, 0)
                let dayCost = round(Double(todayCount()) * price / Double(packSize) * 100) / 100
                let weekCost = round(Double(weekCount()) * price / Double(packSize) * 100) / 100
                Text("Today: \(dayCost)")
                Text("Past seven days: \(weekCost)")
                    .fontWeight(.semibold)
                if Double(packPrice) == nil || (Double(packPrice) ?? 0) < 0 {
                    Text("Enter a nonnegative pack price to see a cost estimate.")
                        .foregroundStyle(.orange)
                }
                Text("Costs use your current pack price and its currency.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Smoke Log")
    }
}
