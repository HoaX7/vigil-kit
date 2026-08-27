import { str, num, bool, type Parsed } from "./args.js";
import { CliError, trpcMutation, trpcQuery } from "./http.js";
import { printJson, say, table } from "./output.js";
import { readSpec, specOf } from "./spec.js";
import { progress, step, trackStep } from "./ui.js";

function need(p: Parsed, index: number, usage: string): string {
  const v = p.positional[index];
  if (!v) throw new CliError(`Usage: ${usage}`);
  return v;
}

export async function apiCall(p: Parsed): Promise<void> {
  const path = need(p, 1, "vigil api <router.procedure> [--input <json|->] [--mutation]");
  if (!/^[a-zA-Z]+\.[a-zA-Z]+$/.test(path)) {
    throw new CliError(`"${path}" is not a procedure path. Expected router.procedure, e.g. monitors.list`);
  }
  const rawInput = str(p.flags, "input");
  const input = rawInput === undefined ? undefined : rawInput === "-" ? readSpec("-") : (JSON.parse(rawInput) as unknown);

  if (bool(p.flags, "mutation")) {
    printJson(await trpcMutation(path, input));
    return;
  }
  try {
    printJson(await trpcQuery(path, input));
  } catch (err) {
    // A mutation called as a query answers METHOD_NOT_SUPPORTED; retry as the
    // caller obviously intended.
    if (err instanceof CliError && err.code === "METHOD_NOT_SUPPORTED") {
      printJson(await trpcMutation(path, input));
      return;
    }
    throw err;
  }
}

export async function plan(p: Parsed): Promise<void> {
  const [subscription, usage, formOptions] = await Promise.all([
    trpcQuery("billing.subscription").catch(() => null),
    trpcQuery("org.usage"),
    trpcQuery("monitors.formOptions").catch(() => null),
  ]);
  printJson({ subscription, usage, monitor_options: formOptions });
}

export async function overview(p: Parsed): Promise<void> {
  const [team, usage, monitors, incidents] = await Promise.all([
    trpcQuery("org.get"),
    trpcQuery("org.usage"),
    trpcQuery("monitors.list") as Promise<{ status?: string }[]>,
    trpcQuery("incidents.listByOrg", { status: "open" }).catch(() => []),
  ]);
  const byStatus: Record<string, number> = {};
  for (const m of monitors ?? []) byStatus[m.status ?? "unknown"] = (byStatus[m.status ?? "unknown"] ?? 0) + 1;
  printJson({
    team,
    usage,
    monitors: { total: (monitors ?? []).length, by_status: byStatus },
    open_incidents: incidents,
  });
}

export async function incidents(p: Parsed): Promise<void> {
  const sub = p.positional[1] ?? "list";
  const json = bool(p.flags, "json");
  if (sub === "list") {
    const status = str(p.flags, "status") as "open" | "resolved" | undefined;
    const rows = ((await trpcQuery("incidents.listByOrg", {
      ...(status ? { status } : {}),
      ...(num(p.flags, "limit") !== undefined ? { limit: num(p.flags, "limit") } : {}),
    })) ?? []) as Record<string, unknown>[];
    if (json) printJson(rows);
    else table(rows, ["id", "monitor_name", "status", "started_at", "resolved_at"]);
    return;
  }
  if (sub === "get") {
    printJson(await trpcQuery("incidents.get", { id: need(p, 2, "vigil incidents get <id>") }));
    return;
  }
  if (sub === "ack" || sub === "resolve") {
    const id = need(p, 2, `vigil incidents ${sub} <id>`);
    const res = await trpcMutation(sub === "ack" ? "incidents.acknowledge" : "incidents.resolve", { id });
    if (json) printJson(res ?? { ok: true });
    else say(sub === "ack" ? "Incident acknowledged." : "Incident resolved.");
    return;
  }
  if (sub === "update") {
    const id = need(p, 2, 'vigil incidents update <id> --message "text"');
    const message = str(p.flags, "message");
    if (!message) throw new CliError('Required: --message "text"');
    printJson(await trpcMutation("incidents.addUpdate", { id, message }));
    return;
  }
  throw new CliError(`Unknown subcommand "incidents ${sub}". Run: vigil --help`);
}

