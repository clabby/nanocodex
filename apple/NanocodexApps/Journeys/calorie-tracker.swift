import SwiftUI

struct MealRecord {
    var id: String
    var name: String
    var calories: Int
    var timestamp: Double
}

struct CalorieTracker: View {
    @Persisted("meals.log") var meals: [MealRecord] = []
    @Persisted("meals.goal") var calorieGoal = 2000
    @State var mealName = ""
    @State var calorieInput = ""
    @State var mealDescription = ""
    @State var advice = ""

    func todayCalories() -> Int {
        let today = Clock.today()
        let todayMeals = meals.filter { meal in Clock.dayKey(meal.timestamp) == today }
        return todayMeals.reduce(0) { total, meal in total + meal.calories }
    }

    var body: some View {
        Form {
            Section("A little clarity at mealtime") {
                Label("Food journal", systemImage: "fork.knife")
                    .font(.headline)
                    .foregroundStyle(.orange)
                Text("Log a meal, keep perspective, and make the goal your own.")
                    .foregroundStyle(.secondary)
            }
            Section("Today · \(Clock.today())") {
                HStack {
                    Text("\(todayCalories())")
                        .font(.largeTitle)
                        .fontWeight(.bold)
                    Text("of \(calorieGoal) kcal")
                        .foregroundStyle(.secondary)
                }
                ProgressView(value: Double(min(todayCalories(), calorieGoal)), total: Double(calorieGoal))
                    .tint(.orange)
                if todayCalories() <= calorieGoal {
                    Text("\(calorieGoal - todayCalories()) kcal remaining")
                } else {
                    Text("\(todayCalories() - calorieGoal) kcal above your chosen goal")
                }
                Stepper("Goal: \(calorieGoal) kcal", value: $calorieGoal, in: 500...5000, step: 100)
            }
            Section("Add a meal") {
                TextField("Meal name", text: $mealName)
                TextField("Calories, for example 450", text: $calorieInput)
                Button("Log meal") {
                    let calories = Int(calorieInput) ?? 0
                    if !mealName.isEmpty && calories > 0 {
                        meals.append(MealRecord(id: UUID().uuidString, name: mealName, calories: calories, timestamp: Date().timeIntervalSince1970))
                        mealName = ""
                        calorieInput = ""
                    }
                }
                .buttonStyle(.borderedProminent)
                .tint(.orange)
                .disabled(mealName.isEmpty || (Int(calorieInput) ?? 0) <= 0)
                if !calorieInput.isEmpty && (Int(calorieInput) ?? 0) <= 0 {
                    Text("Enter a positive whole number of calories.")
                        .foregroundStyle(.orange)
                }
            }
            Section("Journal · \(meals.count) " + (meals.count == 1 ? "meal" : "meals")) {
                if meals.isEmpty {
                    Label("Your first meal starts the journal", systemImage: "tray")
                        .foregroundStyle(.secondary)
                }
                ForEach(meals.reversed().prefix(30), id: \.id) { meal in
                    VStack {
                        HStack {
                            Text(meal.name)
                            Spacer()
                            Text("\(meal.calories) kcal")
                                .fontWeight(.semibold)
                        }
                        Text(Date(timeIntervalSince1970: meal.timestamp).formatted())
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                if meals.count > 30 {
                    Text("Showing your latest 30 meals. Earlier meals stay saved and are included in today’s total.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Button("Undo latest meal") {
                    if !meals.isEmpty {
                        meals.removeLast()
                    }
                }
                .disabled(meals.isEmpty)
            }
            Section("Estimate with a little help") {
                TextField("Describe ingredients and portions", text: $mealDescription)
                Button("Ask for an estimate") {
                    Task {
                        advice = await Agent.run("Give a brief approximate calorie estimate and explain uncertainty for this meal: " + mealDescription + ". Offer one practical food-journaling tip. Do not prescribe a calorie target. The user will review and enter the calories themselves.")
                    }
                }
                .disabled(mealDescription.isEmpty)
                if advice.isEmpty {
                    Text("Describe a meal to get an estimate you can review and edit. Nothing is logged automatically.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                TextEditor(text: $advice)
                    .frame(height: 130)
                Text("Edit the estimate above, then enter your chosen number in Add a meal.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Meal Notes")
    }
}
