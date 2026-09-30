import SwiftUI
struct CalorieJournal: View {
    @State var meal = ""
    @State var calories = ""
    @Persisted("meals") var meals: [String] = []
    @Persisted("total") var total = 0
    var body: some View {
        Form {
            Section("Daily energy") { Text("Total: \(total) kcal").font(.title) }
            Section("Add a meal") {
                TextField("Meal name", text: $meal)
                TextField("Calories", text: $calories)
                Button("Save meal") {
                    meals.append("\(meal): \(calories) kcal")
                    total += Int(calories)
                    meal = ""
                    calories = ""
                }.disabled(meal.isEmpty || calories.isEmpty)
            }
            Section("Meals") { ForEach(meals) { item in Text(item) } }
        }.navigationTitle("Calorie journal")
    }
}