export async function statusPages(p: Parsed): Promise<void> {
  const sub = p.positional[1] ?? "list";
  const json = bool(p.flags, "json");
  if (sub === "list") {
    const rows = ((await trpcQuery("statusPages.list")) ?? []) as Record<string, unknown>[];
    if (json) printJson(rows);
    else table(rows, ["id", "slug", "title", "public"]);
    return;
  }
  if (sub === "get") {
    printJson(await trpcQuery("statusPages.get", { id: need(p, 2, "vigil status-pages get <id>") }));
    return;
  }
  if (sub === "create") {
    const specPath = str(p.flags, "spec");
    const input = specPath
      ? readSpec(specPath)
      : {
          project_id: str(p.flags, "project"),
          slug: str(p.flags, "slug"),
          title: str(p.flags, "title"),
          description: str(p.flags, "description"),
        };
    if (!input["project_id"] || !input["slug"] || !input["title"]) {
      throw new CliError("Required: --project <id> --slug <slug> --title <title> (or --spec). project_id must be the project id, see vigil projects list.");
    }
    for (const k of Object.keys(input)) if (input[k] === undefined) delete input[k];
    printJson(await trpcMutation("statusPages.create", input));
    return;
  }
  if (sub === "add-monitor") {
    const pageId = need(p, 2, "vigil status-pages add-monitor <page-id> <monitor-id>");
    const monitorId = need(p, 3, "vigil status-pages add-monitor <page-id> <monitor-id>");
    printJson(await trpcMutation("statusPages.addMonitor", { status_page_id: pageId, monitor_id: monitorId }));
    return;
  }
  throw new CliError(`Unknown subcommand "status-pages ${sub}". Run: vigil --help`);
}

export async function maintenance(p: Parsed): Promise<void> {
  const sub = p.positional[1] ?? "list";
  const json = bool(p.flags, "json");
  if (sub === "list") {
    const rows = ((await trpcQuery("maintenance.list")) ?? []) as Record<string, unknown>[];
    if (json) printJson(rows);
    else table(rows, ["id", "title", "starts_at", "ends_at", "recurrence"]);
    return;
  }
  if (sub === "get") {
    printJson(await trpcQuery("maintenance.get", { id: need(p, 2, "vigil maintenance get <id>") }));
    return;
  }
  if (sub === "create") {
    printJson(await trpcMutation("maintenance.create", specOf(p)));
    return;
  }
  if (sub === "cancel" || sub === "complete") {
    printJson(await trpcMutation(`maintenance.${sub}`, { id: need(p, 2, `vigil maintenance ${sub} <id>`) }));
    return;
  }
  throw new CliError(`Unknown subcommand "maintenance ${sub}". Run: vigil --help`);
}

export async function bots(p: Parsed): Promise<void> {
  const sub = p.positional[1] ?? "list";
  const json = bool(p.flags, "json");
  if (sub === "list") {
    const rows = ((await trpcQuery("bots.list")) ?? []) as Record<string, unknown>[];
    if (json) printJson(rows);
    else table(rows, ["id", "name", "status", "shard_count"]);
    return;
  }
  if (sub === "get") {
    printJson(await trpcQuery("bots.get", { id: need(p, 2, "vigil bots get <id>") }));
    return;
  }
  if (sub === "shards") {
    printJson(await trpcQuery("bots.shards", { id: need(p, 2, "vigil bots shards <id>") }));
    return;
  }
  throw new CliError(`Unknown subcommand "bots ${sub}". Run: vigil --help`);
}

interface DomainRow {
  id: string;
  hostname: string;
  status: string;
  error?: string | null;
  dns_records?: { type: string; name: string; value: string }[];
}

async function domainList(): Promise<DomainRow[]> {
  const res = (await trpcQuery("customDomains.list")) as { items?: DomainRow[] } | DomainRow[] | null;
  return Array.isArray(res) ? res : (res?.items ?? []);
}

