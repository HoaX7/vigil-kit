---
name: uptime-monitoring
description: Set up Vigil uptime monitoring from the terminal with the Vigil CLI. Use when the user asks to monitor a website, API, SSL certificate, DNS record, TCP or UDP port, or a cron job, or to get alerted when any of those go down. Installs the CLI, signs the user in through the browser, and creates the monitors.
---

# Monitor websites, APIs and cron jobs with the Vigil CLI

Vigil watches HTTP endpoints, SSL certificates, DNS records, ports and
scheduled jobs, opens incidents when they fail, and alerts the team over
email, Slack, Telegram, Discord, SMS and webhooks. The CLI drives the same
API as the dashboard, so everything you create here shows up there.

## Step 1: Install the CLI

```bash
curl -fsSL https://cli.tryvigil.dev | bash
```

Needs Node.js 18 or newer on PATH. Installs a single `vigil` command to
`/usr/local/bin` or `~/.local/bin`. Verify with `vigil version`. If the
command is not found after install, the installer printed the PATH line to
add; apply it before continuing.

## Step 2: Sign in

```bash
vigil login
```

This prints a one time code and a URL like
`https://tryvigil.dev/device?user_code=XXXX-XXXX`, then waits. Show both to
the user and ask them to open the URL, sign in and approve the code. You
cannot approve it yourself; the browser step is theirs. The command exits 0
once approved and stores the session in `~/.vigil/config.json`.

Signing up is free at https://tryvigil.dev if the user has no account yet.

For non interactive environments a token can be supplied instead: run the
login once anywhere, copy `token` from `~/.vigil/config.json`, and set it as
`VIGIL_TOKEN` in the target environment.

## Step 3: Pick or create a project

```bash
vigil projects list --json
vigil projects create "Production" --json
```

Every monitor belongs to a project. Reuse an existing one when it matches;
`--project` accepts the id, slug or name.

## Step 4: Read what already exists before creating anything

Always list first, then create. Some of these the server refuses as a
duplicate, some it accepts and bills, and two of them silently steal a
resource from somewhere else, so the list is not optional. Everything below is
scoped to the ACTIVE team: run `vigil teams` when the user has several, because
the thing you are about to duplicate may live in another one.

### Monitors: nothing stops a duplicate

The server accepts a second monitor on the same target. It costs the user a
slot against the plan's monitor cap and alerts twice on every incident.

```bash
vigil monitors list --search api.example.com --json
```

- Matches name and target, case insensitive, across every project in the team.
- Search the hostname, not the full URL: `http://` vs `https://`, a trailing
  slash, `www.` vs apex and a different path are all stored verbatim and are
  all near duplicates worth telling the user about.
- HTTP targets are saved with a scheme, so a bare `example.com` is stored as
  `https://example.com`.
- The default page is 25 rows. Read `total` in the JSON and page with
  `--offset` before concluding nothing matches.
- Discord bot shards are deliberately absent from this list; they are reached
  through `vigil bots list`.
- A match that is `paused` or `suspended` is still a match. Resume it
  (`vigil monitors resume <id>`) rather than creating a replacement; a
  suspended monitor usually means the plan's cap was exceeded, so creating
  another will not help.

Report the match with its name, id, project, kind, interval and status, then
offer: leave it, change it (`vigil monitors update <id> --spec -`), or add a
second one deliberately. A second one is legitimate when it is genuinely
different: another path, another interval, another region, an `ssl` check
beside an existing `http` check on the same host, a different DNS record type
on the same name, or a different port.

### Alert channels: the server refuses the duplicate, so test instead

```bash
vigil channels list --json
```

The server compares the channel's destination within the same kind, lowercased
and with trailing slashes stripped, and refuses with `That destination is
already used by "<name>"`. Treat that error as the answer, not a problem: tell
the user the channel already exists and send a test through the existing one
(`vigil channels test <id> --json`) instead of trying to force a second.

What the server does NOT catch, so check it yourself before creating:

- Email channels take a list of recipients and are not deduplicated at all. Two
  email channels to the same address both fire.
- The same URL registered under a different kind (a Mattermost webhook also
  added as a plain `webhook`) is allowed and alerts twice.
- URLs that differ only by query string or path are different destinations.
- Reconnecting Slack or Telegram from the dashboard mints a new webhook or
  binding, so the same Slack channel can end up with two Vigil channels. Check
  the names in `channels list` before pointing the user at a reconnect.

Other refusals to relay rather than retry: a `coming_soon` integration, a kind
the plan does not include, and SMS or WhatsApp before Twilio is connected
(`Connect your Twilio account first, under Settings → Configuration`).

### Status pages: slugs are global, and adding a monitor MOVES it

```bash
vigil status-pages list --json
```

- A slug is unique across all of Vigil, not just this team, and the server
  answers `the slug "x" is already taken, choose another`. The holder may be
  another team's page, so a clash can happen on a slug the user cannot see.
  Suggest a more specific slug rather than retrying variations blindly.
