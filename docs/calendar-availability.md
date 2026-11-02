# Calendar availability source contract

Time first accepts proven gaps only from readers that declare `capabilities: ["calendar"]` and a complete `calendarCoverage` window. Attention-only sources declare `["attention"]`. Legacy output remains supported for display, but does not establish free time.

`calendarCoverage` contains ISO timestamps `from` and `to`, `calendars: [{id, name}]`, `status: "complete" | "partial"`, and a nonempty `provenance`. The window is half-open. Every event identifies its calendar with `calendarId` and the matching display `calendar` name. Empty complete results still list the queried calendars. Each event's optional `availability` contains `status: "busy" | "free" | "unknown"` and `provenance`. Blocking events require their actual start and end.

Cortex accounts for every configured source and uses the configured refresh interval for freshness. Missing, stale, failed, partial, malformed, or undeclared calendar evidence cannot prove a free gap. Calendar visibility is stored by stable identity; old label preferences remain supported. Display kind, title, all-day status, and a guessed duration never establish availability.

## Reader mappings

- `desk-calendar --exchange --availability --ical /path/to/versioned-reader` calls the additive `exchange availability-raw --next N` command. The reader reuses the existing Exchange client and account. It preserves the exact UTC CalendarView bounds, stable folder identity, actual intervals, and `MoreAvailable`. Only explicit `false` establishes completion. EWS `Free` maps to free; `Busy` and `OOF` map to busy. Tentative, NoData, WorkingElsewhere, absent properties, and unsupported values remain unknown. Failed property loads make coverage partial.
- `desk-ics` maps explicit RFC 5545 `TRANSPARENT` to free and `OPAQUE` to busy. Absent transparency remains unknown under the Desk's conservative contract. Tentative events remain unknown. Unsupported recurrence or availability-bearing components, including VFREEBUSY and VAVAILABILITY, make coverage partial.
- `desk-calendar-availability-v1` maps EventKit free, busy, and unavailable directly. Tentative and unsupported availability remain unknown. It reports real intervals and stable calendar identifiers. Its ordinary read and `--status` operations never request access.

The enum definitions are [Apple EKEventAvailability](https://developer.apple.com/documentation/eventkit/ekeventavailability) and [Microsoft LegacyFreeBusyStatus](https://learn.microsoft.com/en-us/exchange/client-developer/web-service-reference/legacyfreebusystatus). Unit cases qualify mappings; an installation also requires actual source readback and completion checks.

The raw Exchange report retains the provider folder display name. The Desk adapter deliberately keeps its existing `Exchange` display label so legacy visibility and colour preferences still apply. The stable provider folder ID identifies the calendar; the display label does not establish source authority. EventKit calendar names pass through directly, and stable IDs preserve settings across renames.

The raw Exchange reader uses the service's public `LoadPropertiesForItems` operation in batches of at most 50 appointments. This is a local request bound, not an asserted Exchange service limit or a scheduling policy. A failed batch, mismatched response count, failed item response, or unreadable required property makes the report partial. Missing all-day metadata is never represented as a timed event.

## Install and roll back the separate native reader

Build with `mac/build-availability.sh /path/to/new-output-directory`. The build refuses an existing `desk-calendar-availability-v1`. Record the source revision, output SHA256, and code signature before installation. The original `desk-calendar-mac` stays unchanged.

Calendar access belongs to the reviewed executable. Run `--status` first. A new grant requires explicit approval and the separate `--request-access` operation. Update the configured source command only after access and readback qualification. Rollback restores the exact previous source command; it does not rebuild or re-sign either reader.

The new reader has no create, update, or delete operation. The installed `ical` and existing derived `exchange availability` command are unchanged.
