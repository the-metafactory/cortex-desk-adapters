# cortex-desk-adapters

Source adapters for the [Cortex](https://github.com/the-metafactory/cortex) Desk, Mission Control's landing page. Each adapter is a command that prints one JSON object; Cortex runs it from the stack config and shows what it prints.

The Desk also runs commands to create things the person confirms in its command bar; see [Writers](#writers).

For examples that work without the personal toolkit, see [Portable Desk adapters](EXAMPLES.md): an ICS calendar reader, an IMAP mail reader, and an ntfy transport. A bundled calendar and mail file let you try the Desk without accounts.

| Command | Reads | Prints |
|---|---|---|
| `desk-calendar --exchange` | an Exchange calendar through the `ical` CLI | `events` |
| `desk-calendar --mac [--exclude <calendar>]` | macOS Calendar through the `ical` CLI (legacy: returns nothing under a daemon) | `events` |
| `dist/desk-calendar-mac [--exclude <calendar>] [--include <calendar>] [--days 5]` | macOS Calendar through EventKit (a compiled Swift binary) | `events` |
| `desk-mail --account <name>` | an IMAP mailbox through the `email` CLI | `items` (mail) |

Both wrap CLIs from a personal toolkit. They are examples of the contract as much as tools: copy one and point it at your own calendar or mail tool.

## The contract

A source prints `{ "events"?: [...], "items"?: [...] }` on stdout and exits 0. The types are in [`src/contract.ts`](src/contract.ts).

- An **event** has an `id`, an ISO 8601 `start`, a `title`, and optionally `end`, `allDay`, `location`, `online` and `url`.
- A **mail item** has `kind: "mail"`, the Message-ID as `id`, `from`, `subject`, `receivedAt`, `unread`, and optionally `firstParagraph`, `url`, `account`, `headers` and `links`.
- `headers` (`DeskMailHeaders`) holds what later Desk steps read from the message headers: `listId`, `listUnsubscribe`, `listUnsubscribePost`, `authResults` (`{ spf?, dkim?, dmarc?, dkimDomains?, spfDomain? }`, the verdicts of the topmost Authentication-Results header, the signing domains of its passing DKIM signatures, and the domain SPF checked, from smtp.mailfrom), `replyTo` and `inReplyTo`. Every field is optional. Cortex treats the values as untrusted data and drops a malformed field without dropping the mail.
- `links` (`DeskMailLink[]`, at most 20) are the links of the HTML body whose whole visible text names a host, as `{ text, href }`, for the Desk's phishing check.
- Links must be `http:`, `https:` or `message:` (Apple Mail). Cortex drops entries that do not match and reports how many it dropped.

Time first uses the additive [calendar availability source contract](docs/calendar-availability.md). Legacy event output remains valid for display and stays explicitly unqualified for free-gap recommendations.

`desk-mail` reads message bodies without marking them read, and only for the newest unread messages (`--bodies`, default 15). It reads the headers of every listed message over IMAP with `BODY.PEEK`, using the `email` CLI's account config; when that fails it lists the mail without `headers` and writes one line to stderr. `desk-imap` reads the same headers in its own fetch. The verdicts come from the topmost Authentication-Results header, ignoring comments such as an ARC chain's. A sender can forge that header when the receiving server adds none, so pass `--authserv <id>` (repeatable) to either command to read only headers whose authserv-id, the first word of the header, is one your own mail server writes; with `--authserv` set and no match, `authResults` is left out. For the same unread messages it reads, `desk-mail` also reads the HTML body over IMAP (read-only, at most 256 KiB) for `links`; when that fails the mail is listed without them.

## macOS calendars under a daemon

Use `desk-calendar-mac` for macOS calendars. `desk-calendar --mac` is kept only for running by hand from a terminal that already has calendar access; it will not get the per-day splitting or new flags.

macOS grants calendar access per program. A Cortex daemon started by launchd has no grant, so `desk-calendar --mac` (which goes through icalBuddy) returns an empty calendar there. `desk-calendar-mac` reads EventKit itself and re-launches itself as its own responsible process, so the grant belongs to it whoever starts it.

```sh
./mac/build.sh                 # needs the Xcode command line tools; ./mac/build.sh <dir> builds elsewhere
./dist/desk-calendar-mac --days 1   # first run: macOS asks for calendar access; allow it
```

A rebuild changes the binary's signature, so macOS asks again. Without access it exits 3 with a message, and the Desk shows the source as failing. Multi-day all-day events come as one entry per day.

## Use it in Cortex

Install with `bun install`, then list the commands under `mc.desk.sources` in the stack config:

```yaml
mc:
  desk:
    sources:
      - id: work-calendar
        command: [/path/to/cortex-desk-adapters/bin/desk-calendar.ts, --exchange]
        area: work
      - id: work-mail
        command: [/path/to/cortex-desk-adapters/bin/desk-mail.ts, --account, work]
        area: work
        everySeconds: 300
        timeoutSeconds: 60
```

Cortex runs each command without a shell, at most once per `everySeconds` (default 300), and kills it after `timeoutSeconds` (default 30).

## Writers

The Desk's command bar turns typed text into a proposal card. When the person confirms it, Cortex runs the **writer** configured for that kind, and an optional **parser** reads the text first. Both are commands, like sources. The types are in [`src/contract.ts`](src/contract.ts).

| Command | Kind | Creates |
|---|---|---|
| `dist/desk-calendar-mac --create [--calendar <name>]` | `calendar` | an event in macOS Calendar, through EventKit |
| `dist/desk-reminders-mac [--list <name>]` | `reminder` | a reminder with an alarm in Apple Reminders, through EventKit |
| `desk-task [--map <ref>]... [--autonomy approve] [--kind research] [--soma soma]` | `task` | a node on a work-graph map, through `soma graph add` |
| `desk-goal [--soma soma]` | `goal` | a draft Soma goal, through `soma goal add` |
| `desk-note-tana [--target <nodeId>]` | `note` | a plain node in Tana, through the Tana Input API |
| `desk-parse [--model haiku] [--claude claude]` | (parser) | nothing; prints a proposal |

### The writer contract

Cortex runs the writer without a shell, writes one JSON object to its stdin, closes stdin and waits up to 30 s.

- Input: `{ "kind": "calendar" | "task" | "goal" | "note" | "reminder", "fields": { ... }, "requestId": "<8–64 of [A-Za-z0-9_-]>" }` (`DeskWriteInput`; `DeskWriteRequest` is the same without the id). The request id is the same for every retry of one confirmed card, so a writer uses it to add nothing on a retry whose first try already wrote. A malformed request id is refused.
  - `calendar`: `title`, ISO 8601 `start`, and optionally `end`, `allDay`, `location`, `notes`.
  - `task`: `title`, `map` (a work-graph root ref such as `the-metafactory/cortex#2770`) and optionally `details`.
  - `goal`: `wording`.
  - `note`: `text`.
  - `reminder`: `text` and ISO 8601 `due`.
- Success: exit 0 and print one object `{ "id": string, "url"?: string, "message"?: string }`. The `message` is one plain sentence for the person; a `url` must be `http:` or `https:`.
- Refusal or failure: exit non-zero. The last line of stderr is shown to the person, so it is one plain sentence.

A writer refuses a request of a kind it does not handle, or whose fields fail its checks, and then creates nothing.

Notes and reminders need no writer: without one, Cortex keeps them on the Desk (Keep in mind, and the timeline for a reminder). With `writers.note` or `writers.reminder` set, Cortex sends them to that command and keeps nothing itself, so the Desk neither shows nor pushes them; the person's own tool does.

### The parser contract

Cortex may run a parser before it builds the card. Its stdin gets `{ "text", "now" (ISO 8601), "timeZone" (IANA), "kinds", "maps": [{ "ref", "label" }] }`; `kinds` is a subset of `reminder`, `note`, `task`, `goal` and `calendar`. It prints one object: `{ "kind", "fields" }` with the fields above, or `{ "kind": "none", "reason" }`. Cortex validates the answer and falls back to its own rules parser on any failure, so a parser may fail loudly.

### Read-only Balance parent proposals

The same configured `desk-parse` accepts a separate versioned operation:

```json
{"operation":"balance-parent","version":1,"revision":7,"source":{"key":"reminder:1","fingerprint":"<64 lowercase hexadecimal characters>","text":"Review the launch"},"parents":[{"id":"area:work","area":"work","path":"Work"}],"routing":{"permitted":["pi"]}}
```

It returns `{ "kind": "balance-parent", "parent": "area:work", "reason": "This area owns the review.", "routing": { ... } }`. `parent: null` explicitly selects Inbox when no offered parent fits. The reason is one line of at most 200 characters. Parent IDs must come from this request's catalogue. Source text and labels are data and cannot grant instructions or authority.

With `--routing-config`, both operations use the same permitted-provider intersection, Ranger selection, capability checks, deadline, and tools-disabled execution. Failure retains the existing `{ "kind": "none", "reason", "routing": { "kind": "unavailable", ... } }` envelope. Cortex checks the routing evidence, current source fingerprint, revision, and parent again before the person confirms filing. A proposal never invokes a writer. `balance-parent` is not a writer kind.

Deploy this adapter update before the corresponding Cortex Catch-up update. Existing creation requests and writer contracts are unchanged. An older or custom parser that does not support this operation produces a visible Inbox fallback in Cortex. The configured parser is a command path, so update that checkout to the reviewed adapter release or merge revision; no dependency pin in Cortex changes. This repository currently has no CI, so its PR records `bun test` and `bunx tsc --noEmit`. Updating TypeScript files does not require rebuilding either signed macOS binary.

### The commands

- **`desk-calendar-mac --create`** reads the request after its relaunch, so a refused request never touches the calendar. It refuses a request without a request id. It saves to the default calendar for new events, or to `--calendar <name>` (an unknown or read-only calendar is refused), with span `.thisEvent`, and puts `desk:request <requestId>` as the last line of the event's notes. Before saving, it looks in the target calendar from the day before the start to a day after the end for an event whose notes hold that line; if it finds one, it saves nothing and reports that event as already there. The `id` is the event's `eventIdentifier`. An event without `end` lasts an hour; an all-day event without `end` lasts one day. It uses the same calendar grant as reading (full access).
- **`desk-reminders-mac`** is a separate binary with its own signature, so its Reminders grant and the calendar grant of `desk-calendar-mac` never disturb each other. Build it with `./mac/build-reminders.sh`, which builds nothing else. Like `desk-calendar-mac`, it re-launches itself with responsibility disclaimed and reads the request only after that, and it checks the whole request before any Reminders access. It refuses a request without a request id, without `text`, or whose `due` is not an ISO 8601 date and time. It saves to the default Reminders list, or to `--list <name>` (an unknown or read-only list is refused with exit 4). The reminder gets the text as its title, a due date, an alarm at the due time, and `desk:request <requestId>` as the last line of its notes. Before saving, it looks through the target list (open reminders, and those completed in the last seven days) for a reminder whose notes end with that line; if it finds one, it saves nothing and reports that reminder as already there. The `id` is the reminder's `calendarItemIdentifier`. Without full Reminders access it exits 3. The first run asks for access, so run it once by hand and allow it before Cortex uses it:

  ```sh
  ./mac/build-reminders.sh
  echo '{"kind":"reminder","fields":{"text":"Try the Desk reminder writer","due":"2026-11-02T09:00:00+01:00"},"requestId":"desk-setup-0001"}' | ./dist/desk-reminders-mac
  ```
- **`desk-task`** files the task under its map with `--label desk:principal-intake` and `--once "<!-- desk:request <requestId> -->"`, so a retry of one card finds the node it already filed instead of filing a second (it refuses a request without a request id). It uses a checkpoint `desk-<kebab title>` of at most 48 characters, and a body holding the details (or the title) under `## Question` plus a line saying it came from the Desk. With one or more `--map`, any other map is refused. An `owner/name#N` map is filed on github.com with an explicit `--repo`, so it does not depend on the directory Cortex runs the writer from; a qualified ref (`github:host/owner/name#N`) is passed as it is. The `id` is `owner/name#N` and the `url` the issue.
- **`desk-goal`** first runs `soma goal list --wording`; if an open goal (draft, active or paused) already has exactly this wording (trimmed), it prints that goal's id and adds nothing; a dropped or achieved goal does not count. Otherwise it runs `soma goal add --wording <wording>` and prints the new goal's id (`G<n>`). The wording is the dedupe key, because `soma goal add` takes none, so the request id is accepted but not required. The goal starts as a draft; activate it with `soma goal activate`.
- **`desk-note-tana`** posts the note text as one plain node (no supertag, no fields) to Tana's Input API, under `--target <nodeId>` or, by default, the Inbox. It reads the API token from `TANA_API_TOKEN`, or else from the `apiToken` in [supertag](https://github.com/jcfischer/supertag-cli)'s config (`$XDG_CONFIG_HOME/supertag/config.json`, which `supertag config --token` writes); it never takes the token in argv. `TANA_API_ENDPOINT` or the config's `apiEndpoint` override the endpoint. The Input API cannot search, so the writer keeps a ledger of request ids at `$XDG_STATE_HOME/cortex-desk-adapters/tana-notes.json` (default `~/.local/state/...`), written only after Tana answers success; a retry within 30 days whose request id is in the ledger adds nothing and reports the node it already made. It refuses a request without a request id or without `text`, and a text over 1000 characters; line breaks become spaces. Without a token, on an HTTP error or a refused payload it exits 1 with one sentence and records nothing; after a 5xx answer or no answer it says the note may have been created. The `id` is the Tana node id and the `url` opens it in Tana.
- **`desk-parse`** reads the text against `now` and `timeZone`, choosing a map only from `maps`. Without routing configuration it retains the Claude parser command. With `--routing-config`, it uses Ranger selection and the tools-disabled provider adapters described in [Parser routing](docs/parser-routing.md).

Configure them under `mc.desk.ask`:

```yaml
mc:
  desk:
    ask:
      parser: [/path/to/cortex-desk-adapters/bin/desk-parse.ts]
      writers:
        calendar: [/path/to/cortex-desk-adapters/dist/desk-calendar-mac, --create]
        task: [/path/to/cortex-desk-adapters/bin/desk-task.ts, --map, the-metafactory/cortex#2770]
        goal: [/path/to/cortex-desk-adapters/bin/desk-goal.ts]
        note: [/path/to/cortex-desk-adapters/bin/desk-note-tana.ts]
        reminder: [/path/to/cortex-desk-adapters/dist/desk-reminders-mac]
      taskMaps:
        - { ref: the-metafactory/cortex#2770, label: Desk }
```

## Mail actions

A mail item on the Desk offers Archive, Spam and Delete. All three are one move with a target, and none of them ever deletes or expunges a message: Archive moves it to the account's archive folder, Spam to its junk folder, Delete to its trash folder. Every move can be undone from the Desk.

Cortex runs the command set as `mc.desk.mail.actions.move`, without a shell, and writes one JSON object to its stdin (types in [`src/contract.ts`](src/contract.ts)):

- `{ "action": "move", "account", "messageId", "target": "archive" | "junk" | "trash" }` (`DeskMailMoveRequest`) moves the one INBOX message with that Message-ID to the account's folder for the target.
- `{ "action": "restore", "account", "messageId", "from": "archive" | "junk" | "trash" }` (`DeskMailRestoreRequest`) is Undo: it moves the one message with that Message-ID from the target's folder back to INBOX.

- `{ "action": "locate", "account", "messageId" }` (`DeskMailLocateRequest`) moves nothing. Cortex sends it for a listed unread mail that left INBOX or was read without a Desk action, to log where the person put it in their mail client. The command prints a `DeskMailLocateResult`, `{ "id", "place", "folder"?, "unread"?, "message" }`: `place` is `inbox`, `archive`, `junk`, `trash`, or `gone` when the message is in none of those folders. It never guesses another folder.

`account` is the account the mail source put on the item, `messageId` the item's id without angle brackets. For move and restore, exit 0 means the message moved; the command then prints a `DeskMailMoveResult`, `{ "id", "folder", "message" }`, whose `message` is the receipt the Desk shows and names the folder ("Moved to Archiv."). On any other exit the last line of stderr is shown to the person and the mail stays on the Desk.

`desk-mail-move [--mailbox INBOX]` is that command for the `email` CLI's accounts. It reads the account's IMAP settings from `~/.config/email/config.json` (a password as `keychain:<service>`, `env:<VAR>` or plain text, as the `email` CLI reads it), and resolves each target per account from the server's folder list: the folder with the special-use flag (`\Archive`, `\Junk`, `\Trash`) first, else one with a usual name (Archive, Archives; Junk, Junk E-Mail, Junk Email, Spam; Trash, Deleted Items, Deleted Messages). It finds the message by an IMAP header search, keeps only messages whose Message-ID is exactly the one asked for, and moves that one message with IMAP MOVE. It refuses, and moves nothing:

- when the account has no folder for the target ("The work account has no Archive mailbox, so nothing was moved."). It never falls back to another folder;
- when the server lacks the MOVE extension, because the fallback (copy, flag deleted, expunge) could purge other messages;
- when the Message-ID matches no message in the source folder ("The message is no longer in the work INBOX."), or more than one.

An account without `tls: true` must offer STARTTLS.

```yaml
mc:
  desk:
    mail:
      actions:
        move: [/path/to/cortex-desk-adapters/bin/desk-mail-move.ts]
        draft: [/path/to/cortex-desk-adapters/bin/desk-mail-draft.ts, --email, /path/to/email]
        timeoutSeconds: 30
```

### The legacy trash command

Before the move contract, Delete ran `mc.desk.mail.actions.trash` with `{ "action": "trash", "account", "messageId" }` (`DeskMailActionRequest`). A stack without a `move` command still works that way: it offers Delete only, without Undo. `desk-mail-trash [--mailbox INBOX]` reads only that request and moves the message to the trash folder exactly as `desk-mail-move` does for `"target": "trash"`. `desk-mail-move` also accepts the legacy request, so a stack can point both keys at it while it moves over.

### Reply drafts

With `mc.desk.mail.actions.draft` set, a mail item offers "Draft a reply" (as its first action when the classifier suggests a reply). The person writes the reply in the Desk's detail panel and confirms; Cortex runs the command without a shell and writes `{ "action": "draft", "account", "messageId", "to", "subject", "body" }` to its stdin (`DeskMailDraftRequest`). `to` is the original sender, `subject` the original subject with `Re: `. Exit 0 means the draft is saved; otherwise the last line of stderr is shown and the mail stays on the Desk. A draft command never sends mail.

`desk-mail-draft [--email /path/to/email]` is that command for the `email` CLI: it runs `email draft create` with the account, recipient, subject and `In-Reply-To`, as plain text, with the reply on stdin. The `email` CLI appends the message to the account's Drafts mailbox over IMAP. It refuses a recipient that is not one plain address, a subject with a line break, and an empty reply.

### Reporting phishing

With `mc.desk.mail.report` set, a mail the Desk flags as suspicious offers "Report". Cortex runs `mc.desk.mail.report.command` without a shell and writes `{ "action": "report", "account", "messageId", "to" }` (`DeskMailReportRequest`) to its stdin, with `to` from `mc.desk.mail.report.to`. Without the block, Report is hidden; Spam works either way.

`desk-mail-report [--mailbox INBOX]` is that command for the `email` CLI's accounts. It reads the original from INBOX, else from the Junk folder, read-only, and appends a draft to the account's Drafts mailbox (special-use `\Drafts`, else a usual name): to `to`, subject `Phishing report: <original subject>`, a short text part, and the original unchanged as a `message/rfc822` attachment. The person sends the draft from their mail client; the command only saves it, and never moves or deletes mail. It refuses a request without `to`, a Message-ID that matches more than one message, and a message over 25 MB.

```yaml
mc:
  desk:
    mail:
      report:
        command: [/path/to/cortex-desk-adapters/bin/desk-mail-report.ts]
        to: reports@example.org
```

### DMARC reports

DMARC aggregate reports (RFC 7489) can become one weekly line on the Desk instead of mail. A mail rule with the action "Keep for the digest" holds the report mails; Cortex then runs the command set as `mc.desk.mail.dmarc.command` once for each held mail whose subject starts with `Report Domain:`, without a shell, and writes `{ "action": "dmarc", "account", "messageId" }` (`DeskDmarcRequest`) to its stdin.

On success the command exits 0 and prints a `DeskDmarcReport`: `{ "id", "org", "reportId", "begin", "end", "policyDomain", "domains": [...], "message" }`. Each entry of `domains` is one header-from domain with `messages`, `spf` and `dkim` (`{ pass, fail }`, the verdicts DMARC evaluated), `dmarcFail` (both failed), `disposition` (`{ none, quarantine, reject }`) and at most five `failing` sources (`{ ip, count, spfFail, dkimFail, dmarcFail }`), most failing first. A report the command will not read exits 3 with one sentence on stderr; Cortex records the reason and does not ask again. Any other exit is a failure Cortex retries on a later pass.

`desk-mail-dmarc [--mailbox INBOX]` is that command for the `email` CLI's accounts. It opens the mailbox read-only and fetches parts with `BODY.PEEK`, so the mail stays unread. It reads the one attachment that is zip, gzip or XML and refuses (exit 3), reading nothing further:

- a Message-ID that matches more than one INBOX message, a mail with no such attachment, or one with more than one;
- an attachment over 1 MiB, or one that unpacks to more than 8 MiB (a zip bomb stops at the cap), a zip with more than one file, an encrypted zip, or a zip whose file is not the size it declares;
- XML with a DOCTYPE or entity declaration, XML that is not well-formed, a root other than `<feedback>`, a record without a count, or more than 20,000 records.

Nothing in the report is executed or rendered: the command reads elements and text only.

```yaml
mc:
  desk:
    mail:
      dmarc:
        command: [/path/to/cortex-desk-adapters/bin/desk-mail-dmarc.ts]
        domains: [example.org]
        failOn: dmarc
        after: archive
```

`domains` are the domains you own (subdomains count); reports about other domains are counted but never raise a card. `failOn: dmarc` (the default) raises a failure card when mail as your domain failed both SPF and DKIM, so failed DMARC; `spf-or-dkim` raises one when either failed, which also flags forwarded mail that DMARC passed. After reading, Cortex moves the report through the move contract to Archive, or to Trash with `after: trash`.

## Mail classifier

Cortex can sort unread mail with a command set as `mc.desk.mail.classifier.command`. It runs the command without a shell once per unclassified unread mail, writes one JSON object to its stdin and kills it after `timeoutSeconds`:

`{ "mail": { "id", "from": { "name"?, "address" }, "subject", "firstParagraph", "receivedAt", "account"? }, "meetings": [{ "key", "title", "start" }], "vips": [...], "unimportant": [...], "corrections": [{ "kind", "source", "mode", "label" }] }`

The command prints one answer: `{ "category": "action" | "reply" | "meeting" | "fyi" | "bulk", "commitment"?: "request" | "invitation" | "none" | "unknown", "meetingKey"?, "reason", "summary"?, "suggestedAction"?, "evidence"? }`. `commitment` is independent of ranking: a request asks the person to take on a new task or responsibility; an invitation asks them to participate. An expected reply or an update to an existing meeting alone is not a new commitment. Missing or unknown commitment evidence does not show the Yes-filter. `meetingKey` must be one of the request's keys; `reason` is at most 200 characters, `summary` at most 600; `suggestedAction` is `reply`, `archive`, `link-meeting`, `task` or `none`; `evidence` holds at most 5 `{ "kind": "mail" | "event" | "note", "ref", "title" }`. Any other answer, or a non-zero exit, makes the Desk sort that mail by its own rules and try again later. A key configured as `apiKeyFile` or `apiKeyEnv` reaches the command as `DESK_CLASSIFIER_KEY` in its environment.

`desk-classify-mail` is that command. It hosts the Pulse flow [`flows/desk-mail-triage.yaml`](flows/desk-mail-triage.yaml) on one OpenAI-compatible model:

1. `A_DESK_TRIAGE_PREPARE` answers `bulk` for a sender on the unimportant list (unless also a VIP) without calling the model.
2. A `research:` step lets the model call `A_MAIL_SEARCH`, `A_MAIL_READ`, `A_CALENDAR_EVENTS` and `A_NOTES_SEARCH` (the read actions from pulse-actions) for up to 6 rounds within 60 s, with the corrections in the prompt as examples. Zero tool calls is fine for obvious mail.
3. `A_DESK_TRIAGE_CHECK` checks the answer against the rules above and fails on anything else, including unknown fields.

```sh
desk-classify-mail --flow <path>/flows/desk-mail-triage.yaml --base-url <url up to /v1> --model <name> \
  [--key-env DESK_CLASSIFIER_KEY] [--ca-file <pem>] [--actions-dir <dir>]... [--mail-accounts work,personal] [--state-dir <dir>]
```

- The key comes from the env var `--key-env` names, never from argv. `--ca-file` trusts a private CA for the gateway.
- The read actions are looked up in `--actions-dir`, by default `~/.config/metafactory/arc/actions`, where arc installs pulse-actions. Their backends and env vars (`PULSE_MAIL_CLI`, `PULSE_CALENDAR_CLI`, `PULSE_NOTES_CLI`, `PULSE_CALENDAR_SOURCES`) are documented there. Mail tools refuse every account until `PULSE_MAIL_ACCOUNTS` is set; `--mail-accounts` sets it.
- Research transcripts go to `<state-dir>/desk-classify-mail/transcripts` (0700; default state dir `$XDG_STATE_HOME/cortex-desk-adapters`, else `~/.local/state/cortex-desk-adapters`), never to stdout. On success, one stderr line reports the category, time, tool rounds and tool calls.
- An unreachable gateway, a research step that times out, or an invalid answer exits non-zero with one stderr line, within 65 s.

```yaml
mc:
  desk:
    mail:
      classifier:
        command: [/path/to/cortex-desk-adapters/bin/desk-classify-mail.ts, --flow, /path/to/cortex-desk-adapters/flows/desk-mail-triage.yaml,
                  --base-url, https://gateway.example/v1, --model, coder, --mail-accounts, work]
        apiKeyFile: ~/.config/gateway/key
        timeoutSeconds: 75
        maxPerPass: 10
```

## Develop

```sh
bun install
bun test
bunx tsc --noEmit
```
