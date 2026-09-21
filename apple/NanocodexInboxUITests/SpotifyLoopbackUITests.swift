import XCTest

final class SpotifyLoopbackUITests: XCTestCase {
    func testSafariReturnsCodeToPhoneLoopback() { checkSafari("spotify") }
    func testSoundCloudSafariReturnsCodeToPhoneLoopback() { checkSafari("soundcloud") }

    private func checkSafari(_ provider: String) {
        let app = XCUIApplication()
        app.launchArguments = ["--\(provider)-loopback-smoke"]
        app.launch()
        let button = app.buttons["spotify-loopback-open"]
        XCTAssertTrue(button.waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Listener ready"].waitForExistence(timeout: 10))
        button.tap()
        XCTAssertTrue(app.staticTexts["Callback received"].waitForExistence(timeout: 15))
    }
}
