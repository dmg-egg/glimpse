import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.platform !== 'darwin') {
  console.log('Cmd-W native Cocoa test skipped: macOS only');
} else {
  const tmpDir = mkdtempSync(join(tmpdir(), 'glimpse-cmd-w-'));
  try {
    const source = readFileSync(new URL('../src/glimpse.swift', import.meta.url), 'utf8');
    const entryPoint = '// MARK: - Entry Point';
    assert.equal(source.split(entryPoint).length, 2, 'expected one native entry point');
    assert.equal(source.split('private func installEditMenu()').length, 2, 'expected the production Edit menu');
    // Compile the production panel, Edit menu and close delegate with a test-only
    // entry point. No WebView, AppleScript, event posting or OS permissions needed.
    const harnessSource = source.slice(0, source.indexOf(entryPoint))
      .replace('private func installEditMenu()', 'func installEditMenu()') + `
@MainActor
final class RecordingResponder: NSResponder {
    var actions: [String] = []
    @objc func copy(_ sender: NSObject?) { actions.append("copy") }
    @objc func cut(_ sender: NSObject?) { actions.append("cut") }
    @objc func paste(_ sender: NSObject?) { actions.append("paste") }
    @objc func selectAll(_ sender: NSObject?) { actions.append("selectAll") }
    @objc func undo(_ sender: NSObject?) { actions.append("undo") }
    @objc func redo(_ sender: NSObject?) { actions.append("redo") }
}

@MainActor
final class RecordingPanel: GlimpsePanel {
    var closeRequests = 0
    var allowClose = false
    override func close() {
        closeRequests += 1
        if allowClose { super.close() }
    }
}

@MainActor
func require(_ condition: @autoclosure () -> Bool, _ message: String) {
    guard condition() else {
        fputs("Native keyboard assertion failed: \\(message)\\n", stderr)
        exit(1)
    }
}

@MainActor
func key(_ chars: String, _ modifiers: NSEvent.ModifierFlags) -> NSEvent {
    let keyCodes: [String: UInt16] = ["a": 0, "c": 8, "v": 9, "w": 13, "x": 7, "z": 6]
    guard let keyCode = keyCodes[chars.lowercased()],
          let event = NSEvent.keyEvent(with: .keyDown, location: .zero,
        modifierFlags: modifiers, timestamp: 0, windowNumber: 0,
        context: nil, characters: chars, charactersIgnoringModifiers: chars,
        isARepeat: false, keyCode: keyCode) else {
        fatalError("Cannot construct a native key event")
    }
    return event
}

precondition(Thread.isMainThread)
MainActor.assumeIsolated {
    let app = NSApplication.shared
    let accessory = CommandLine.arguments.contains("accessory")
    app.setActivationPolicy(accessory ? .accessory : .regular)
    let delegate = AppDelegate(config: Config())
    let panel = RecordingPanel(contentRect: NSRect(x: 0, y: 0, width: 200, height: 100),
        styleMask: accessory ? [.borderless] : [.titled, .closable],
        backing: .buffered, defer: false)
    panel.isReleasedWhenClosed = false
    panel.delegate = delegate
    delegate.window = panel
    require(panel.canBecomeKey && panel.canBecomeMain, "keyboard eligibility unchanged")

    let responder = RecordingResponder()
    delegate.installEditMenu()
    require(app.mainMenu?.numberOfItems == 1, "production Edit menu installed")
    let editMenu = app.mainMenu!.item(at: 0)!.submenu!
    let menuConfig: [(String, String, String, NSEvent.ModifierFlags)] = [
        ("Undo", "undo:", "z", .command), ("Redo", "redo:", "z", [.command, .shift]),
        ("Cut", "cut:", "x", .command), ("Copy", "copy:", "c", .command),
        ("Paste", "paste:", "v", .command), ("Select All", "selectAll:", "a", .command)
    ]
    for (title, selector, chars, modifiers) in menuConfig {
        guard let item = editMenu.items.first(where: { $0.title == title }) else {
            fatalError("Missing production menu item: \\(title)")
        }
        require(item.action == Selector((selector)), "menu selector: \\(title)")
        require(item.keyEquivalent == chars, "menu key equivalent: \\(title)")
        require(item.keyEquivalentModifierMask == modifiers, "menu modifiers: \\(title)")
        require(item.target == nil, "production menu uses responder-chain targets")
        item.target = responder
    }
    let editing: [(String, NSEvent.ModifierFlags, String)] = [
        ("c", .command, "copy"), ("x", .command, "cut"),
        ("v", .command, "paste"), ("a", .command, "selectAll"),
        ("z", .command, "undo"), ("Z", [.command, .shift], "redo")
    ]
    // Shift is retained in charactersIgnoringModifiers, as documented by NSEvent.
    // Dynamic shifted menu delivery is not covered; verify that configuration
    // above and its production responder-chain fallback below instead.
    for (chars, modifiers, expected) in editing where modifiers == .command {
        responder.actions.removeAll()
        let event = key(chars, modifiers)
        let handled = panel.performKeyEquivalent(with: event)
        let detail = "menu expected=\\(expected) actual=\\(responder.actions) chars=\\(event.characters ?? "nil") ignoring=\\(event.charactersIgnoringModifiers ?? "nil") modifiers=\\(event.modifierFlags.rawValue) keyCode=\\(event.keyCode)"
        require(handled, detail + " handled=false")
        require(responder.actions == [expected], detail)
        require(panel.closeRequests == 0, "editing must not close")
    }
    app.mainMenu = nil
    app.nextResponder = responder
    for (chars, modifiers, expected) in editing {
        let selector = Selector((expected + ":"))
        require(app.target(forAction: selector, to: nil, from: panel) as? RecordingResponder === responder,
            "AppKit responder-chain target: \\(expected)")
        responder.actions.removeAll()
        let event = key(chars, modifiers)
        let handled = panel.performKeyEquivalent(with: event)
        let detail = "fallback expected=\\(expected) actual=\\(responder.actions) chars=\\(event.characters ?? "nil") ignoring=\\(event.charactersIgnoringModifiers ?? "nil") modifiers=\\(event.modifierFlags.rawValue) keyCode=\\(event.keyCode)"
        require(handled, detail + " handled=false")
        require(responder.actions == [expected], detail)
        require(panel.closeRequests == 0, "editing fallback must not close")
    }
    for (chars, modifiers) in [
        ("w", NSEvent.ModifierFlags()), ("w", .shift),
        ("W", [.command, .shift]), ("w", [.command, .option]),
        ("w", [.command, .control]), ("c", [.command, .shift]),
        ("W", .capsLock), ("W", [.command, .capsLock, .shift]),
        ("W", [.command, .capsLock, .option]), ("W", [.command, .capsLock, .control]),
        ("C", [.command, .capsLock]), ("Z", [.command, .capsLock, .shift])
    ] {
        require(!panel.performKeyEquivalent(with: key(chars, modifiers)), "unmapped variant must pass through")
        require(panel.closeRequests == 0, "unmapped variant must not close")
    }
    require(panel.performKeyEquivalent(with: key("w", .command)), "Cmd-W handled")
    require(panel.closeRequests == 1, "Cmd-W requests close exactly once")
    panel.closeRequests = 0
    require(panel.performKeyEquivalent(with: key("W", .command)), "case-insensitive Cmd-W handled")
    require(panel.closeRequests == 1, "uppercase Cmd-W requests close exactly once")
    panel.closeRequests = 0
    require(panel.performKeyEquivalent(with: key("W", [.command, .capsLock])), "Caps Lock Cmd-W handled")
    require(panel.closeRequests == 1, "Caps Lock Cmd-W requests close exactly once")

    // This last key invokes NSWindow.close() and the production windowWillClose:
    // it must emit one closed event and exit(0), not a page message or hide action.
    panel.allowClose = true
    _ = panel.performKeyEquivalent(with: key("W", [.command, .capsLock]))
    fputs("Native close delegate did not terminate\\n", stderr)
    exit(1)
}
`;
    const swiftPath = join(tmpDir, 'keyboard.swift');
    const binaryPath = join(tmpDir, 'keyboard');
    writeFileSync(swiftPath, harnessSource);
    const build = spawnSync('swiftc', ['-O', swiftPath, '-o', binaryPath], {
      encoding: 'utf8', timeout: 120_000,
    });
    assert.ifError(build.error);
    assert.equal(build.status, 0, build.stderr);
    const modes = process.argv.includes('--compile-only') ? [] : ['regular', 'accessory'];
    if (modes.length === 0) console.log('  ✓ native keyboard harness compiled (not executed)');
    for (const mode of modes) {
      const result = spawnSync(binaryPath, [mode], { encoding: 'utf8', timeout: 10_000 });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, '{"type":"closed"}\n', 'one closed event, no message/decision');
      console.log(`  ✓ native Cocoa Cmd-W lifecycle, editing fallback and menu configuration (${mode})`);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
