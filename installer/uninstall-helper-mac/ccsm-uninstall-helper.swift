// ccsm-uninstall-helper — macOS Mach-O uninstall helper (Task #136 / frag-11 §11.6.4).
//
// Spec citations:
//   - docs/superpowers/specs/v0.3-fragments/frag-11-packaging.md §11.6.2
//     "macOS apps have no uninstaller. The user drags `CCSM.app` to Trash;
//      `~/Library/Application Support/ccsm/` survives." — drag-to-Trash is
//     NOT enough when the daemon is still running (file locks on the
//     ~/Library/Application Support/ccsm/data SQLite db) AND it leaves the
//     entire dataRoot behind. This helper provides the mac equivalent of
//     the Linux postrm script (§11.6.3).
//   - frag-11 §11.6.4 — "cross-platform pkg-bundling produces a Mach-O for
//     completeness and the codesign loop signs it (`daemon/dist/
//     ccsm-uninstall-helper-macos-$arch`) so future tray-driven 'Reset
//     CCSM' flows on mac can shell out to it without Gatekeeper rejection."
//   - frag-11 §11.6 paths table — daemon-owned mac paths:
//       ~/Library/Application Support/ccsm/daemon.lock     (PID lockfile)
//       ~/Library/Application Support/ccsm/daemon.secret
//       ~/Library/Application Support/ccsm/data/
//       ~/Library/Application Support/ccsm/logs/
//       ~/Library/Application Support/ccsm/crashes/
//
// Behaviour (mirrors build/linux-postrm.sh in semantics, adapted for mac):
//   1. Read daemon.lock — extract PID (proper-lockfile writes a one-line
//      decimal PID at the lockfile path) — and SIGTERM, then SIGKILL after
//      a short grace period if still alive.
//   2. Delete the daemon.lock so a stale lockfile cannot block a fresh
//      install of a future build.
//   3. With --purge (opt-in), recursively delete the entire dataRoot
//      (~/Library/Application Support/ccsm/) — equivalent to the Linux
//      postrm SUDO_USER branch. Without --purge: dataRoot is retained
//      (matches §11.6 paths table "Cleanup default = retained").
//   4. With --dry-run, print every action that WOULD be taken but mutate
//      nothing — used by the CI smoke gate (Gates §3) so we can run the
//      helper on a runner without an actual daemon.
//
// Single Responsibility (dev.md §2):
//   PRODUCER: parseArgs / resolveDataRoot — read inputs.
//   DECIDER:  decideActions — pure function (env, args, fs probes) → list
//             of Action enum values. No I/O.
//   SINK:     executeActions — runs each Action against FileManager + kill.
//
// Exit codes:
//   0 — success OR daemon already stopped + lock already gone (idempotent).
//   1 — hard failure (couldn't kill a live PID, or rm failed on a path
//       the user owns).
//   2 — usage error (bad CLI args).
//
// Build: this file is compiled by scripts/build-mac-uninstall-helper.sh
// into per-arch Mach-O thin binaries, then `lipo`-merged into a universal
// (CAFEBABE) binary. No Swift Package Manager — single-file `swiftc`
// invocation keeps the toolchain surface minimal (mac-default Xcode
// command-line tools are sufficient; no third-party deps).

import Foundation

// MARK: - CLI args ------------------------------------------------------

struct Args {
    var purge: Bool = false
    var dryRun: Bool = false
    var dataRoot: String? = nil  // override for tests; default = HOME-derived
    var graceSeconds: Double = 2.0
    var help: Bool = false
}

enum ParseError: Error {
    case unknownFlag(String)
    case missingValue(String)
    case badNumber(String, String)
}

func parseArgs(_ argv: [String]) throws -> Args {
    var args = Args()
    var i = 0
    while i < argv.count {
        let a = argv[i]
        switch a {
        case "--purge":
            args.purge = true
        case "--dry-run":
            args.dryRun = true
        case "--data-root":
            i += 1
            guard i < argv.count else { throw ParseError.missingValue(a) }
            args.dataRoot = argv[i]
        case "--grace":
            i += 1
            guard i < argv.count else { throw ParseError.missingValue(a) }
            guard let v = Double(argv[i]), v >= 0 else {
                throw ParseError.badNumber(a, argv[i])
            }
            args.graceSeconds = v
        case "--help", "-h":
            args.help = true
        default:
            throw ParseError.unknownFlag(a)
        }
        i += 1
    }
    return args
}

