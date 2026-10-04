import XCTest

final class ModelSelectorUITests: XCTestCase {
    func testPinnedModelMenuCreatesNewChatAndChangesModel() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--demo"]
        app.launchEnvironment["NANOCODEX_DEMO_PROFILE"] = UUID().uuidString
        app.launch()

        let picker = app.buttons["model-picker"]
        XCTAssertTrue(picker.waitForExistence(timeout: 10))
        // Tap the padded corner, not just the text, to exercise the full target.
        picker.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: 5, dy: 5)).tap()
        let newChat = app.buttons["model-new-conversation"]
        XCTAssertTrue(newChat.waitForExistence(timeout: 5))
        XCTAssertTrue(newChat.isEnabled)
        let astra = app.buttons["model-choice:gpt-6-astra"]
        XCTAssertTrue(astra.exists)
        XCTAssertFalse(astra.isEnabled, "Started chats must retain their model")
        capture(app, "model-selector-pinned")

        newChat.tap()
        let newTitle = app.buttons.matching(NSPredicate(format:
            "identifier BEGINSWITH 'conversation-title:' AND label == 'New agent'")).firstMatch
        XCTAssertTrue(newTitle.waitForExistence(timeout: 5))
        XCTAssertTrue(newTitle.isSelected)
        picker.tap()
        XCTAssertTrue(astra.waitForExistence(timeout: 5))
        XCTAssertTrue(astra.isEnabled, "A fresh chat must permit model selection")
        let sol = app.buttons["model-choice:gpt-6.1-sol"]
        XCTAssertTrue(sol.isEnabled)
        XCTAssertFalse(newChat.exists)
        sol.tap()
        expectModel("Sol", picker: picker)
        capture(app, "model-selector-sol-selected")

        picker.tap()
        XCTAssertTrue(astra.waitForExistence(timeout: 5))
        astra.tap()
        expectModel("Astra", picker: picker)
        capture(app, "model-selector-astra-selected")
    }

    private func expectModel(_ name: String, picker: XCUIElement) {
        let updated = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "label == %@", "Chat model: " + name), object: picker)
        XCTAssertEqual(XCTWaiter.wait(for: [updated], timeout: 5), .completed)
    }

    private func capture(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
