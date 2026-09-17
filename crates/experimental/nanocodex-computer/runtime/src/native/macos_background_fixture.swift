// Owned background input receiver. Never activates, becomes key, or raises.
import AppKit
let logPath = CommandLine.arguments[1]
func log(_ value: String) {
    let data = (value + "\n").data(using: .utf8)!
    if let handle = FileHandle(forWritingAtPath: logPath) { handle.seekToEndOfFile(); handle.write(data); try? handle.close() }
}
final class InputView: NSView {
    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with event: NSEvent) { log("down \(event.locationInWindow.x) \(event.locationInWindow.y)") }
    override func mouseUp(with event: NSEvent) { log("up") }
    override func mouseDragged(with event: NSEvent) { log("drag") }
    override func otherMouseDown(with event: NSEvent) { log("middle-down \(event.buttonNumber) shift=\(event.modifierFlags.contains(.shift))") }
    override func otherMouseDragged(with event: NSEvent) { log("middle-drag shift=\(event.modifierFlags.contains(.shift))") }
    override func otherMouseUp(with event: NSEvent) { log("middle-up") }
    override func scrollWheel(with event: NSEvent) { log("scroll") }
    override func keyDown(with event: NSEvent) { log("key \(event.characters ?? "")") }
    override func keyUp(with event: NSEvent) { log("keyup") }
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
// AppKit dispatches Command-A through the application's Edit menu, just as in
// a normal document app. Keep the target nil for the standard responder chain.
let menu = NSMenu()
let editItem = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
let edit = NSMenu(title: "Edit")
edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
editItem.submenu = edit
menu.addItem(editItem)
app.mainMenu = menu
let window = NSWindow(contentRect: NSRect(x: 60,y: 60,width: 360,height: 240), styleMask: [.titled], backing: .buffered, defer: false)
window.title = "Nanocodex owned background fixture"
let view = InputView(frame: NSRect(x:0,y:0,width:360,height:240))
view.wantsLayer = true
view.layer?.backgroundColor = NSColor.blue.cgColor
window.contentView = view
let editor = NSTextView(frame: NSRect(x:200,y:0,width:160,height:240))
editor.string = ""
view.addSubview(editor)
window.makeFirstResponder(view)
var lastText = ""
Timer.scheduledTimer(withTimeInterval: 0.01, repeats: true) { _ in
    if editor.string != lastText { lastText = editor.string; log("text-state \(editor.string)") }
    if editor.string == "q" { log("standard-textview q"); editor.string = "reported" }
    if editor.string == "β🧪background" { log("production-textview β🧪background") }
}
window.orderBack(nil)
let height = NSScreen.screens[0].frame.height
let f = window.frame
log("ready \(ProcessInfo.processInfo.processIdentifier) \(window.windowNumber) \(f.origin.x) \(height-f.maxY) \(f.width) \(f.height)")
Timer.scheduledTimer(withTimeInterval: 20, repeats: false) { _ in app.terminate(nil) }
let eventMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .leftMouseUp, .mouseMoved]) { event in
    log("pointer type=\(event.type.rawValue) window=\(event.windowNumber) point=\(event.locationInWindow.x),\(event.locationInWindow.y) key=\(window.isKeyWindow) active=\(app.isActive)")
    return event
}
app.run()