function printDnsRecords(row: DomainRow): void {
  const records = row.dns_records ?? [];
  if (records.length === 0) return;
  say("Create these DNS records at your DNS provider:");
  table(
    records.map((r) => ({ type: r.type, name: r.name, value: r.value })),
    ["type", "name", "value"],
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function domains(p: Parsed): Promise<void> {
  const sub = p.positional[1] ?? "list";
  const json = bool(p.flags, "json");

  if (sub === "list") {
    const rows = await domainList();
    if (json) printJson(rows);
    else table(rows as unknown as Record<string, unknown>[], ["id", "hostname", "status"]);
    return;
  }
  if (sub === "add") {
    const hostname = need(p, 2, "vigil domains add <hostname> [--page <status-page-id>]");
    const row = (await step(`Adding ${hostname}…`, () =>
      trpcMutation("customDomains.add", { hostname }),
    )) as DomainRow;
    const pageId = str(p.flags, "page");
    if (pageId) {
      await step("Assigning status page…", () =>
        trpcMutation("customDomains.assign", { id: row.id, status_page_id: pageId }),
      );
    }
    const full = (await domainList()).find((d) => d.id === row.id) ?? row;
    if (json) {
      printJson(full);
      return;
    }
    say(`Added ${hostname} (${row.id}), status: ${full.status}`);
    printDnsRecords(full);
    say(`Once the records exist, run: vigil domains verify ${row.id}`);
    return;
  }
  if (sub === "assign") {
    const id = need(p, 2, "vigil domains assign <id> <status-page-id>");
    const pageId = need(p, 3, "vigil domains assign <id> <status-page-id>");
    printJson(await trpcMutation("customDomains.assign", { id, status_page_id: pageId }));
    return;
  }
  if (sub === "verify") {
    const id = need(p, 2, "vigil domains verify <id> [--timeout <seconds>]");
    const timeoutS = num(p.flags, "timeout") ?? 300;
    const deadline = Date.now() + timeoutS * 1000;

    const final = await trackStep("Checking DNS and certificate…", async () => {
      for (;;) {
        const row = (await trpcMutation("customDomains.refresh", { id })) as DomainRow;
        if (row.status === "active" || row.status === "failed") return row;
        if (Date.now() >= deadline) return row;
        progress.update(`Verifying ${row.hostname}… status: ${row.status} (DNS can take a few minutes)`);
        await sleep(10_000);
      }
    });

    if (json) {
      printJson(final);
      if (final.status !== "active") process.exitCode = 1;
      return;
    }
    if (final.status === "active") {
      say(`${final.hostname} is active and serving.`);
      return;
    }
    const row = (await domainList()).find((d) => d.id === id) ?? final;
    printDnsRecords(row);
    throw new CliError(
      final.status === "failed"
        ? `Verification failed: ${final.error ?? "check the DNS records above"}`
        : `Still ${final.status} after ${timeoutS}s. DNS may not have propagated yet; run the command again in a few minutes.`,
    );
  }
  if (sub === "rm") {
    const id = need(p, 2, "vigil domains rm <id> --yes");
    if (!bool(p.flags, "yes")) {
      throw new CliError("Removing a domain stops it serving the status page immediately. Re-run with --yes to confirm.");
    }
    await trpcMutation("customDomains.remove", { id });
    say("Domain removed.");
    return;
  }
  throw new CliError(`Unknown subcommand "domains ${sub}". Run: vigil --help`);
}

export async function email(p: Parsed): Promise<void> {
  printJson(await trpcQuery("emailSender.list"));
}

export async function team(p: Parsed): Promise<void> {
  const sub = p.positional[1] ?? "members";
  if (sub === "members") {
    printJson(await trpcQuery("team.members"));
    return;
  }
  if (sub === "invite") {
    const emailAddr = need(p, 2, "vigil team invite <email> [--role member|admin]");
    const role = str(p.flags, "role") ?? "member";
    printJson(await trpcMutation("team.invite", { email: emailAddr, role }));
    return;
  }
  throw new CliError(`Unknown subcommand "team ${sub}". Run: vigil --help`);
}

export async function billing(p: Parsed): Promise<void> {
  const [subscription, capabilities] = await Promise.all([
    trpcQuery("billing.subscription"),
    trpcQuery("billing.capabilities").catch(() => null),
  ]);
  printJson({ subscription, capabilities });
}

export async function logs(p: Parsed): Promise<void> {
  const sub = p.positional[1];
  if (sub === "detail") {
    const audience = need(p, 2, "vigil logs detail <alert|subscriber> <id>");
    const id = need(p, 3, "vigil logs detail <alert|subscriber> <id>");
    printJson(await trpcQuery("deliveryLog.detail", { audience, id }));
    return;
  }
  const input: Record<string, unknown> = {
    limit: num(p.flags, "limit") ?? 25,
    offset: num(p.flags, "offset") ?? 0,
  };
  const status = str(p.flags, "status");
  const audience = str(p.flags, "audience");
  if (status) input["status"] = status;
  if (audience) input["audience"] = audience;
  printJson(await trpcQuery("deliveryLog.list", input));
}

export async function subscribers(p: Parsed): Promise<void> {
  const input: Record<string, unknown> = {};
  const pageId = str(p.flags, "page-id");
  const status = str(p.flags, "status");
  if (pageId) input["status_page_id"] = pageId;
  if (status) input["status"] = status;
  const limit = num(p.flags, "limit");
  if (limit !== undefined) input["limit"] = limit;
  printJson(await trpcQuery("subscribers.page", Object.keys(input).length ? input : undefined));
}

export async function channelsExtra(p: Parsed, sub: string): Promise<void> {
  if (sub === "catalog") {
    printJson(await trpcQuery("channels.catalog"));
    return;
  }
  if (sub === "create") {
    printJson(await trpcMutation("channels.create", specOf(p)));
    return;
  }
  if (sub === "test") {
    const id = need(p, 2, "vigil channels test <id> [--event monitor_down|monitor_up|ssl_expiry]");
    printJson(await trpcMutation("channels.testSend", { id, event: str(p.flags, "event") ?? "monitor_down" }));
    return;
  }
  throw new CliError(`Unknown subcommand "channels ${sub}". Run: vigil --help`);
}
