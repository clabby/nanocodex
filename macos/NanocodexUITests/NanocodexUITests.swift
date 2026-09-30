import XCTest

final class NanocodexUITests: XCTestCase {
    @MainActor
    func testScheduledJobsAreDiscoverableWithoutLosingDraft() throws {
        let app = fixture(theme: "light")
        app.launch(); defer { app.terminate() }
        let composer = app.textViews["message-input"]
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        composer.click(); composer.typeText("Keep this schedule draft")
        let menu = app.descendants(matching: .any).matching(identifier: "workspace-menu").firstMatch
        XCTAssertTrue(menu.waitForExistence(timeout: 5))
        menu.click()
        let schedules = app.menuItems["Scheduled jobs"]
        XCTAssertTrue(schedules.waitForExistence(timeout: 5))
        schedules.click()
        XCTAssertTrue(app.staticTexts["Select a job to edit, pause, or cancel it. Ask an agent in chat to create a new job."].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Refresh"].exists)
        app.buttons["Close"].click()
        XCTAssertEqual(composer.value as? String, "Keep this schedule draft")
    }


    @MainActor
    func testNativeTabsComposerAndHandsNavigation() throws {
        let app = fixture(theme: "light")
        app.launch()
        defer { app.terminate() }
        XCTAssertTrue(app.toolbars.buttons["new-tab"].waitForExistence(timeout: 10), "Conversation actions live in the native window toolbar")
        let composer = app.textViews["message-input"]
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        composer.click(); composer.typeText("A draft in the first tab")
        app.typeKey("t", modifierFlags: .command)
        XCTAssertEqual(composer.value as? String, "")
        composer.click(); composer.typeText("A second draft")
        app.typeKey("w", modifierFlags: .command)
        XCTAssertEqual(composer.value as? String, "A draft in the first tab")
        app.typeKey("t", modifierFlags: [.command, .shift])
        XCTAssertEqual(composer.value as? String, "A second draft")
        XCTAssertGreaterThanOrEqual(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "select-browser-tab-")).count, 2)
        app.typeKey("h", modifierFlags: [.command, .shift])
        XCTAssertTrue(app.otherElements["hands-page"].waitForExistence(timeout: 3))
        capture(app, name: "native-window-hands")
    }

    @MainActor
    func testNativeGlassWindowThemesAndPaneShortcuts() throws {
        for theme in ["light", "dark"] {
            let app = fixture(theme: theme)
            app.launch()
            XCTAssertTrue(app.toolbars.buttons["new-tab"].waitForExistence(timeout: 10))
            let editor = app.textViews["message-input"]
            XCTAssertTrue(editor.waitForExistence(timeout: 5))
            editor.click(); editor.typeText("Keep my draft while I arrange the workspace")
            capture(app, name: "native-window-\(theme)")
            app.typeKey(XCUIKeyboardKey.escape, modifierFlags: [])
            app.typeKey("v", modifierFlags: [])
            XCTAssertTrue(app.textViews.matching(identifier: "message-input").element(boundBy: 1).waitForExistence(timeout: 3))
            app.typeKey("h", modifierFlags: [])
            XCTAssertTrue(app.textViews.matching(identifier: "message-input").element(boundBy: 2).waitForExistence(timeout: 3))
            capture(app, name: "native-window-splits-\(theme)")
            app.typeKey(",", modifierFlags: .command)
            XCTAssertTrue(app.buttons["Done"].waitForExistence(timeout: 3))
            capture(app, name: "native-window-settings-\(theme)")
            app.buttons["Done"].click()
            app.terminate()
        }
    }

    /// Native controls talk through ManagedClient to the real local account
    /// router/D1 fixture. No library operations or response models are mocked.
    @MainActor
    func testSyncedMeetingsNotesSummaryDraftAndDeletion() async throws {
        let id = UUID().uuidString.lowercased(), other = UUID().uuidString.lowercased(), large = UUID().uuidString.lowercased(), notesOnly = UUID().uuidString.lowercased()
        let initial: [String: Any] = ["revision": 1, "title": "Mac journey \(id)",
            "started_at": "2026-09-30T10:00:00Z", "duration_seconds": 83,
            "transcript": "Alex will share the proposal. Sam will review the budget tomorrow.",
            "notes": "Saved on iPhone", "partial": true]
        _ = try await meetingsHTTP("/v1/meetings/" + id, method: "PUT", body: initial)
        var second = initial; second["title"] = "Other Mac recording \(other)"; second["partial"] = false
        _ = try await meetingsHTTP("/v1/meetings/" + other, method: "PUT", body: second)
        var oversized = initial; oversized["title"] = "Large Mac recording \(large)"
        oversized["transcript"] = "BEGIN_FULL_SOURCE_\(large)\n" + String(repeating: "Full transcript content. ", count: 1800) + "\nEND_FULL_SOURCE_\(large)"
        _ = try await meetingsHTTP("/v1/meetings/" + large, method: "PUT", body: oversized)
        var withoutSpeech = initial; withoutSpeech["title"] = "Notes-only Mac recording \(notesOnly)"
        withoutSpeech["transcript"] = ""; withoutSpeech["notes"] = "Discussed the proposal. Sam owns the budget review."
        _ = try await meetingsHTTP("/v1/meetings/" + notesOnly, method: "PUT", body: withoutSpeech)
        let app = fixture(theme: "light")
        app.launchEnvironment["NANOCODEX_NATIVE_MEETINGS_HTTP_FIXTURE"] = "1"
        app.launchEnvironment["NANOCODEX_NATIVE_MEETINGS_DROP_SAVE_RESPONSE"] = "1"
        app.launch(); defer { app.terminate() }
        XCTAssertTrue(app.buttons["workspace-meetings"].waitForExistence(timeout: 10))
        app.buttons["workspace-meetings"].click()
        let row = app.buttons["meeting-row-" + id]
        XCTAssertTrue(row.waitForExistence(timeout: 15)); row.click()
        let notes = app.textViews["meeting-notes-editor"]
        XCTAssertTrue(notes.waitForExistence(timeout: 10))
        XCTAssertEqual(notes.value as? String, "Saved on iPhone")
        XCTAssertTrue(app.staticTexts["Partial recording · capture ended early"].exists)
        XCTAssertTrue(app.staticTexts["Create a summary from the saved transcript."].exists)
        notes.click(); app.typeKey("a", modifierFlags: .command); notes.typeText("Mac notes are separate")
        app.buttons["meeting-save-notes"].click()
        XCTAssertTrue(app.buttons["Retry sync"].waitForExistence(timeout: 10))
        let savedBody = try await meetingsHTTP("/v1/meetings/" + id)
        let meeting = try XCTUnwrap(savedBody["meeting"] as? [String: Any])
        XCTAssertEqual(meeting["notes"] as? String, "Mac notes are separate")
        XCTAssertEqual(meeting["revision"] as? Int, 2, "Native save advances backend revision even when its response is lost")
        capture(app, name: "native-meetings-lost-save-response")
        notes.click(); app.typeKey("a", modifierFlags: .command); notes.typeText("Mac notes are separate · newer draft")
        app.buttons["meeting-save-notes"].click()
        XCTAssertTrue(app.buttons["Save notes"].waitForExistence(timeout: 10))
        XCTAssertEqual(notes.value as? String, "Mac notes are separate · newer draft")
        let replay = try await meetingsHTTP("/v1/meetings/" + id)
        XCTAssertEqual((replay["meeting"] as? [String: Any])?["revision"] as? Int, 2)
        XCTAssertEqual((replay["meeting"] as? [String: Any])?["notes"] as? String, "Mac notes are separate", "Retry replays immutable payload, not newer typing")
        app.buttons["meeting-save-notes"].click()
        let saved = NSPredicate(format: "enabled == false")
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: saved, object: app.buttons["meeting-save-notes"])], timeout: 10), .completed)
        let newer = try await meetingsHTTP("/v1/meetings/" + id)
        XCTAssertEqual((newer["meeting"] as? [String: Any])?["revision"] as? Int, 3)
        XCTAssertEqual((newer["meeting"] as? [String: Any])?["notes"] as? String, "Mac notes are separate · newer draft")
        _ = try await meetingsHTTP("/__fixture/provider", method: "POST", body: ["fail": true])
        app.buttons["meeting-summarize"].click()
        XCTAssertTrue(app.buttons["Retry summary"].waitForExistence(timeout: 15))
        XCTAssertEqual(notes.value as? String, "Mac notes are separate · newer draft")
        capture(app, name: "native-meetings-summary-unavailable")
        _ = try await meetingsHTTP("/__fixture/provider", method: "POST", body: ["fail": false])
        app.buttons["meeting-summarize"].click()
        XCTAssertTrue(app.buttons["Refresh enhanced notes"].waitForExistence(timeout: 15))
        let summarized = try await meetingsHTTP("/v1/meetings/" + id)
        let summaryRecord = try XCTUnwrap(summarized["meeting"] as? [String: Any])
        XCTAssertEqual(summaryRecord["summary_status"] as? String, "ready")
        XCTAssertEqual(summaryRecord["revision"] as? Int, 3, "Known inference failure retries the same saved revision")
        XCTAssertFalse((summaryRecord["summary"] as? String ?? "").isEmpty)
        XCTAssertEqual(notes.value as? String, "Mac notes are separate · newer draft")
        notes.click(); app.typeKey("a", modifierFlags: .command); notes.typeText("Unsaved draft survives navigation")
        app.buttons["meeting-row-" + other].click()
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", "Saved on iPhone"), object: notes)], timeout: 10), .completed)
        row.click()
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", "Unsaved draft survives navigation"), object: notes)], timeout: 10), .completed)
        app.typeKey("h", modifierFlags: [.command, .shift])
        XCTAssertTrue(app.otherElements["hands-page"].waitForExistence(timeout: 5))
        app.typeKey("m", modifierFlags: [.command, .shift])
        XCTAssertTrue(notes.waitForExistence(timeout: 10))
        XCTAssertEqual(notes.value as? String, "Unsaved draft survives navigation")
        app.typeKey("h", modifierFlags: .command)
        XCTAssertTrue(app.wait(for: .runningBackground, timeout: 5))
        app.activate()
        XCTAssertTrue(notes.waitForExistence(timeout: 10))
        XCTAssertEqual(notes.value as? String, "Unsaved draft survives navigation")
        let transcript = app.radioButtons["Transcript"].exists ? app.radioButtons["Transcript"] : app.buttons["Transcript"]
        transcript.click()
        XCTAssertTrue(app.staticTexts[initial["transcript"] as! String].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Audio is not stored. Playback is unavailable."].exists)
        capture(app, name: "native-meetings-transcript-partial")
        app.buttons["meeting-delete"].click()
        XCTAssertTrue(app.buttons["Delete recording"].waitForExistence(timeout: 5)); app.buttons["Delete recording"].click()
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: row)], timeout: 10), .completed)
        _ = try await meetingsHTTP("/v1/meetings/" + id, expected: 404)
        capture(app, name: "native-meetings-deleted")
        app.buttons["meeting-row-" + large].click()
        XCTAssertTrue(app.buttons["meeting-delete"].waitForExistence(timeout: 10))
        let notesTab = app.radioButtons["Notes"].exists ? app.radioButtons["Notes"] : app.buttons["Notes"]
        notesTab.click()
        let beforeLong = try await meetingsHTTP("/__fixture/provider")
        app.buttons["meeting-summarize"].click()
        XCTAssertTrue(app.buttons["Refresh enhanced notes"].waitForExistence(timeout: 30))
        let afterLong = try await meetingsHTTP("/__fixture/provider")
        XCTAssertGreaterThan((afterLong["calls"] as? Int ?? 0) - (beforeLong["calls"] as? Int ?? 0), 1, "Long recordings use multiple full-source inference chunks")
        let providerRequests = Array((afterLong["requests"] as? [[String: Any]] ?? []).dropFirst(beforeLong["calls"] as? Int ?? 0))
        let providerData = try JSONSerialization.data(withJSONObject: providerRequests, options: [.prettyPrinted, .sortedKeys])
        let providerText = String(decoding: providerData, as: UTF8.self)
        XCTAssertTrue(providerText.contains("BEGIN_FULL_SOURCE_" + large))
        XCTAssertTrue(providerText.contains("END_FULL_SOURCE_" + large))
        let trace = XCTAttachment(data: providerData, uniformTypeIdentifier: "public.json")
        trace.name = "native-meetings-full-source-provider-requests"; trace.lifetime = .keepAlways; add(trace)
        let preserved = try await meetingsHTTP("/v1/meetings/" + large)
        let preservedRecord = try XCTUnwrap(preserved["meeting"] as? [String: Any])
        XCTAssertEqual(preservedRecord["transcript"] as? String, oversized["transcript"] as? String)
        XCTAssertEqual(preservedRecord["notes"] as? String, "Saved on iPhone")
        XCTAssertEqual(preservedRecord["summary_status"] as? String, "ready")
        capture(app, name: "native-meetings-long-full-source-summary")
        notes.click(); app.typeKey("a", modifierFlags: .command); notes.typeText("Keep this Mac conflict draft")
        var cloudEdit = oversized; cloudEdit["revision"] = 2; cloudEdit["notes"] = "New notes from another device"
        _ = try await meetingsHTTP("/v1/meetings/" + large, method: "PUT", body: cloudEdit, ifMatch: 1)
        app.buttons["meeting-save-notes"].click()
        XCTAssertTrue(app.staticTexts["This recording changed on another device. Your draft is preserved. Save a copy before reloading the latest version."].waitForExistence(timeout: 10))
        XCTAssertEqual(notes.value as? String, "Keep this Mac conflict draft")
        capture(app, name: "native-meetings-cloud-conflict-draft")
        app.buttons["Reload latest version"].click()
        XCTAssertTrue(app.buttons["Discard changes"].waitForExistence(timeout: 5)); app.buttons["Discard changes"].click()
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", "New notes from another device"), object: notes)], timeout: 10), .completed)
        let latest = try await meetingsHTTP("/v1/meetings/" + large)
        XCTAssertEqual((latest["meeting"] as? [String: Any])?["notes"] as? String, "New notes from another device")
        _ = try await meetingsHTTP("/v1/meetings/" + other, method: "DELETE", expected: 204)
        _ = try await meetingsHTTP("/v1/meetings/" + large, method: "DELETE", expected: 204)
        app.buttons["meeting-row-" + notesOnly].click()
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", withoutSpeech["notes"] as! String), object: notes)], timeout: 10), .completed)
        XCTAssertTrue(app.buttons["meeting-summarize"].isEnabled, "Saved notes-only recordings can generate enhanced notes")
        app.buttons["meeting-summarize"].click()
        XCTAssertTrue(app.buttons["Refresh enhanced notes"].waitForExistence(timeout: 15))
        let enhancedNotes = try await meetingsHTTP("/v1/meetings/" + notesOnly)
        XCTAssertEqual((enhancedNotes["meeting"] as? [String: Any])?["summary_status"] as? String, "ready")
        XCTAssertEqual((enhancedNotes["meeting"] as? [String: Any])?["transcript"] as? String, "")
        capture(app, name: "native-meetings-notes-only-summary")
        let emptyTranscript = app.radioButtons["Transcript"].exists ? app.radioButtons["Transcript"] : app.buttons["Transcript"]
        emptyTranscript.click()
        XCTAssertTrue(app.staticTexts["No speech was captured."].waitForExistence(timeout: 5))
        _ = try await meetingsHTTP("/v1/meetings/" + notesOnly, method: "DELETE", expected: 204)
    }

    private func meetingsHTTP(_ path: String, method: String = "GET", body: [String: Any]? = nil, expected: Int = 200, ifMatch: Int? = nil) async throws -> [String: Any] {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:8797" + path)!)
        request.httpMethod = method
        if let ifMatch { request.setValue("\"\(ifMatch)\"", forHTTPHeaderField: "If-Match") }
        request.setValue("Bearer ncx_live_abcdefgh1234_" + String(repeating: "x", count: 43), forHTTPHeaderField: "Authorization")
        if let body { request.setValue("application/json", forHTTPHeaderField: "Content-Type"); request.httpBody = try JSONSerialization.data(withJSONObject: body) }
        let (data, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, expected, String(data: data, encoding: .utf8) ?? "")
        if data.isEmpty { return [:] }
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    @MainActor
    private func fixture(theme: String) -> XCUIApplication {
        let app = ProcessInfo.processInfo.environment["NANOCODEX_UI_APP_PATH"].map { XCUIApplication(url: URL(fileURLWithPath: $0)) } ?? XCUIApplication()
        app.launchEnvironment["NANOCODEX_DESKTOP_DATA"] = NSTemporaryDirectory() + "nanocodex-native-ui-" + UUID().uuidString
        app.launchEnvironment["NANOCODEX_NATIVE_UI_FIXTURE"] = "1"
        app.launchEnvironment["NANOCODEX_NATIVE_UI_THEME"] = theme
        return app
    }

    @MainActor
    private func capture(_ app: XCUIApplication, name: String) {
        let screenshot = app.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
        // The UI runner is sandboxed. Keep screenshots in the result bundle;
        // export them with xcresulttool after the test completes.
    }
}
