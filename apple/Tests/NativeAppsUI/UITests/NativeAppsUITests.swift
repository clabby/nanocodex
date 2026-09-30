import XCTest
final class NativeAppsUITests: XCTestCase {
    @MainActor func testSourceDrivenNativeJourneysAndPersistence() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--reset-state=cigarettes,calories,form"]
        app.launch()
        tap(app.buttons["Cigarette tracker"])
        visible(app.staticTexts["Cigarettes: 0"])
        tap(app.buttons["Log cigarette"])
        visible(app.staticTexts["Cigarettes: 1"])
        tap(app.buttons["Log cigarette"])
        visible(app.staticTexts["Cigarettes: 2"])
        tap(app.buttons["Undo last cigarette"])
        visible(app.staticTexts["Cigarettes: 1"])
        tap(app.buttons["Ask coach"])
        visible(app.staticTexts["Fixture coach: take a short walk and log your next choice."])
        capture(app, "01-cigarette-counter-and-coach")
        tap(app.buttons["Apps"])
        tap(app.buttons["Calorie journal"])
        visible(app.staticTexts["Total: 0 kcal"])
        XCTAssertFalse(app.buttons["Save meal"].isEnabled)
        enter(app.textFields["Meal name"], "Oatmeal\n")
        enter(app.textFields["Calories"], "350\n")
        tap(app.buttons["Save meal"])
        visible(app.staticTexts["Total: 350 kcal"])
        visible(app.staticTexts["Oatmeal: 350 kcal"])
        capture(app, "02-calorie-entry-and-total")
        tap(app.buttons["Apps"])
        tap(app.buttons["Native form and list"])
        enter(app.textFields["Task name"], "Walk after lunch\n")
        let reminder = app.switches["Daily reminder"]
        visible(reminder)
        reminder.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.5)).tap()
        XCTAssertEqual(reminder.value as? String, "1")
        tap(app.buttons["Add task"])
        visible(app.staticTexts["Walk after lunch"])
        XCTAssertEqual(app.switches["Daily reminder"].value as? String, "1")
        capture(app, "03-native-form-toggle-and-list")
        app.terminate()
        app.launchArguments = []
        app.launch()
        tap(app.buttons["Cigarette tracker"])
        visible(app.staticTexts["Cigarettes: 1"])
        capture(app, "04-cigarette-relaunched-persisted")
        tap(app.buttons["Apps"])
        tap(app.buttons["Calorie journal"])
        visible(app.staticTexts["Total: 350 kcal"])
        visible(app.staticTexts["Oatmeal: 350 kcal"])
        capture(app, "05-calories-relaunched-persisted")
        tap(app.buttons["Apps"])
        tap(app.buttons["Native form and list"])
        visible(app.staticTexts["Walk after lunch"])
        XCTAssertEqual(app.switches["Daily reminder"].value as? String, "1")
        capture(app, "06-form-relaunched-persisted")
    }
    @MainActor func testIndependentGeneratedSources() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--reset-state=generated-cigarettes,generated-calories,generated-packing"]
        app.launch()
        tap(app.buttons["Generated Smoke Log"])
        tap(app.buttons["Log a cigarette"])
        visible(app.staticTexts["1"].firstMatch)
        tap(app.buttons["Log a cigarette"])
        visible(app.staticTexts["2"].firstMatch)
        tap(app.buttons["Undo latest cigarette"])
        visible(app.staticTexts["1"].firstMatch)
        capture(app, "10-generated-smoke-log")
        reveal(app.textFields["Pack price"], in: app)
        let price = app.textFields["Pack price"]
        replace(price, with: "10.00", in: app)
        XCTAssertEqual(price.value as? String, "10.00")
        visible(app.staticTexts["Today: 0.5"])
        capture(app, "11-generated-smoke-chart-and-cost")
        tap(app.buttons["Apps"])
        tap(app.buttons["Generated Meal Notes"])
        reveal(app.textFields["Meal name"], in: app)
        enter(app.textFields["Meal name"], "Oatmeal\n")
        reveal(app.textFields["Calories, for example 450"], in: app)
        enter(app.textFields["Calories, for example 450"], "0\n")
        XCTAssertFalse(app.buttons["Log meal"].isEnabled)
        visible(app.staticTexts["Enter a positive whole number of calories."])
        let calories = app.textFields["Calories, for example 450"]
        replace(calories, with: "350", in: app)
        XCTAssertEqual(calories.value as? String, "350")
        reveal(app.buttons["Log meal"], in: app)
        tap(app.buttons["Log meal"])
        reveal(app.staticTexts["Oatmeal"], in: app)
        visible(app.staticTexts["350 kcal"])
        capture(app, "12-generated-meal-journal")
        reveal(app.textFields["Describe ingredients and portions"], in: app)
        enter(app.textFields["Describe ingredients and portions"], "Oats and milk\n")
        reveal(app.buttons["Ask for an estimate"], in: app)
        tap(app.buttons["Ask for an estimate"])
        let editor = app.textViews.firstMatch
        visible(editor)
        let reply = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value CONTAINS %@", "Fixture coach:"), object: editor)
        XCTAssertEqual(XCTWaiter.wait(for: [reply], timeout: 10), .completed)
        capture(app, "13-generated-meal-agent-response")
        tap(app.buttons["Apps"])
        tap(app.buttons["Generated Pack Light"])
        reveal(app.textFields["Item, for example phone charger"], in: app)
        enter(app.textFields["Item, for example phone charger"], "Phone charger\n")
        reveal(app.buttons["Add to packing list"], in: app)
        tap(app.buttons["Add to packing list"])
        reveal(app.buttons["Pack: Phone charger"], in: app)
        tap(app.buttons["Pack: Phone charger"])
        visible(app.buttons["Unpack: Phone charger"])
        capture(app, "14-generated-packing-list")
        app.terminate()
        app.launchArguments = []
        app.launch()
        tap(app.buttons["Generated Smoke Log"])
        visible(app.staticTexts["1"].firstMatch)
        capture(app, "15-generated-smoke-relaunched")
        reveal(app.textFields["Pack price"], in: app)
        XCTAssertEqual(app.textFields["Pack price"].value as? String, "10.00")
        visible(app.staticTexts["Today: 0.5"])
        tap(app.buttons["Apps"])
        tap(app.buttons["Generated Meal Notes"])
        visible(app.staticTexts["350"].firstMatch)
        visible(app.staticTexts["1650 kcal remaining"])
        capture(app, "16-generated-meals-relaunched")
        reveal(app.staticTexts["Oatmeal"], in: app)
        visible(app.staticTexts["350 kcal"])
        tap(app.buttons["Apps"])
        tap(app.buttons["Generated Pack Light"])
        visible(app.staticTexts["1 / 1"])
        visible(app.staticTexts["Everything is in. Enjoy the journey!"])
        reveal(app.buttons["Unpack: Phone charger"], in: app)
        capture(app, "17-generated-packing-relaunched")
    }
    @MainActor private func replace(_ element: XCUIElement, with text: String, in app: XCUIApplication) {
        tap(element)
        element.press(forDuration: 1.1)
        let selectAll = app.menuItems["Select All"]
        if selectAll.waitForExistence(timeout: 2) {
            selectAll.tap()
        } else {
            tap(app.buttons["Select All"])
        }
        element.typeText(text + "\n")
    }
    @MainActor private func reveal(_ element: XCUIElement, in app: XCUIApplication) {
        for _ in 0..<16 {
            if element.exists && element.isHittable { return }
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.58))
                .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.36)))
        }
        XCTAssertTrue(element.exists && element.isHittable, element.debugDescription)
    }
    @MainActor private func visible(_ element: XCUIElement) { XCTAssertTrue(element.waitForExistence(timeout: 10), element.debugDescription) }
    @MainActor private func tap(_ element: XCUIElement) { visible(element); element.tap() }
    @MainActor private func enter(_ element: XCUIElement, _ text: String) {
        tap(element)
        element.typeText(text)
        XCTAssertEqual(element.value as? String, text.trimmingCharacters(in: .newlines))
    }
    @MainActor private func capture(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }
}
