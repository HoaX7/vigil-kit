import { spawn } from "node:child_process";
import { parseArgs, str, num, csv, bool, type Parsed } from "./args.js";
import { apiUrl, clearConfig, saveConfig, DEFAULT_API_URL } from "./config.js";
import { CliError, pollDeviceToken, requestDeviceCode, setNetObserver, signOut, trpcMutation, trpcQuery } from "./http.js";
import { log, printJson, say, table } from "./output.js";
import { readSpec } from "./spec.js";
import { netHooks, trackStep } from "./ui.js";
import * as res from "./resources.js";

declare const __VIGIL_VERSION__: string;
const VERSION = typeof __VIGIL_VERSION__ === "string" ? __VIGIL_VERSION__ : "dev";
const INSTALL_URL = "https://cli.tryvigil.dev";

const HELP = `vigil ${VERSION} — Vigil uptime monitoring from the terminal

Usage: vigil <command> [subcommand] [flags]

Commands:
  login [--api <url>]          Sign in through the browser (device flow)
  logout                       Sign out and remove the stored token
  whoami [--json]              Show the signed in user and team
  overview                     Team, usage, monitor status counts, open incidents
  plan                         Subscription, plan limits and usage
  projects list [--json]       List projects
  projects create <name> [--slug <slug>] [--json]
  monitors list [--project <id|slug>] [--json]
  monitors get <id> [--json]
  monitors create [flags] | --spec <file|->   Create a monitor
  monitors update <id> --spec <file|->        Change a monitor
  monitors rm <id> --yes       Delete a monitor
  monitors pause <id>          Pause checks
  monitors resume <id>         Resume checks
  monitors check <id>          Run a check now
  incidents list [--status open|resolved] | get <id> | ack <id> | resolve <id> | update <id> --message "..."
  channels list | catalog | create --spec <file|-> | test <id> [--event <event>]
  status-pages list | get <id> | create --project <id> --slug <s> --title <t> | add-monitor <page> <monitor>
  maintenance list | get <id> | create --spec <file|-> | cancel <id> | complete <id>
  bots list | get <id> | shards <id>
  subscribers [--page-id <id>] [--status <s>]
  logs [--status sent|failed|queued] [--audience alert|subscriber] | logs detail <audience> <id>
  domains list | add <hostname> [--page <id>] | assign <id> <page-id> | verify <id> | rm <id> --yes
  email                        List email senders
  team members | invite <email> [--role member|admin]
  billing                      Subscription and payment capabilities
  api <router.procedure> [--input <json|->] [--mutation]   Call any API procedure
  version                      Print the CLI version
  update                       Update the CLI to the latest version

Plan limits are enforced by the server on every call. When something is not
included in the plan the error says so; run vigil plan to see limits first.

Monitor create flags:
  --project <id|slug>   Project the monitor belongs to (required)
  --name <name>         Display name (required)
  --kind <kind>         http | ssl | dns | tcp | udp | ping | push (default http)
  --target <target>     URL, hostname or host:port (required for most kinds)
  --method <verb>       HTTP method (http)
  --expect-status <csv> Accepted HTTP status codes, e.g. 200,204 (http)
  --expect-body <text>  Substring the response body must contain (http)
  --dns-type <type>     DNS record type, e.g. A, CNAME (dns)
  --dns-expect <csv>    Expected DNS values (dns)
  --interval <seconds>  Check interval
  --timeout <ms>        Check timeout
  --regions <csv>       Probe regions
  --schedule <cron>     Cron expression (push/heartbeat monitors)
  --tz <zone>           Timezone for --schedule
  --grace <seconds>     How late a scheduled ping may be
  --spec <file|->       Full JSON body instead of flags (- reads stdin)

Global flags:
  --json                Machine readable output on stdout, logs on stderr

Environment:
  VIGIL_TOKEN           Token to use instead of the stored login
  VIGIL_API_URL         API base (default ${DEFAULT_API_URL})

Docs: https://tryvigil.dev/llms.txt`;

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(cmd, [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {
    /* the printed URL is the fallback */
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function login(p: Parsed): Promise<void> {
  const api = str(p.flags, "api") ?? apiUrl();
  const dc = await requestDeviceCode(api);
  log(`First, copy your one-time code: ${dc.user_code}`);
  log(`Then approve it at: ${dc.verification_uri_complete}`);
  log("Waiting for approval…");
  openBrowser(dc.verification_uri_complete);

  const token = await trackStep("Waiting for approval in the browser…", async () => {
    let intervalS = dc.interval || 5;
    const deadline = Date.now() + dc.expires_in * 1000;
    while (Date.now() < deadline) {
      await sleep(intervalS * 1000);
      const poll = await pollDeviceToken(api, dc.device_code);
      if (poll.status === "slow_down") {
        intervalS += 5;
        continue;
      }
      if (poll.status === "pending") continue;
      if (poll.status === "failed") throw new CliError(poll.reason);
      return poll.token;
    }
    throw new CliError("The code expired before it was approved. Run: vigil login");
  });

  saveConfig({ api_url: api, token, saved_at: new Date().toISOString() });
  let who: { email?: string } = {};
  try {
    who = ((await trpcQuery("org.me")) ?? {}) as { email?: string };
    saveConfig({ api_url: api, token, user: who, saved_at: new Date().toISOString() });
  } catch {
    /* token works even if the profile lookup fails */
  }
  if (bool(p.flags, "json")) printJson({ logged_in: true, email: who.email ?? null, api_url: api });
  else say(`Logged in${who.email ? ` as ${who.email}` : ""}.`);
}

async function whoami(p: Parsed): Promise<void> {
  const me = await trpcQuery("org.me");
  const org = await trpcQuery("org.get").catch(() => null);
  if (bool(p.flags, "json")) {
    printJson({ user: me, team: org, api_url: apiUrl() });
    return;
  }
  const u = (me ?? {}) as { email?: string; name?: string };
  const t = (org ?? {}) as { name?: string };
  say(`User: ${u.name ?? ""} ${u.email ? `<${u.email}>` : ""}`.trim());
  if (t.name) say(`Team: ${t.name}`);
  say(`API:  ${apiUrl()}`);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveProject(ref: string): Promise<string> {
  if (UUID.test(ref)) return ref;
  const rows = ((await trpcQuery("projects.list")) ?? []) as { id: string; slug?: string; name?: string }[];
  const hit = rows.find((r) => r.slug === ref || r.name === ref);
  if (!hit) {
    throw new CliError(`No project named "${ref}". Run: vigil projects list`);
  }
  return hit.id;
}

async function projects(p: Parsed): Promise<void> {
  const sub = p.positional[1] ?? "list";
  if (sub === "list") {
    const rows = ((await trpcQuery("projects.list")) ?? []) as Record<string, unknown>[];
    if (bool(p.flags, "json")) printJson(rows);
    else table(rows, ["id", "slug", "name"]);
    return;
  }
  if (sub === "create") {
    const name = p.positional[2] ?? str(p.flags, "name");
    if (!name) throw new CliError("Usage: vigil projects create <name> [--slug <slug>]");
    const slug =
      str(p.flags, "slug") ??
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
    const row = await trpcMutation("projects.create", { name, slug });
    if (bool(p.flags, "json")) printJson(row);
    else say(`Created project "${name}" (${(row as { id?: string })?.id ?? ""})`);
    return;
  }
  throw new CliError(`Unknown subcommand "projects ${sub}". Run: vigil --help`);
}

async function monitors(p: Parsed): Promise<void> {
  const sub = p.positional[1] ?? "list";
  const json = bool(p.flags, "json");

  if (sub === "list") {
    const projectRef = str(p.flags, "project");
    const input = projectRef ? { project_id: await resolveProject(projectRef) } : undefined;
    const rows = ((await trpcQuery("monitors.list", input)) ?? []) as Record<string, unknown>[];
    if (json) printJson(rows);
    else table(rows, ["id", "name", "kind", "target", "status"]);
    return;
  }

  const id = p.positional[2];
  if (sub === "get") {
    if (!id) throw new CliError("Usage: vigil monitors get <id>");
    printJson(await trpcQuery("monitors.get", { id }));
    return;
  }
  if (sub === "create") {
    const specPath = str(p.flags, "spec");
    let input: Record<string, unknown>;
    if (specPath) {
      input = readSpec(specPath) as Record<string, unknown>;
      if (typeof input["project_id"] === "string" && !UUID.test(input["project_id"] as string)) {
        input["project_id"] = await resolveProject(input["project_id"] as string);
      }
    } else {
      const projectRef = str(p.flags, "project");
      const name = str(p.flags, "name");
      const target = str(p.flags, "target");
      if (!projectRef || !name) {
        throw new CliError("Required: --project and --name (or use --spec). Run: vigil --help");
      }
      input = {
        project_id: await resolveProject(projectRef),
        name,
        kind: str(p.flags, "kind") ?? "http",
        target: target ?? "",
        method: str(p.flags, "method"),
        expected_status_codes: csv(p.flags, "expect-status")?.map(Number),
        expected_body_substr: str(p.flags, "expect-body"),
        dns_record_type: str(p.flags, "dns-type"),
        dns_expected_values: csv(p.flags, "dns-expect"),
        interval_seconds: num(p.flags, "interval"),
        timeout_ms: num(p.flags, "timeout"),
        regions: csv(p.flags, "regions"),
        schedule_expr: str(p.flags, "schedule"),
        schedule_tz: str(p.flags, "tz"),
        grace_seconds: num(p.flags, "grace"),
      };
      for (const k of Object.keys(input)) if (input[k] === undefined) delete input[k];
    }
    const row = (await trpcMutation("monitors.create", input)) as Record<string, unknown>;
    if (json) printJson(row);
    else say(`Created monitor "${row["name"]}" (${row["id"]})`);
    return;
  }
  if (sub === "update") {
    if (!id) throw new CliError("Usage: vigil monitors update <id> --spec <file|->");
    const specPath = str(p.flags, "spec");
    if (!specPath) throw new CliError("Usage: vigil monitors update <id> --spec <file|->");
    const body = readSpec(specPath) as Record<string, unknown>;
    printJson(await trpcMutation("monitors.update", { ...body, id }));
    return;
  }
  if (sub === "rm") {
    if (!id) throw new CliError("Usage: vigil monitors rm <id> --yes");
    if (!bool(p.flags, "yes")) {
      throw new CliError("Deleting removes the monitor and its history. Re-run with --yes to confirm.");
    }
    await trpcMutation("monitors.remove", { id });
    if (json) printJson({ removed: id });
    else say("Monitor deleted.");
    return;
  }
  if (sub === "pause" || sub === "resume") {
    if (!id) throw new CliError(`Usage: vigil monitors ${sub} <id>`);
    await trpcMutation("monitors.setPaused", { id, paused: sub === "pause" });
    if (json) printJson({ id, paused: sub === "pause" });
    else say(sub === "pause" ? "Monitor paused." : "Monitor resumed.");
    return;
  }
  if (sub === "check") {
    if (!id) throw new CliError("Usage: vigil monitors check <id>");
    const res = await trpcMutation("monitors.checkNow", { id });
    if (json) printJson(res ?? { queued: true });
    else say("Check queued.");
    return;
  }
  throw new CliError(`Unknown subcommand "monitors ${sub}". Run: vigil --help`);
}

async function channels(p: Parsed): Promise<void> {
  const sub = p.positional[1] ?? "list";
  if (sub === "list") {
    const rows = ((await trpcQuery("channels.list")) ?? []) as Record<string, unknown>[];
    if (bool(p.flags, "json")) printJson(rows);
    else table(rows, ["id", "name", "kind", "enabled"]);
    return;
  }
  return res.channelsExtra(p, sub);
}

function update(): Promise<void> {
  log(`Updating via ${INSTALL_URL}`);
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", `curl -fsSL ${INSTALL_URL} | sh`], { stdio: "inherit" });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new CliError("update failed"))));
    child.on("error", () => reject(new CliError(`update failed. Run: curl -fsSL ${INSTALL_URL} | sh`)));
  });
}

async function main(): Promise<void> {
  setNetObserver(netHooks);
  const p = parseArgs(process.argv.slice(2));
  const cmd = p.positional[0];

  if (!cmd || cmd === "help" || p.flags["help"] === true) {
    say(HELP);
    return;
  }
  switch (cmd) {
    case "login":
      return login(p);
    case "logout":
      await signOut();
      clearConfig();
      say("Logged out.");
      return;
    case "whoami":
      return whoami(p);
    case "projects":
      return projects(p);
    case "monitors":
      return monitors(p);
    case "channels":
      return channels(p);
    case "overview":
      return res.overview(p);
    case "plan":
      return res.plan(p);
    case "incidents":
      return res.incidents(p);
    case "status-pages":
      return res.statusPages(p);
    case "maintenance":
      return res.maintenance(p);
    case "bots":
      return res.bots(p);
    case "subscribers":
      return res.subscribers(p);
    case "logs":
      return res.logs(p);
    case "domains":
      return res.domains(p);
    case "email":
      return res.email(p);
    case "team":
      return res.team(p);
    case "billing":
      return res.billing(p);
    case "api":
      return res.apiCall(p);
    case "version":
      say(VERSION);
      return;
    case "update":
      return update();
    default:
      throw new CliError(`Unknown command "${cmd}". Run: vigil --help`);
  }
}

main().catch((err: unknown) => {
  const message = err instanceof CliError ? err.message : err instanceof Error ? err.message : String(err);
  log(`Error: ${message}`);
  process.exit(1);
});
