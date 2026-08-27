import { DASH } from "./links.js";

export function topHelp(version: string, defaultApi: string): string {
  return `vigil ${version} — Vigil uptime monitoring from the terminal

Usage: vigil <command> [subcommand] [flags]

Account     login · logout · whoami · teams
Insight     overview · plan · billing
Monitoring  projects · monitors · incidents
Alerting    channels · logs
Public      status-pages · maintenance · domains · subscribers · email
Team        team
Discord     bots
CLI         version · update

Run vigil <command> --help for that command's subcommands and flags.
Global: --json prints machine readable JSON on stdout; logs go to stderr.
Environment: VIGIL_TOKEN overrides the stored login, VIGIL_API_URL the API
base (default ${defaultApi}).

Plan limits and permissions are enforced by the server on every call.
Destructive or admin actions live in the dashboard; the CLI links there.
Docs: https://tryvigil.dev/llms.txt`;
}

const TOPICS: Record<string, string> = {
  login: `vigil login [--api <url>] [--json]

Signs in through the browser. Prints a one time code and an approval URL,
waits for the approval, stores the session in ~/.vigil/config.json (0600).
vigil logout signs out and removes the stored token.`,

  whoami: `vigil whoami [--json]

The signed in user, the active team and the API base.`,

  teams: `vigil teams [--json]
vigil teams switch <team-id|slug>

Lists every team the account belongs to and switches the active team. All
other commands act on the active team.`,

  overview: `vigil overview [--json]

Team, plan usage, monitor status counts and open incidents in one call.`,

  plan: `vigil plan [--json]

Subscription, plan limits (allowed intervals, monitor caps) and current
usage. Read this before creating things to know what the plan allows.`,

  projects: `vigil projects list [--json]
vigil projects create <name> [--slug <slug>] [--json]

Deleting a project is a dashboard action: ${DASH.monitors}`,

  monitors: `vigil monitors list [--project <id|slug>] [--limit <n>] [--offset <n>] [--search <text>] [--json]
vigil monitors get <id> [--json]
vigil monitors create --project <id|slug> --name <name> [flags] | --spec <file|->
vigil monitors update <id> --spec <file|->
vigil monitors rm <id> --yes
vigil monitors pause <id> · resume <id> · check <id>

Create flags: --kind http|ssl|dns|tcp|udp|ping|push (default http),
--target <url|host|host:port>, --method, --expect-status <csv>,
--expect-body, --dns-type, --dns-expect <csv>, --interval <s>,
--timeout <ms>, --regions <csv>, --schedule <cron>, --tz, --grace <s>.
--spec <file|-> posts a full JSON body instead (mirrors the API input).
The plan caps the interval and monitor count; the server enforces both.`,

  incidents: `vigil incidents list [--status open|resolved] [--limit <n>] [--json]
vigil incidents get <id> [--json]
vigil incidents ack <id> · resolve <id>
vigil incidents update <id> --message "text"`,

  channels: `vigil channels list [--json]
vigil channels catalog [--json]         Integrations and plan availability
vigil channels create --spec <file|->   e.g. {"name":"Ops","kind":"webhook","config":{"url":"…"},"events":["monitor_down"]}
vigil channels test <id> [--event monitor_down|monitor_up|ssl_expiry]

Slack OAuth, SMS and WhatsApp setup, and deleting a channel are dashboard
actions: ${DASH.notifications}`,

  "status-pages": `vigil status-pages list [--json]
vigil status-pages get <id> [--json]
vigil status-pages create --project <id> --slug <slug> --title <title>
vigil status-pages add-monitor <page-id> <monitor-id>

Archiving or deleting a page is a dashboard action: ${DASH.statusPages}`,

  maintenance: `vigil maintenance list [--json]
vigil maintenance get <id> [--json]
vigil maintenance create --spec <file|->   title, starts_at, ends_at, monitor_ids[]
vigil maintenance cancel <id> · complete <id>`,

  domains: `vigil domains list [--json]
vigil domains add <hostname> [--page <status-page-id>]
vigil domains assign <id> <status-page-id>
vigil domains verify <id> [--timeout <seconds>]

add prints the DNS records to create; verify polls until the domain is
active. Removing a domain is a dashboard action: ${DASH.domains}`,

  bots: `vigil bots list [--json]
vigil bots get <id> [--json]
vigil bots shards <id> [--json]

Read only. Creating a bot and its token live in the dashboard.`,

  subscribers: `vigil subscribers [--page-id <id>] [--status <s>] [--limit <n>] [--offset <n>] [--json]

Read only. Status page subscribers across the team.`,

  logs: `vigil logs [--status sent|failed|queued] [--audience alert|subscriber] [--limit <n>] [--offset <n>] [--json]
vigil logs detail <alert|subscriber> <id> [--json]

The delivery log: where every alert and subscriber notice went.`,

  email: `vigil email [--json]

Read only. Lists the custom email senders your alert and subscriber mail is
sent from. With none configured, mail goes out from the default Vigil
sender. Set up your own domain in the dashboard: ${DASH.email}`,

  team: `vigil team members [--json]
vigil team invite <email> [--role member|admin]

Role changes and removals are dashboard actions: ${DASH.team}`,

  billing: `vigil billing [--json]

Read only. Subscription and plan details. Payment methods, plan changes and
invoices are dashboard actions: ${DASH.billing}`,

  update: `vigil update

Downloads and installs the latest CLI over the current one.`,
};

export function topicHelp(command: string): string | undefined {
  return TOPICS[command];
}