let HELP = """
ccsm-uninstall-helper — macOS uninstall helper (frag-11 §11.6.4)

Usage:
  ccsm-uninstall-helper [--purge] [--dry-run] [--grace SECS] [--data-root PATH]

Behaviour:
  1. Read ~/Library/Application Support/ccsm/daemon.lock for PID.
  2. SIGTERM the daemon, wait up to --grace seconds, then SIGKILL.
  3. Delete daemon.lock.
  4. With --purge: rm -rf the entire data root.

Options:
  --purge          Also delete the entire data root (default: keep user data).
  --dry-run        Print actions without mutating anything.
  --grace SECS     Seconds to wait for SIGTERM before SIGKILL (default: 2).
  --data-root PATH Override the data root (default: ~/Library/Application Support/ccsm).
  --help, -h       Show this help.

Exit codes:
  0  success (idempotent: missing daemon / missing lockfile is OK)
  1  hard failure (couldn't kill a live PID, or rm failed)
  2  usage error
"""

// MARK: - Path resolution ----------------------------------------------

func resolveDataRoot(env: [String: String], override: String?) -> String {
    if let o = override { return o }
    let home = env["HOME"] ?? NSHomeDirectory()
    // Lowercase `ccsm` per task #132. Path matches frag-11 §11.6 paths
    // table mac column.
    return "\(home)/Library/Application Support/ccsm"
}

// MARK: - Decider (pure) -----------------------------------------------

enum Action: Equatable {
    case killPid(pid: Int32, graceSeconds: Double)
    case removeFile(path: String)
    case removeTree(path: String)
    case logSkip(reason: String, path: String)
}

// FileSystem probe abstraction so the decider stays pure (testable).
protocol FSProbe {
    func fileExists(_ path: String) -> Bool
    func readLockfile(_ path: String) -> String?
}

struct RealFSProbe: FSProbe {
    func fileExists(_ path: String) -> Bool {
        return FileManager.default.fileExists(atPath: path)
    }
    func readLockfile(_ path: String) -> String? {
        return try? String(contentsOfFile: path, encoding: .utf8)
    }
}

func parsePid(_ raw: String) -> Int32? {
    // proper-lockfile writes a single-line decimal PID. Be liberal in what
    // we accept: trim whitespace, take first token, reject 0/negative.
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    let firstToken = trimmed.split(whereSeparator: { $0.isWhitespace }).first.map(String.init) ?? trimmed
    guard let n = Int32(firstToken), n > 0 else { return nil }
    return n
}

func decideActions(args: Args, dataRoot: String, probe: FSProbe) -> [Action] {
    var actions: [Action] = []
    let lockPath = "\(dataRoot)/daemon.lock"

    // Step 1: kill daemon if lockfile present + parseable PID.
    if probe.fileExists(lockPath) {
        if let raw = probe.readLockfile(lockPath), let pid = parsePid(raw) {
            actions.append(.killPid(pid: pid, graceSeconds: args.graceSeconds))
        } else {
            actions.append(.logSkip(reason: "lockfile-unreadable-or-empty", path: lockPath))
        }
        // Step 2: always remove the lockfile (stale PID risk on next install).
        actions.append(.removeFile(path: lockPath))
    } else {
        actions.append(.logSkip(reason: "no-lockfile", path: lockPath))
    }

    // Step 3 (opt-in): purge entire data root.
    if args.purge {
        if probe.fileExists(dataRoot) {
            actions.append(.removeTree(path: dataRoot))
        } else {
            actions.append(.logSkip(reason: "data-root-missing", path: dataRoot))
        }
    }

    return actions
}

// MARK: - Sink ---------------------------------------------------------

protocol Sink {
    func killPid(_ pid: Int32, graceSeconds: Double) -> Bool
    func removeFile(_ path: String) -> Bool
    func removeTree(_ path: String) -> Bool
    func log(_ msg: String)
}

struct RealSink: Sink {
    let dryRun: Bool

    func log(_ msg: String) {
        FileHandle.standardError.write(Data(("[ccsm-uninstall-helper] " + msg + "\n").utf8))
    }