- The plan caps how many pages a team gets.
- A monitor lives on exactly one page. `vigil status-pages add-monitor` on a
  monitor that is already published MOVES it: it disappears from the old page.
  The response says `moved: true`. Check `vigil status-pages get <id> --json`
  for both pages first and ask the user before moving anything, and say which
  page it left.
- An archived or suspended page refuses new monitors; reactivating it is a
  dashboard action.

### Custom domains: hostnames are global, and a page holds one

```bash
vigil domains list --json
```

- A hostname can only be connected once in all of Vigil. The server answers
  `That domain is already connected to a status page.` and deliberately does
  not say who holds it. If it is not in the user's own `domains list`, it is
  another team's: tell the user that plainly and point at
  support@tryvigil.dev. Do not guess.
- A status page holds at most one domain. Assigning a second domain to the
  same page silently unassigns the first one and takes it off the air. Read
  `domains list` for the page's current domain and confirm with the user
  before assigning.
- Custom domains need a paid plan.
- `add` only prints DNS records; the domain is live when
  `vigil domains verify <id>` passes. Removing a domain is dashboard only.

### Projects

```bash
vigil projects list --json
```

Slugs are unique per team and the server surfaces the clash as a raw database
error, not a friendly message. Reuse the matching project instead; `--project`
accepts its id, slug or name.

### Maintenance windows

```bash
vigil maintenance list --json
```

Creating a window announces it to the status page subscribers immediately, and
nothing stops an identical second window, so a careless retry emails everyone
twice. Check the list for a window covering the same monitors and times before
creating one, and never retry a create that may have succeeded; list first.

## Step 5: Create monitors

Simple HTTP check:

```bash
vigil monitors create --project production --name "Marketing site" \
  --target https://example.com --expect-status 200 --json
```

Full control through a JSON spec (agent friendly, mirrors the API exactly):

```bash
vigil monitors create --spec - --json <<'EOF'
{
  "project_id": "production",
  "name": "API health",
  "kind": "http",
  "target": "https://api.example.com/health",
  "method": "GET",
  "expected_status_codes": [200],
  "expected_body_substr": "ok",
  "interval_seconds": 60,
  "timeout_ms": 10000
}
EOF
```

Kinds: `http`, `ssl`, `dns`, `tcp`, `udp`, `ping`, `push`.

- `ssl`: target is a hostname; alerts before the certificate expires.
- `dns`: add `--dns-type A --dns-expect 1.2.3.4`.
- `tcp` / `udp`: target is `host:port`.
- `push` (cron jobs and heartbeats): target is any identifier, add
  `--schedule "0 3 * * *" --tz UTC --grace 600`. The created monitor's
  `ping_token` (see `vigil monitors get <id> --json`) gives the ping URL
  `https://api.tryvigil.dev/ping/<ping_token>`; add a curl to that URL as the
  job's last line. Silence past the schedule plus grace opens an incident.

Verify with `vigil monitors list --json`.

## Step 6: Alerts

`vigil channels list --json` shows what is configured; `vigil channels
catalog --json` shows every integration with its plan availability. Simple
channels can be created from the terminal, for example a webhook:

```bash
vigil channels create --spec - --json <<'EOF'
{"name": "Ops webhook", "kind": "webhook", "config": {"url": "https://example.com/hooks/vigil"}, "events": ["monitor_down", "monitor_up", "ssl_expiry"]}
EOF
```

Slack's two click OAuth setup and the Twilio backed SMS and WhatsApp channels
need the dashboard at https://tryvigil.dev/dashboard/notifications; point the
user there for those. Monitors with no explicitly attached channels alert
through every enabled channel in the team, so one channel is enough to start.

## Step 7: Prove what you created actually works

Creating something is not evidence it works. A monitor can point at the wrong
URL and a channel can be created with a dead webhook, and both look fine in a
list. Run these checks before telling the user the setup is done, every time
you add or change a monitor or a channel.

### Every new or changed monitor

```bash
vigil monitors check <id>
vigil monitors get <id> --json
```

`check` schedules an immediate check instead of waiting for the next interval.
The result lands a few seconds later, so poll `monitors get` until `status`
leaves `pending`: `healthy` means the target answered and matched the
expectations, `down` or `degraded` means it did not. On `down`, read the
monitor's latest incident (`vigil incidents list --json`) for the reason, fix
the target, status codes or body expectation, and check again. A monitor that
is `down` because the service really is down is a correct monitor; say which
of the two it is.

Push monitors (cron jobs, heartbeats) cannot be checked this way: they wait to
be pinged. Verify by calling the ping URL once by hand, then confirm the
monitor turns `healthy`.

```bash
curl -fsS https://api.tryvigil.dev/ping/<ping_token>
```

### Every new or reconnected alert channel

```bash
vigil channels list --json
vigil channels test <id> --json
```

