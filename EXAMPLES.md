# Portable Desk adapters

These commands run on Bun without the personal `ical` or `email` CLIs. Install dependencies with `bun install`. The [Desk tutorial](https://github.com/the-metafactory/cortex/blob/main/docs/desk/getting-started.md) shows how to configure sources.

## Read an ICS calendar

```sh
bun bin/desk-ics.ts examples/calendar.ics --days 7
bun bin/desk-ics.ts https://calendar.example.org/calendar.ics --days 7
```

`desk-ics <file-or-https-url> [--days 7]` prints an `events` list for today and the following days. `--days` accepts 1–60. Floating times use the host's time zone. UTC times and IANA `TZID` values are supported. URL requests use HTTPS with a 20-second timeout. Redirects are refused.

The reader handles unfolded properties, escaped text, date-only events, `DTEND`, `EXDATE`, and daily or weekly recurrence with `INTERVAL`, `COUNT`, `UNTIL`, and plain weekday `BYDAY` values. Weeks start on Monday. It skips unsupported recurrence rules, explicit `WKST`, `RDATE`, and `DURATION` rather than guessing, and reports the skipped count on stderr. Recurrence scanning is bounded to 200 years from its starting point. Overrides with `RECURRENCE-ID` are ignored, so calendars using changed or cancelled individual occurrences need a fuller adapter. This example does not implement all of iCalendar. It sends the `mailto:` addresses of `ORGANIZER` and `ATTENDEE` as `organizer` and `attendees`, lowercase and without names, and leaves either out when the event has no such address.

The bundled calendar repeats "Plan the day" each day and "Team sync" on Monday, Wednesday, and Friday. No account or permission grant is needed. `examples/mail.json` is a static mail source for the same tutorial:

```yaml
mc:
  desk:
    sources:
      - id: calendar
        command: [/absolute/path/to/bun, /absolute/path/to/cortex-desk-adapters/bin/desk-ics.ts, /absolute/path/to/cortex-desk-adapters/examples/calendar.ics]
      - id: sample-mail
        command: [/bin/cat, /absolute/path/to/cortex-desk-adapters/examples/mail.json]
```

Commands run without a shell. Replace every path with an absolute path on the host.

## Read unread mail over IMAP

```sh
bun bin/desk-imap.ts --host imap.example.org --user sam@example.org --account personal
```

Set `DESK_IMAP_PASSWORD` in the adapter's environment before running the command. `--password-env <name>` selects another variable. Passwords never go in argv. A Cortex service needs the variable in its own environment.

`desk-imap` opens INBOX read-only and prints at most 30 unread messages, newest UID first. It fetches envelopes and the first body part (up to 16 KiB of plain text, or up to 256 KiB of HTML when the message has no plain-text part) without marking mail read (`BODY.PEEK`). An HTML-only message gets its `firstParagraph` from the HTML's visible text by the same rules as `desk-mail`: scripts, styles, the head, comments and hidden elements are dropped, and a first paragraph that only repeats the subject is skipped. Unread messages with an HTML body also carry `links` (at most 20, the same as `desk-mail`), and a `text/calendar` meeting request becomes the item's `invitation` unless a reply in a Sent folder answers it or the event is over. Older INBOX mail with an open invitation is added by the look-back, as `desk-mail` does it. Messages without a sender or Message-ID are omitted. A failed body, links or invitation read lists the mail without that field and writes one line to stderr.

The invitation needs the account's own addresses. With `--config` they come from the account's `from` address and its login names; with the flag route the `--user` login is used when it is an address.

| Flag | Default | Meaning |
|---|---|---|
| `--host` | required | IMAP host |
| `--user` | required | Login name |
| `--port` | `993` | Port, from 1 to 65535 |
| `--starttls` | off | Require STARTTLS instead of immediate TLS. Set `--port 143` when appropriate. |
| `--mailbox` | `INBOX` | Mailbox to read |
| `--account` | `mail` | Label carried on each item |
| `--limit` | `30` | Maximum messages, from 1 to 200 |
| `--password-env` | `DESK_IMAP_PASSWORD` | Password environment variable |
| `--invite-days` | `14` | Invitation look-back, from 1 to 60 days |
| `--invite-scan` | `200` | Newest messages scanned for invitations, from 1 to 1000 |
| `--invite-limit` | `10` | Older mails added for an open invitation, from 1 to 50 |
| `--config` | none | Mail config file; reads host, port, TLS, user and secret from the account named by `--account`. Use it instead of `--host` and `--user`; combining them exits 2. |

```sh
bun bin/desk-imap.ts --config /path/to/mail.json --account personal
```

With `--config`, no secret sits in an environment variable. An account the file does not hold, or a file that cannot be read, exits 1 and prints no JSON.

The account label identifies this source. It does not configure the personal `email` CLI or its trash and draft writers. Configure compatible action commands separately before enabling mail writes.

## Push through ntfy

Subscribe to a topic in your ntfy client, then configure the command transport:

```yaml
mc:
  desk:
    interruptions:
      transport: command
      command: [/absolute/path/to/bun, /absolute/path/to/cortex-desk-adapters/bin/desk-ntfy.ts, --server, https://ntfy.example.org, --topic, your-private-topic]
      timeoutSeconds: 15
```

`desk-ntfy --topic <topic> [--server https://ntfy.sh] [--token-env NTFY_TOKEN]` reads one JSON push from stdin. Required fields are `key`, `title`, and `why`. An optional `action` has `label` and an HTTP or HTTPS `url`. The title becomes the notification title, `why` its body, and the URL its click destination. Other URL schemes are omitted.

The command posts once over HTTPS and exits 0 on a successful HTTP answer. It exits 1 with a reason on stderr on malformed input, an HTTP failure, or an eight-second request timeout. Redirects are refused. It does not retry. If the named environment variable contains a token, it sends a bearer token. Use a server and topic whose access rules suit the information in your notifications. A public topic name is not a password.

Test the command with an example push:

```sh
printf '%s' '{"key":"example:1","title":"Try the Desk","why":"This is an example push."}' | bun bin/desk-ntfy.ts --server https://ntfy.example.org --topic your-private-topic
```