    func killPid(_ pid: Int32, graceSeconds: Double) -> Bool {
        if dryRun {
            log("DRY-RUN would SIGTERM pid=\(pid) (grace=\(graceSeconds)s) then SIGKILL")
            return true
        }
        // SIGTERM (15) — let the daemon flush.
        let term = kill(pid, SIGTERM)
        if term != 0 && errno == ESRCH {
            log("pid=\(pid) already gone (ESRCH); idempotent OK")
            return true
        }
        if term != 0 {
            log("kill SIGTERM pid=\(pid) failed errno=\(errno)")
            // Don't return false yet — try SIGKILL.
        }
        // Poll for up to graceSeconds.
        let deadline = Date().addingTimeInterval(graceSeconds)
        while Date() < deadline {
            // kill(pid, 0) probes liveness without delivering a signal.
            if kill(pid, 0) != 0 && errno == ESRCH {
                log("pid=\(pid) exited within grace")
                return true
            }
            usleep(50_000)  // 50ms poll
        }
        // Still alive — SIGKILL (9).
        let killed = kill(pid, SIGKILL)
        if killed != 0 && errno != ESRCH {
            log("kill SIGKILL pid=\(pid) failed errno=\(errno)")
            return false
        }
        log("pid=\(pid) SIGKILLed after \(graceSeconds)s grace")
        return true
    }

    func removeFile(_ path: String) -> Bool {
        if dryRun {
            log("DRY-RUN would unlink \(path)")
            return true
        }
        do {
            try FileManager.default.removeItem(atPath: path)
            log("removed file \(path)")
            return true
        } catch let err as NSError {
            // ENOENT-equivalent — already gone. Idempotent OK.
            if err.code == NSFileNoSuchFileError { return true }
            log("removeFile \(path) failed: \(err.localizedDescription)")
            return false
        }
    }

    func removeTree(_ path: String) -> Bool {
        if dryRun {
            log("DRY-RUN would rm -rf \(path)")
            return true
        }
        do {
            try FileManager.default.removeItem(atPath: path)
            log("removed tree \(path)")
            return true
        } catch let err as NSError {
            if err.code == NSFileNoSuchFileError { return true }
            log("removeTree \(path) failed: \(err.localizedDescription)")
            return false
        }
    }
}

func executeActions(_ actions: [Action], sink: Sink) -> Int32 {
    var hardFailed = false
    for action in actions {
        switch action {
        case .killPid(let pid, let grace):
            if !sink.killPid(pid, graceSeconds: grace) { hardFailed = true }
        case .removeFile(let p):
            if !sink.removeFile(p) { hardFailed = true }
        case .removeTree(let p):
            if !sink.removeTree(p) { hardFailed = true }
        case .logSkip(let reason, let path):
            sink.log("skip (\(reason)): \(path)")
        }
    }
    return hardFailed ? 1 : 0
}

// MARK: - Main ---------------------------------------------------------

func main() -> Int32 {
    let argv = Array(CommandLine.arguments.dropFirst())
    let args: Args
    do {
        args = try parseArgs(argv)
    } catch ParseError.unknownFlag(let f) {
        FileHandle.standardError.write(Data("error: unknown flag \(f)\n\n\(HELP)\n".utf8))
        return 2
    } catch ParseError.missingValue(let f) {
        FileHandle.standardError.write(Data("error: \(f) requires a value\n\n\(HELP)\n".utf8))
        return 2
    } catch ParseError.badNumber(let f, let v) {
        FileHandle.standardError.write(Data("error: \(f) bad number '\(v)'\n\n\(HELP)\n".utf8))
        return 2
    } catch {
        FileHandle.standardError.write(Data("error: \(error)\n\n\(HELP)\n".utf8))
        return 2
    }

    if args.help {
        print(HELP)
        return 0
    }

    let env = ProcessInfo.processInfo.environment
    let dataRoot = resolveDataRoot(env: env, override: args.dataRoot)
    let sink = RealSink(dryRun: args.dryRun)
    sink.log("dataRoot=\(dataRoot) purge=\(args.purge) dryRun=\(args.dryRun)")

    let probe = RealFSProbe()
    let actions = decideActions(args: args, dataRoot: dataRoot, probe: probe)
    return executeActions(actions, sink: sink)
}

exit(main())
