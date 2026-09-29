import SwiftUI
struct NativeChecklist: View {
    @Persisted("name") var name = ""
    @Persisted("reminder") var reminder = false
    @Persisted("tasks") var tasks: [String] = []
    var body: some View {
        Form {
            Section("Plan") {
                TextField("Task name", text: $name)
                Toggle("Daily reminder", isOn: $reminder)
                Button("Add task") { tasks.append(name); name = "" }.disabled(name.isEmpty)
            }
            Section("Tasks") { ForEach(tasks) { item in Text(item) } }
        }.navigationTitle("Native checklist")
    }
}
