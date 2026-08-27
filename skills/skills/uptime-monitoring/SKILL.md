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

## Step 4: Create monitors

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

## Step 5: Alerts

`vigil channels list --json` shows what is configured; `vigil channels
catalog --json` shows every integration with its plan availability. Simple
channels can be created from the terminal, for example a webhook:

```bash
vigil channels create --spec - --json <<'EOF'
{"name": "Ops webhook", "kind": "webhook", "config": {"url": "https://example.com/hooks/vigil"}, "events": ["monitor_down", "monitor_up", "ssl_expiry"]}
EOF
```

Verify with `vigil channels test <id>`. Slack's two click OAuth setup and the
Twilio backed SMS and WhatsApp channels need the dashboard at
https://tryvigil.dev/dashboard/notifications; point the user there for those.
Monitors with no explicitly attached channels alert through every enabled
channel in the team, so one channel is enough to start.

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