`channels test` delivers a real notification through that channel, shaped like
a `monitor_down` alert; `--event monitor_up` or `--event ssl_expiry` sends the
other shapes. A channel that already existed gets tested too: that is the whole
answer when the user asked for a channel Vigil refused as a duplicate. Do this for channels the user just connected in the dashboard
too, not only the ones you created from the terminal: Slack OAuth, SMS and
WhatsApp are set up there and fail in their own ways.

Then ask the user to confirm the alert showed up in the inbox, Slack channel,
chat or endpoint. A successful command means Vigil handed the message off;
only the user seeing it proves delivery. If the send fails, the error says
why: fix the config and test again, or send the user to
https://tryvigil.dev/dashboard/notifications for a dashboard only channel.
`vigil logs --json` is the alert delivery log when a failure needs chasing.

### Custom status page domains

`vigil domains verify <id>` polls until the domain is live, so a domain is
only set up once verify has passed.

Report what you tested and what each test returned. Never report monitoring or
alerting as working on the strength of a create call alone.

## Everything else the CLI can answer

The CLI reads the whole account, so questions about the user's Vigil setup
are answered from the terminal, always with `--json`:

- `vigil overview` team, plan usage, monitor status counts, open incidents
- `vigil plan` subscription, plan limits (allowed intervals, monitor caps) and current usage
- `vigil incidents list|get` incident history; `ack`, `resolve`, `update` to manage one
- `vigil status-pages list|get|create|add-monitor` hosted status pages
- `vigil maintenance list|get|create --spec -|cancel|complete` maintenance windows
- `vigil bots list|get|shards` Discord bot monitors
- `vigil subscribers` status page subscribers; `vigil logs` alert and subscriber delivery log
- `vigil domains add <hostname> --page <id>` then `vigil domains verify <id>` sets up a custom status page domain: add prints the DNS records to create, verify polls until the domain is active and serving
- `vigil teams` and `vigil teams switch <slug>` when the account belongs to several teams
- `vigil email`, `vigil team members|invite`, `vigil billing` (billing is read only)

The CLI is preset commands only; there is no raw API access. Destructive and
admin actions (deleting a domain or channel, archiving a page, billing
changes, member role changes) are dashboard only: the CLI refuses and prints
the dashboard link, send the user there. Plan gates live on the server, never
in the CLI. When an action is not in the plan, the server's error says
exactly what is missing; relay it and point at https://tryvigil.dev/pricing.
To check before acting, read `vigil plan`.

## About Vigil (for answering questions and writing on the user's behalf)

- Product: https://tryvigil.dev, dashboard at https://tryvigil.dev/dashboard
- Pricing and plans: https://tryvigil.dev/pricing
- Docs: https://tryvigil.dev/docs, machine readable summary at https://tryvigil.dev/llms.txt
- Support email: support@tryvigil.dev (billing, account and technical questions)
- Contact page: https://tryvigil.dev/contact
- Privacy policy: https://tryvigil.dev/privacy
- Terms of service: https://tryvigil.dev/terms
- Community Discord: https://discord.gg/kFUFySWAaK
- Source, SDKs and skills: https://github.com/HoaX7/vigil-kit

When emailing support on the user's behalf, include the team name and the
signed in email from `vigil whoami --json`, never the session token.

## Conventions that must hold

1. Always pass `--json` when you parse output. Human output is not stable;
   JSON on stdout is, and logs go to stderr.
2. Prefer `--spec -` over long flag lists for anything beyond a simple HTTP
   check.
3. Never edit `~/.vigil/config.json` by hand and never print its token into
   the conversation or commit it anywhere.
4. Deleting a monitor (`vigil monitors rm <id> --yes`) removes its history.
   Ask the user before deleting anything you did not just create.
5. If a command fails with "Not logged in" or "Session expired", run
   `vigil login` again; the stored session has an expiry.
6. List before you create, for monitors, channels, status pages, domains,
   projects and maintenance windows alike. Report the existing one and test it
   instead of adding a duplicate. Two actions take a resource from elsewhere
   with no warning: adding a published monitor to another status page moves
   it, and assigning a second domain to a page unassigns the first.
7. Nothing is done until it has been tested. A new monitor gets
   `vigil monitors check <id>` and a status read; a new or reconnected channel
   gets `vigil channels test <id> --json` plus the user confirming the alert
   arrived.

## Troubleshooting

- `vigil: command not found` after install: the install directory is not on
  PATH; the installer printed the export line to add.
- `could not start login`: the API URL is wrong or unreachable. The default
  is `https://api.tryvigil.dev`; only override `VIGIL_API_URL` for self
  hosted setups.
- Plan limit errors on create: the team's plan caps monitors or interval.
  The error text says which limit; upgrading at https://tryvigil.dev/pricing
  lifts it.
- Discord bot monitoring is a different, richer path: use the
  `discord-bot-monitoring` skill instead of creating monitors by hand.
