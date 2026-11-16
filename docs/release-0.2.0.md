# cortex-desk-adapters v0.2.0

The first release of the portable package. It runs without any tool from the personal toolkit.

## Portable commands

- `desk-ics`: reads an ICS calendar.
- `desk-imap`: reads IMAP mail (links, invitations, the HTML first paragraph, and sent mail with `--sent`).
- `desk-ntfy`: an ntfy transport.
- `desk-mail-move`, `desk-mail-trash`: move mail, with Undo.
- `desk-mail-draft`: saves a reply draft over IMAP.
- `desk-mail-report`: saves a phishing report draft.
- `desk-mail-invite`: answers an invitation.
- `desk-mail-send`: sends a mail to the principal's own addresses.
- `desk-mail-dmarc`: reads a DMARC report.
- `desk-parse`: parses command-bar text.
- `desk-calendar-create`: creates a calendar event.
- The `mac/` Swift sources for macOS calendar and reminders.

## The `--config` flag

Every portable mail command (`desk-imap`, `desk-mail-move`, `desk-mail-trash`, `desk-mail-draft`, `desk-mail-report`, `desk-mail-invite`, `desk-mail-send`, `desk-mail-dmarc`) takes `--config <path>`: a mail account file, which `threva setup` writes. Without it, a command keeps reading the `email` CLI's config at `~/.config/email/config.json`.

## Personal commands

The commands that wrap the personal toolkit moved to `personal/`. The old `bin/` paths stay as re-exports for one release.
