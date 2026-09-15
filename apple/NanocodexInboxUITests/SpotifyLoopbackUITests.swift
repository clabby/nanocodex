import XCTest

final class SpotifyLoopbackUITests: XCTestCase {
    func testSafariReturnsCodeToPhoneLoopback() {
        let app = XCUIApplication()
        app.launchArguments = ["--spotify-loopback-smoke"]
        app.launch()
        let button = app.buttons["spotify-loopback-open"]
        XCTAssertTrue(button.waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Listener ready"].waitForExistence(timeout: 10))
        button.tap()
        XCTAssertTrue(app.staticTexts["Callback received"].waitForExistence(timeout: 15))
    }
}
