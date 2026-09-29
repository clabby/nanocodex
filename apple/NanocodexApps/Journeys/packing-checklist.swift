import SwiftUI

struct PackingChecklist: View {
    @Persisted("packing.trip") var tripName = "My next trip"
    @Persisted("packing.items") var items: [String] = []
    @Persisted("packing.packed") var packed: [String] = []
    @State var newItem = ""

    func unpack(_ item: String) {
        var remaining: [String] = []
        for value in packed {
            if value != item {
                remaining.append(value)
            }
        }
        packed = remaining
    }

    var body: some View {
        Form {
            Section("Ready when you are") {
                Label("A calmer departure", systemImage: "suitcase.rolling")
                    .font(.headline)
                    .foregroundStyle(.indigo)
                TextField("Trip name", text: $tripName)
                Text("Build your list, pack a little at a time, and pick up where you left off.")
                    .foregroundStyle(.secondary)
            }
            Section("Packing progress") {
                HStack {
                    Text("\(packed.count) / \(items.count)")
                        .font(.largeTitle)
                        .fontWeight(.bold)
                    Text("items packed")
                        .foregroundStyle(.secondary)
                }
                ProgressView(value: Double(packed.count), total: Double(max(items.count, 1)))
                    .tint(.indigo)
                if !items.isEmpty && packed.count == items.count {
                    Label("Everything is in. Enjoy the journey!", systemImage: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                } else {
                    if !items.isEmpty {
                        Text("\(items.count - packed.count) items still to pack")
                    }
                }
            }
            Section("Add an essential") {
                TextField("Item, for example phone charger", text: $newItem)
                Button("Add to packing list") {
                    if !newItem.isEmpty && !items.contains(newItem) {
                        items.append(newItem)
                        newItem = ""
                    }
                }
                .buttonStyle(.borderedProminent)
                .tint(.indigo)
                .disabled(newItem.isEmpty || items.contains(newItem))
                if !newItem.isEmpty && items.contains(newItem) {
                    Text("That item is already on your list.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Section("Your checklist") {
                if items.isEmpty {
                    Label("An empty bag, a fresh start", systemImage: "bag")
                        .font(.headline)
                    Text("Add your first essential above. Try travel documents, medication, or a charger.")
                        .foregroundStyle(.secondary)
                }
                ForEach(items, id: \.self) { item in
                    if packed.contains(item) {
                        HStack {
                            Label(item, systemImage: "checkmark.circle.fill")
                                .foregroundStyle(.green)
                            Spacer()
                            Button("Unpack: \(item)") {
                                unpack(item)
                            }
                        }
                    } else {
                        HStack {
                            Label(item, systemImage: "circle")
                            Spacer()
                            Button("Pack: \(item)") {
                                if !packed.contains(item) {
                                    packed.append(item)
                                }
                            }
                            .buttonStyle(.bordered)
                        }
                    }
                }
            }
            if !packed.isEmpty {
                Section("For the next departure") {
                    Button("Mark everything unpacked") {
                        packed.removeAll()
                    }
                    Text("Keep your checklist and start packing again.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle("Pack Light")
    }
}
