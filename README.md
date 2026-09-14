# WhatsApp Group Bot

A personal bot for managing WhatsApp groups where **your** account is an administrator. You can list groups and members, and remove selected members, or all non-admins, in bulk. Every removal requires a preview and an explicit confirmation.

It is built with Node.js, TypeScript and [Baileys](https://github.com/WhiskeySockets/Baileys), a WhatsApp Web multi-device library. The bot runs as a **linked device** on your own account, the same way WhatsApp Web does.

> **Read [Security considerations](#10-security-considerations) before using it.** Baileys is not an official WhatsApp API. Automating a personal account is against WhatsApp's Terms of Service and could get your account restricted. Use it sparingly, on your own groups, at your own risk.

---

## Contents

1. [Requirements](#1-requirements)
2. [Node.js installation](#2-nodejs-installation)
3. [Project installation](#3-project-installation)
4. [Environment configuration](#4-environment-configuration)
5. [WhatsApp authentication](#5-whatsapp-authentication)
6. [Running the bot](#6-running-the-bot)
7. [Development mode](#7-development-mode)
8. [Production mode](#8-production-mode)
9. [Available commands](#9-available-commands)
10. [Security considerations](#10-security-considerations)
11. [Troubleshooting](#11-troubleshooting)
12. [How to stop the bot](#12-how-to-stop-the-bot)
13. [Project structure & design](#13-project-structure--design)
14. [Known limitations](#14-known-limitations)

---

## 1. Requirements

- **Node.js 20 or newer** (Baileys 7 requires Node ≥ 20)
- npm 10+ (bundled with Node)
- A phone with WhatsApp that has a free "linked device" slot
- macOS, Linux or Windows (WSL recommended)

## 2. Node.js installation

Check what you have:

```bash
node -v   # must print v20.x or higher
```

If Node is missing or too old:

**macOS (Homebrew)**
```bash
brew install node@20
```

**Any OS, using nvm (recommended)**
```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
# restart your terminal, then:
nvm install 20
nvm use 20
```

**Windows:** install the LTS build from <https://nodejs.org>.

## 3. Project installation

```bash
cd whatsapp-bot
npm install
```

## 4. Environment configuration

Create your local config (`.env` is git-ignored):

```bash
cp .env.example .env
```

Edit `.env`:

| Variable | Default | Description |
|---|---|---|
| `OWNER_PHONE` | **required** | Your WhatsApp number, digits only, international format, e.g. `919876543210`. **Must be the account you link.** |
| `COMMAND_PREFIX` | `!` | Command prefix |
| `LOG_LEVEL` | `info` | `trace` `debug` `info` `warn` `error` `fatal` |
| `DRY_RUN` | `false` | `true` makes every removal a simulation |
| `AUTH_METHOD` | `qr` | `qr` or `pairing` (8-character code) |
| `AUTH_DIR` | `./auth` | Where the session is stored |
| `LOG_DIR` | `./logs` | Where `bot.log` is written |
| `CONFIRM_TTL_SECONDS` | `120` | How long a preview can be confirmed |
| `REMOVE_BATCH_SIZE` | `5` | Members removed per WhatsApp request |
| `REMOVE_BATCH_DELAY_MS` | `3000` | Pause between batches |
| `OPERATION_TIMEOUT_MS` | `30000` | Timeout for each WhatsApp request |

The bot validates the config at startup and exits with a clear message if anything is wrong.

> Tip: keep `DRY_RUN=true` until you have checked the previews on a real group.

## 5. WhatsApp authentication

On first start the bot has no session and asks you to link it.

**QR code (default, `AUTH_METHOD=qr`)**
1. Run `npm run dev`.
2. A QR code appears in the terminal.
3. On your phone: **WhatsApp → Settings → Linked devices → Link a device**, then scan the code.
   QR codes expire after about 20 seconds, and a new one is printed automatically.

**Pairing code (`AUTH_METHOD=pairing`)**
1. Run `npm run dev`. An 8-character code is printed for `OWNER_PHONE`.
2. On your phone: **Linked devices → Link a device → Link with phone number instead**, then enter the code.

After linking, the session is saved in `auth/` (permissions `0700`, git-ignored). Later restarts reconnect without scanning again.

The QR code and pairing code are only printed to the terminal. They are never written to the log file.

On connect, the bot checks that the linked account's number equals `OWNER_PHONE`. If they differ, it refuses to run.

## 6. Running the bot

```bash
npm install          # once
npm run dev          # development (auto-restart on code changes)
npm run build        # compile TypeScript to dist/
npm start            # run compiled build
npm test             # run the test suite (no WhatsApp connection needed)
```

Dry-run for a whole session, regardless of `.env`:

```bash
npm run dev -- --dry-run
npm start -- --dry-run
```

**Where to type commands:** open WhatsApp on your phone and go to the chat with yourself ("Message yourself", the chat with your own name at the top of the contact list). The bot **only** listens there.

## 7. Development mode

```bash
npm run dev
```

This uses `tsx watch`: TypeScript runs directly and the bot restarts when you save a file. The saved session is reused, so you won't need to scan again. Other useful scripts:

```bash
npm run typecheck    # tsc --noEmit
npm run test:watch   # vitest in watch mode
```

## 8. Production mode

```bash
npm ci
npm run build
NODE_ENV=production npm start
```

When stdout isn't a terminal, logs go to stdout as JSON as well as to `logs/bot.log`.

To keep it running in the background, use a process manager, for example **pm2**:

```bash
npm install -g pm2
pm2 start dist/index.js --name wa-group-bot
pm2 logs wa-group-bot
pm2 save
```

Link the device once interactively (`npm start`) before handing it to pm2, because you need to see the QR code. Run **only one instance** per session. A second one causes a "connection replaced" error.

## 9. Available commands

`<group>` is either the number from `!groups` or the group name. Partial names work if they're unique. If a group name ends in a number, put it in quotes, e.g. `"Batch 2024"`.

| Command | What it does |
|---|---|
| `!help` | Lists all commands |
| `!groups` | Lists your groups, marked `[ADMIN]` where you're an admin |
| `!admingroups` | Lists **only** the groups where you're an admin, using the same numbers as `!groups` |
| `!members <group>` | Numbered member list with `[ADMIN]`, `[OWNER]` (creator), `[YOU]` |
| `!remove <group> <numbers>` | Removal preview. Numbers: `1,3,4`, `1 3 4`, `2-6` |
| `!removeall <group>` | Preview removing **all non-admin** members |
| `!removeall 1,3,7` / `!removeall 1-4` | The same for **several groups** at once, by group number |
| `!removeall Group A \| Group B` | Several groups by name, separated by `\|` |
| `!cancel` | Discards the pending operation, or stops a running removal after its current batch |
| `!status` | Connection, uptime, account, group count, last command, pending/running operation |
| `CONFIRM` | Runs a pending `!remove` |
| `CONFIRM REMOVEALL` | Runs a pending `!removeall` |

Add `--dry-run` to `!remove` or `!removeall` to simulate that single operation.

### Example session

```text
You:  !groups
Bot:  Your WhatsApp Groups

      1. College Group [ADMIN]
      2. Event Volunteers
      3. Project Team [ADMIN]

You:  !members 1
Bot:  College Group

      1. Akhil (+911000000002) [ADMIN]
      2. Arun (+911000000004)
      3. John (+911000000005) [OWNER]
      4. Neha (+911000000003)
      5. Rahul (+911000000001)

      Members: 5 · Admins: 2

You:  !remove College Group 2,4,5
Bot:  Removal Preview

      Group: College Group
      Members to remove: 3

      2. Arun (+911000000004)
      4. Neha (+911000000003)
      5. Rahul (+911000000001)

      Admins protected: 2

      Reply with:
      CONFIRM

You:  CONFIRM
Bot:  Removing 3 member(s) from "College Group"…
Bot:  Removal completed

      Group: College Group
      Successfully removed: 2
      Failed: 1

      Failed members:
      - Neha (+911000000003) — permission error
```

### Clearing several groups at once

```text
You:  !admingroups
Bot:  Groups You Admin

      1. College Group
      3. Project Team
      7. Sports Club

      You are an admin in 3 of 9 groups.

You:  !removeall 1,3,7
Bot:  WARNING — MULTIPLE GROUPS

      Groups: 3
      Total members to remove: 89

      College Group — 47 to remove, 3 admins protected
      Project Team — 12 to remove, 2 admins protected
      Sports Club — 30 to remove, 4 admins protected
      …(member names for each group)…

      Reply:
      CONFIRM REMOVEALL

You:  CONFIRM REMOVEALL
Bot:  Removing 89 member(s) from 3 groups…
Bot:  College Group: 47 removed, 0 failed (1/3)
Bot:  Project Team: 10 removed, 2 failed (2/3)
Bot:  Sports Club: 30 removed, 0 failed (3/3)
Bot:  Removal completed — 3 groups
      Total removed: 87
      Total failed: 2
      …
```

- You must be an admin in **every** selected group. If you aren't admin in any of them, the whole command is rejected and nothing is queued.
- You can select at most **20 groups** per operation. Groups selected twice are counted once. Groups with no non-admin members are listed and skipped.
- Groups are processed **one after another**, each re-checked right before its removals start. If one group fails its check (for example, you lost admin rights), only that group is aborted.
- `!cancel` stops after the current batch, and any groups not yet started are left untouched. If the connection is lost, the remaining groups aren't attempted either.
- Long previews are split into several messages.

### Safety rules built in

- Commands are accepted **only** when you send them from your own account, in your own self-chat. Anything anyone else sends is silently ignored, and so are commands you type in groups or other chats.
- `!members`, `!remove` and `!removeall` only work in groups where you're an admin.
- Administrators, the group creator and your own account are **never** removed. If you select them, they're skipped and the preview says so.
- There is only **one** pending operation at a time, and it expires after `CONFIRM_TTL_SECONDS`. Once used, the confirmation is gone, so a second `CONFIRM` does nothing.
- A `CONFIRM` older than the preview, or one sent while the bot was offline, is ignored.
- Member numbers refer to your last `!members` list. If a selected member has since left, the bot refuses and asks you to list the members again, so it never removes the wrong person.
- Right before removing, the bot re-checks the group: you're still an admin, nobody targeted has become an admin, and everybody targeted is still present.
- A member is reported as removed **only** if WhatsApp returned success for them **and** a follow-up check shows they're gone.

## 10. Security considerations

- **Unofficial API.** Baileys reverse-engineers WhatsApp Web. WhatsApp can change its protocol or restrict accounts that automate. The bot does not try to get around bans, CAPTCHAs, rate limits or any other platform restriction. When WhatsApp rate-limits it, it slows down.
- **`auth/` is equivalent to being logged in to your WhatsApp.** Anyone with this folder can read and send messages as you. Never commit it, share it, sync it to cloud storage or copy it to untrusted machines. It's git-ignored and created with `0700` permissions.
- **Logs** (`logs/bot.log`) contain group names, member numbers and an audit trail of actions. Session keys, QR data and pairing codes are redacted and never logged. Treat the logs as private anyway.
- **No secrets over WhatsApp.** Commands never expose credentials, file paths, stack traces or log contents.
- **Unlink at any time** from your phone: WhatsApp → Settings → Linked devices → select the device → Log out.
- **Remove sparingly.** Bulk removals are paced (5 per request, 3s apart) to stay well within normal human-like usage.

## 11. Troubleshooting

| Symptom | Fix |
|---|---|
| `Invalid configuration … OWNER_PHONE` | Set `OWNER_PHONE` in `.env` to digits only, with country code, e.g. `919876543210`. |
| `OWNER_PHONE does not match the linked WhatsApp account` | You linked a different number. Fix `OWNER_PHONE`, or `rm -rf auth/` and link the correct account. |
| `Logged out from WhatsApp` | The device was unlinked from the phone. Stop the bot, `rm -rf auth/`, start again and re-link. |
| `Connection replaced` | Another instance (or a copy of `auth/`) is running. Stop the other one. |
| QR code keeps changing | That's normal: each code expires after about 20s. Scan the newest one. |
| QR code looks garbled | Make the terminal wider or use a smaller font, or switch to `AUTH_METHOD=pairing`. |
| Bot doesn't respond | Make sure you're typing in **your own** chat ("Message yourself"), not in a group. Check `!status`. Run with `LOG_LEVEL=debug`. |
| "You are not an administrator…" | The bot only manages groups where your account is an admin. |
| Member shows as "Hidden number" | WhatsApp hides phone numbers in some groups (LID privacy). The member can still be removed. |
| `temporary WhatsApp error` / `429` in the report | You hit rate limits. Wait a few minutes, then run the command again for the members who failed. You can also increase `REMOVE_BATCH_DELAY_MS`. |
| `permission error` for a member | WhatsApp refused (for example, you lost admin rights mid-operation). |
| `Reconnect failed` loops | Check your network connection. The bot retries with backoff, waiting up to 60s between attempts. |
| `npm install` fails on engines | Upgrade to Node 20+ (`nvm install 20`). |

## 12. How to stop the bot

- **Terminal:** press `Ctrl+C`. The bot stops accepting commands and discards any pending confirmation. If a removal is running, it stops after the current batch (waiting at most 30s), logs the result, then closes the connection. The session stays linked.
- **pm2:** `pm2 stop wa-group-bot`. It sends SIGTERM, which triggers the same graceful shutdown.
- **systemd / Docker:** `SIGTERM` is handled the same way.
- **Unlink permanently:** stop the bot, then on your phone go to Linked devices → Log out, and delete `auth/`.

## 13. Project structure & design

```text
src/
  index.ts                  bootstrap, --dry-run flag, graceful shutdown
  config.ts                 zod-validated environment config
  whatsapp/                 ← the ONLY code that imports Baileys
    client.ts               WhatsAppClient interface used by everything else
    connection.ts           auth state, QR/pairing, reconnect with backoff
    groups.ts               Baileys implementation: groups, removal, messaging
    messages.ts             Baileys message → IncomingMessage
  core/
    router.ts               dedupe → authorize → freshness → parse → dispatch → reply
    parser.ts               commands, CONFIRM tokens, member index parsing
    types.ts                shared types, UserError
  commands/                 help, groups, members, remove, removeAll, confirm, cancel, status
  services/
    groupService.ts         group resolution + admin checks
    memberService.ts        stable member numbering, selection, admin protection
    confirmationService.ts  single pending operation, TTL, token matching
    removalService.ts       batching, retries, timeouts, verification, reports
  utils/
    logger.ts               pino (file + console), secret redaction
    permissions.ts          owner authorization, admin/self detection
    retry.ts                timeouts, backoff, error classification
tests/                      vitest suites + FakeWhatsAppClient
```

How a message is handled:

```text
Incoming message
  → already seen / sent by the bot? ignore
  → fromMe AND in your own self-chat AND OWNER_PHONE == linked account? otherwise ignore
  → parse command / CONFIRM
  → older than startup or > 5 min? ignore
  → command: resolve group → require admin → act
```

Tests (`npm test`) cover command parsing, owner authorization, admin detection, member selection, confirmation handling, cancellation, dry run, invalid groups and indexes, unauthorized users, partial failures, rate limits, lost connections and post-removal verification. None of them connect to WhatsApp.

## 14. Known limitations

- **Admins cannot be removed by this bot.** This is a deliberate design choice. The group creator can't be removed by anyone through WhatsApp.
- **Community parent groups** are hidden from `!groups`. Manage members in the community's sub-groups.
- **Commands work only from your own account's self-chat.** Controlling the bot from a second phone number isn't supported.
- **Removals can't be undone by the bot.** Re-adding people requires them to rejoin, or you adding them manually.
- Since Baileys 7 is a release candidate (`7.0.0-rc14`) and WhatsApp changes its protocol from time to time, an update may occasionally be needed: `npm install baileys@latest`.
