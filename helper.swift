import Cocoa

func emit(_ dict: [String: Any]) {
    if let d = try? JSONSerialization.data(withJSONObject: dict),
       let s = String(data: d, encoding: .utf8) {
        print(s)
        fflush(stdout)
    }
}

func idleSeconds() -> Double {
    CGEventSource.secondsSinceLastEventType(.combinedSessionState,
        eventType: CGEventType(rawValue: ~0)!)
}

func getBrowserInfo(bundleId: String) -> [String: String]? {
    let browserScripts: [String: String] = [
        "com.google.Chrome": """
            tell application "Google Chrome"
                if (count of windows) > 0 then
                    set t to title of active tab of front window
                    set u to URL of active tab of front window
                    return t & "\\n" & u
                end if
            end tell
            """,
        "com.microsoft.edgemac": """
            tell application "Microsoft Edge"
                if (count of windows) > 0 then
                    set t to title of active tab of front window
                    set u to URL of active tab of front window
                    return t & "\\n" & u
                end if
            end tell
            """,
        "com.apple.Safari": """
            tell application "Safari"
                if (count of windows) > 0 then
                    set t to name of front document
                    set u to URL of front document
                    return t & "\\n" & u
                end if
            end tell
            """,
        "company.thebrowser.Browser": """
            tell application "Arc"
                if (count of windows) > 0 then
                    set t to title of active tab of front window
                    set u to URL of active tab of front window
                    return t & "\\n" & u
                end if
            end tell
            """,
        "org.mozilla.firefox": """
            tell application "Firefox"
                if (count of windows) > 0 then
                    set t to name of front window
                    return t & "\\n"
                end if
            end tell
            """,
        "com.brave.Browser": """
            tell application "Brave Browser"
                if (count of windows) > 0 then
                    set t to title of active tab of front window
                    set u to URL of active tab of front window
                    return t & "\\n" & u
                end if
            end tell
            """
    ]

    guard let script = browserScripts[bundleId] else { return nil }
    let appleScript = NSAppleScript(source: script)
    var error: NSDictionary?
    guard let result = appleScript?.executeAndReturnError(&error) else { return nil }
    let parts = result.stringValue?.components(separatedBy: "\n") ?? []
    if parts.isEmpty { return nil }
    return [
        "title": parts.count > 0 ? parts[0] : "",
        "url": parts.count > 1 ? parts[1] : ""
    ]
}

let knownBrowserBundles = Set([
    "com.google.Chrome", "com.microsoft.edgemac", "com.apple.Safari",
    "company.thebrowser.Browser", "org.mozilla.firefox", "com.brave.Browser"
])

func emitAppEvent(_ app: NSRunningApplication) {
    let name = app.localizedName ?? ""
    let bundle = app.bundleIdentifier ?? ""
    var dict: [String: Any] = ["type": "app", "name": name, "bundle": bundle]

    if knownBrowserBundles.contains(bundle) {
        if let info = getBrowserInfo(bundleId: bundle) {
            dict["title"] = info["title"]
            dict["url"] = info["url"]
        }
    }
    emit(dict)
}

NSWorkspace.shared.notificationCenter.addObserver(
    forName: NSWorkspace.didActivateApplicationNotification,
    object: nil, queue: .main) { n in
    if let app = n.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication {
        emitAppEvent(app)
    }
}

var wasIdle = false
Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { _ in
    let idle = idleSeconds()
    let isIdle = idle >= 60
    if isIdle != wasIdle {
        wasIdle = isIdle
        emit(["type": "idle", "value": isIdle, "seconds": Int(idle)])
    }
}

if let app = NSWorkspace.shared.frontmostApplication {
    emitAppEvent(app)
}

RunLoop.main.run()
