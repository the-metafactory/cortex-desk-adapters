// desk-reminders-mac: the Desk reminder writer. Reads one reminder request on stdin and saves it to Apple Reminders
// through EventKit, with an alarm at the due time.
//
// Like desk-calendar-mac it re-launches itself with responsibility disclaimed, so the Reminders grant belongs to
// this binary whoever starts it. stdin is read only after the relaunch, and every input check runs before any
// EventKit access, so a refused request touches nothing.
//
// Usage: desk-reminders-mac [--list <name>] | --check-access

import EventKit
import Foundation

@_silgen_name("responsibility_spawnattrs_setdisclaim")
func responsibility_spawnattrs_setdisclaim(_ attrs: UnsafeMutablePointer<posix_spawnattr_t?>, _ disclaim: Int32) -> Int32

let disclaimedFlag = "DESK_REMINDERS_DISCLAIMED"

func refuse(_ sentence: String, _ code: Int32 = 2) -> Never {
  FileHandle.standardError.write("\(sentence)\n".data(using: .utf8)!)
  exit(code)
}

func relaunchDisclaimed() -> Never {
  var attrs: posix_spawnattr_t?
  posix_spawnattr_init(&attrs)
  _ = responsibility_spawnattrs_setdisclaim(&attrs, 1)
  let path = Bundle.main.executablePath ?? CommandLine.arguments[0]
  let argv: [UnsafeMutablePointer<CChar>?] = CommandLine.arguments.map { strdup($0) } + [nil]
  var env = ProcessInfo.processInfo.environment
  env[disclaimedFlag] = "1"
  let envp: [UnsafeMutablePointer<CChar>?] = env.map { strdup("\($0.key)=\($0.value)") } + [nil]
  var pid: pid_t = 0
  let rc = posix_spawn(&pid, path, nil, &attrs, argv, envp)
  if rc != 0 { refuse("desk-reminders-mac could not relaunch itself (\(rc)).", 1) }
  var status: Int32 = 0
  while waitpid(pid, &status, 0) == -1 && errno == EINTR {}
  let signal = status & 0x7f
  if signal != 0 { refuse("desk-reminders-mac was killed by signal \(signal).", 128 + signal) }
  exit((status >> 8) & 0xff)
}

if ProcessInfo.processInfo.environment[disclaimedFlag] == nil { relaunchDisclaimed() }

let checkAccess = Array(CommandLine.arguments.dropFirst()) == ["--check-access"]
var listName: String?
var args = CommandLine.arguments.dropFirst().makeIterator()
while !checkAccess, let arg = args.next() {
  switch arg {
  case "--list":
    guard let name = args.next(), !name.trimmingCharacters(in: .whitespaces).isEmpty else { refuse("--list needs the name of a Reminders list.") }
    listName = name
  default:
    refuse("desk-reminders-mac does not know the argument \(arg).")
  }
}

struct ReminderRequest {
  let text: String
  let due: Date
  let requestId: String
}

func requestMarker(_ id: String) -> String { "desk:request \(id)" }

func parseDueTime(_ text: String) -> Date? {
  let iso = ISO8601DateFormatter()
  for options: ISO8601DateFormatter.Options in [[.withInternetDateTime, .withFractionalSeconds], [.withInternetDateTime]] {
    iso.formatOptions = options
    if let d = iso.date(from: text) { return d }
  }
  let local = DateFormatter()
  local.locale = Locale(identifier: "en_US_POSIX")
  local.timeZone = TimeZone.current
  local.isLenient = false
  for format in ["yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd'T'HH:mm"] {
    local.dateFormat = format
    if let d = local.date(from: text) { return d }
  }
  return nil
}

