import EventKit
import Foundation

@_silgen_name("responsibility_spawnattrs_setdisclaim")
func responsibility_spawnattrs_setdisclaim(_ attrs: UnsafeMutablePointer<posix_spawnattr_t?>, _ disclaim: Int32) -> Int32

func fail(_ text: String, code: Int32 = 2) -> Never {
  FileHandle.standardError.write(Data((text + "\n").utf8))
  exit(code)
}

func printJSON(_ value: Any) {
  do {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
  } catch {
    fail("The availability reader could not encode its result.", code: 1)
  }
}

func relaunch() -> Never {
  var attributes: posix_spawnattr_t?
  posix_spawnattr_init(&attributes)
  defer { posix_spawnattr_destroy(&attributes) }
  guard responsibility_spawnattrs_setdisclaim(&attributes, 1) == 0 else { fail("The availability reader could not establish its process identity.", code: 1) }
  let arguments: [UnsafeMutablePointer<CChar>?] = CommandLine.arguments.map { strdup($0) } + [nil]
  var environment = ProcessInfo.processInfo.environment
  environment["DESK_AVAILABILITY_DISCLAIMED"] = "1"
  let variables: [UnsafeMutablePointer<CChar>?] = environment.map { strdup("\($0.key)=\($0.value)") } + [nil]
  var pid: pid_t = 0
  let executable = Bundle.main.executablePath ?? CommandLine.arguments[0]
  guard posix_spawn(&pid, executable, nil, &attributes, arguments, variables) == 0 else { fail("The availability reader could not relaunch.", code: 1) }
  var status: Int32 = 0
  while waitpid(pid, &status, 0) == -1 && errno == EINTR {}
  let signal = status & 0x7f
  exit(signal == 0 ? (status >> 8) & 0xff : 128 + signal)
}

if ProcessInfo.processInfo.environment["DESK_AVAILABILITY_DISCLAIMED"] == nil { relaunch() }

var days = 5
var included = Set<String>()
var excluded = Set<String>()
var statusOnly = false
var requestAccess = false
var arguments = CommandLine.arguments.dropFirst().makeIterator()
while let argument = arguments.next() {
  switch argument {
  case "--days":
    guard let text = arguments.next(), let value = Int(text), (1...60).contains(value) else { fail("--days must be a whole number from 1 to 60.") }
    days = value
  case "--include":
    guard let name = arguments.next(), !name.isEmpty else { fail("--include needs a calendar name.") }
    included.insert(name)
  case "--exclude":
    guard let name = arguments.next(), !name.isEmpty else { fail("--exclude needs a calendar name.") }
    excluded.insert(name)
  case "--status": statusOnly = true
  case "--request-access": requestAccess = true
  default: fail("Unknown availability-reader argument: \(argument)")
  }
}
if statusOnly && requestAccess { fail("Use --status or --request-access, not both.") }

if statusOnly {
  let status = EKEventStore.authorizationStatus(for: .event)
  printJSON(["reader": "desk-calendar-availability-v1", "authorizationStatus": status.rawValue, "fullAccess": status == .fullAccess, "requestedAccess": false])
  exit(0)
}

let store = EKEventStore()
if requestAccess {
  let finished = DispatchSemaphore(value: 0)
  var granted = false
  store.requestFullAccessToEvents { allowed, _ in
    granted = allowed
    finished.signal()
  }
  guard finished.wait(timeout: .now() + 120) == .success else { fail("Calendar access confirmation timed out.", code: 3) }
  printJSON(["reader": "desk-calendar-availability-v1", "fullAccess": granted, "requestedAccess": true])
  exit(granted ? 0 : 3)
}

guard EKEventStore.authorizationStatus(for: .event) == .fullAccess else {
  fail("Calendar access is not granted to this separate reader. Request access only after approval.", code: 3)
}

let allCalendars = store.calendars(for: .event)
let known = Set(allCalendars.map(\.title))
guard included.subtracting(known).isEmpty && excluded.subtracting(known).isEmpty else { fail("A selected calendar name is not available.", code: 4) }
let calendars = allCalendars.filter { (included.isEmpty || included.contains($0.title)) && !excluded.contains($0.title) }
let start = Calendar.current.startOfDay(for: Date())
guard let end = Calendar.current.date(byAdding: .day, value: days, to: start) else { fail("The calendar query window is invalid.") }
let formatter = ISO8601DateFormatter()
formatter.formatOptions = [.withInternetDateTime]

func availability(_ event: EKEvent) -> [String: String] {
  let status: String
  let raw: String
  switch event.availability {
  case .free: status = "free"; raw = "free"
  case .busy: status = "busy"; raw = "busy"
  case .unavailable: status = "busy"; raw = "unavailable"
  case .tentative: status = "unknown"; raw = "tentative"
  case .notSupported: status = "unknown"; raw = "notSupported"
  @unknown default: status = "unknown"; raw = "unrecognized"
  }
  return ["status": status, "provenance": "EventKit.EKEvent.availability.\(raw)"]
}

let predicate = store.predicateForEvents(withStart: start, end: end, calendars: calendars)
let found = calendars.isEmpty ? [] : store.events(matching: predicate)
var complete = true
var events: [[String: Any]] = []
var seen = Set<String>()
for event in found {
  if event.status == .canceled { continue }
  guard let eventStart = event.startDate, let eventEnd = event.endDate, eventEnd > eventStart else {
    complete = false
    continue
  }
  let calendarId = event.calendar.calendarIdentifier
  let id = "\(calendarId)|\(event.calendarItemIdentifier)|\(formatter.string(from: eventStart))"
  if seen.contains(id) { continue }
  seen.insert(id)
  var value: [String: Any] = [
    "id": id,
    "start": formatter.string(from: eventStart),
    "end": formatter.string(from: eventEnd),
    "allDay": event.isAllDay,
    "title": event.title ?? "(no title)",
    "calendar": event.calendar.title,
    "calendarId": calendarId,
    "availability": availability(event),
  ]
  if let location = event.location, !location.isEmpty { value["location"] = location }
  if let url = event.url, ["http", "https"].contains(url.scheme?.lowercased() ?? "") { value["url"] = url.absoluteString }
  events.append(value)
}
events.sort { ($0["start"] as? String ?? "") < ($1["start"] as? String ?? "") }
printJSON([
  "capabilities": ["calendar"],
  "events": events,
  "calendarCoverage": [
    "from": formatter.string(from: start),
    "to": formatter.string(from: end),
    "calendars": calendars.map { ["id": $0.calendarIdentifier, "name": $0.title] },
    "status": complete ? "complete" : "partial",
    "provenance": "EventKit.events(matching:predicateForEvents)",
  ],
])