func readReminderRequest() -> ReminderRequest {
  let data = FileHandle.standardInput.readDataToEndOfFile()
  guard let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { refuse("The request is not valid JSON.") }
  guard body["kind"] as? String == "reminder" else { refuse("This writer handles reminder requests, not \(body["kind"].map { "\($0)" } ?? "none").") }
  guard let f = body["fields"] as? [String: Any] else { refuse("The request has no fields.") }
  guard let requestId = body["requestId"] as? String,
        requestId.range(of: "^[A-Za-z0-9_-]{8,64}$", options: .regularExpression) != nil
  else { refuse("The request has no valid request id, so a retry could add the reminder twice.") }
  func text(_ name: String) -> String? {
    guard let v = f[name] else { return nil }
    guard let s = v as? String else { refuse("The \(name) must be text.") }
    let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
    return t.isEmpty ? nil : t
  }
  guard let title = text("text") else { refuse("The reminder text is missing.") }
  guard let dueText = text("due") else { refuse("The due time is missing.") }
  guard let due = parseDueTime(dueText) else { refuse("The due time is not an ISO 8601 date and time.") }
  return ReminderRequest(text: title, due: due, requestId: requestId)
}

let store = EKEventStore()
func hasFullAccess() -> Bool {
  switch EKEventStore.authorizationStatus(for: .reminder) {
  case .fullAccess: return true
  case .notDetermined:
    let done = DispatchSemaphore(value: 0)
    var granted = false
    store.requestFullAccessToReminders { ok, _ in
      granted = ok
      done.signal()
    }
    done.wait()
    return granted
  default: return false
  }
}
func requireFullAccess() {
  guard hasFullAccess() else { refuse("desk-reminders-mac has no full access to Reminders; allow it in System Settings > Privacy & Security > Reminders.", 3) }
}

if checkAccess {
  requireFullAccess()
  exit(0)
}

let request = readReminderRequest()
requireFullAccess()

let target: EKCalendar
if let name = listName {
  let writable = store.calendars(for: .reminder).filter(\.allowsContentModifications)
  guard let match = writable.first(where: { $0.title == name }) else {
    refuse("There is no Reminders list named \(name) that takes new reminders; these do: \(writable.map(\.title).sorted().joined(separator: ", ")).", 4)
  }
  target = match
} else {
  guard let fallback = store.defaultCalendarForNewReminders() else { refuse("There is no default Reminders list.", 4) }
  target = fallback
}

let when = DateFormatter()
when.locale = Locale(identifier: "en_GB")
when.timeZone = TimeZone.current
when.dateFormat = "EEE d MMM 'at' HH:mm"
let shortTitle = request.text.count > 120 ? String(request.text.prefix(119)) + "…" : request.text

func succeed(_ id: String, _ message: String) -> Never {
  let out = try! JSONSerialization.data(withJSONObject: ["id": id, "message": message], options: [])
  FileHandle.standardOutput.write(out)
  FileHandle.standardOutput.write("\n".data(using: .utf8)!)
  exit(0)
}

let marker = requestMarker(request.requestId)
func carriesMarker(_ r: EKReminder) -> Bool {
  let lines = (r.notes ?? "").components(separatedBy: .newlines).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
  return lines.last == marker
}

func fetch(_ predicate: NSPredicate) -> [EKReminder] {
  let fetched = DispatchSemaphore(value: 0)
  var found: [EKReminder] = []
  store.fetchReminders(matching: predicate) { reminders in
    found = reminders ?? []
    fetched.signal()
  }
  fetched.wait()
  return found
}

let recentlyCompleted = Date().addingTimeInterval(-7 * 86_400)
let existing = fetch(store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: [target]))
  + fetch(store.predicateForCompletedReminders(withCompletionDateStarting: recentlyCompleted, ending: nil, calendars: [target]))
if let earlier = existing.first(where: carriesMarker) {
  succeed(earlier.calendarItemIdentifier, "\"\(shortTitle)\" is already in \(target.title); nothing new was added.")
}

let reminder = EKReminder(eventStore: store)
reminder.calendar = target
reminder.title = request.text
reminder.notes = marker
var components = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: request.due)
components.calendar = Calendar.current
components.timeZone = TimeZone.current
reminder.dueDateComponents = components
reminder.addAlarm(EKAlarm(absoluteDate: request.due))
do {
  try store.save(reminder, commit: true)
} catch {
  refuse("Reminders could not save the reminder: \(error.localizedDescription)", 5)
}
succeed(reminder.calendarItemIdentifier, "Added \"\(shortTitle)\" to \(target.title) for \(when.string(from: request.due)).")
