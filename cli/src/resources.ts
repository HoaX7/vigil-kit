import { str, num, bool, type Parsed } from "./args.js";
import { CliError, UsageError, trpcMutation, trpcQuery } from "./http.js";
import { autoTable, pagerLine, printJson, renderKV, say, table } from "./output.js";
import { readSpec, specOf } from "./spec.js";
import { progress, step, trackStep } from "./ui.js";
import { DASH, dashboardOnly } from "./links.js";

function need(p: Parsed, index: number, usage: string): string {
  const v = p.positional[index];
  if (!v) throw new UsageError(`Usage: ${usage}`);
  return v;
}

function out(p: Parsed, data: unknown, human: () => void): void {
  if (bool(p.flags, "json")) printJson(data);
  else human();
}

export async function plan(p: Parsed): Promise<void> {
  const [subscription, usage, formOptions] = await Promise.all([
    trpcQuery("billing.subscription").catch(() => null),
    trpcQuery("org.usage"),
    trpcQuery("monitors.formOptions").catch(() => null),
  ]);
  const data = { subscription, usage, monitor_options: formOptions };
  out(p, data, () => {
    const u = (usage ?? {}) as Record<string, unknown>;
    renderKV(u);
    const fo = (formOptions ?? {}) as { intervals?: number[] };
    if (fo.intervals) say(`allowed_intervals          ${fo.intervals.join(", ")}`);
  });
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
  const data = {
    team,
    usage,
    monitors: { total: (monitors ?? []).length, by_status: byStatus },
    open_incidents: incidents,
  };
  out(p, data, () => {
    const t = (team ?? {}) as { name?: string; plan?: string };
    const u = (usage ?? {}) as { active_monitors?: number; max_monitors?: number };
    say(`Team      ${t.name ?? ""} (${t.plan ?? ""} plan)`);
    say(`Monitors  ${u.active_monitors ?? (monitors ?? []).length}/${u.max_monitors ?? "?"} active — ${
      Object.entries(byStatus).map(([k, v]) => `${v} ${k}`).join(", ") || "none"
    }`);
    const open = (incidents ?? []) as Record<string, unknown>[];
    say(`Open incidents  ${open.length}`);
    if (open.length > 0) autoTable(open, ["id", "monitor_name", "started_at"]);
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
    const row = await trpcQuery("incidents.get", { id: need(p, 2, "vigil incidents get <id>") });
    out(p, row, () => renderKV(row));
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
    if (!message) throw new UsageError('Required: --message "text"');
    const row = await trpcMutation("incidents.addUpdate", { id, message });
    out(p, row, () => say("Update posted."));
    return;
  }
  throw new UsageError(`Unknown subcommand "incidents ${sub}". Run: vigil --help`);
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
    const row = await trpcQuery("statusPages.get", { id: need(p, 2, "vigil status-pages get <id>") });
    out(p, row, () => renderKV(row));
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
      throw new UsageError("Required: --project <id> --slug <slug> --title <title> (or --spec). project_id must be the project id, see vigil projects list.");
    }
    for (const k of Object.keys(input)) if (input[k] === undefined) delete input[k];
    const row = (await trpcMutation("statusPages.create", input)) as { id?: string; slug?: string };
    out(p, row, () => say(`Created status page "${input["title"]}" (${row.id ?? ""}) at https://tryvigil.dev/status/${row.slug ?? input["slug"]}`));
    return;
  }
  if (sub === "add-monitor") {
    const pageId = need(p, 2, "vigil status-pages add-monitor <page-id> <monitor-id>");
    const monitorId = need(p, 3, "vigil status-pages add-monitor <page-id> <monitor-id>");
    const added = await trpcMutation("statusPages.addMonitor", { status_page_id: pageId, monitor_id: monitorId });
    out(p, added ?? { ok: true }, () => say("Monitor added to the page."));
    return;
  }
  if (sub === "rm" || sub === "delete" || sub === "archive") {
    dashboardOnly("Archiving or deleting a status page", DASH.statusPages);
  }
  throw new UsageError(`Unknown subcommand "status-pages ${sub}". Run: vigil status-pages --help`);
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
    const row = await trpcQuery("maintenance.get", { id: need(p, 2, "vigil maintenance get <id>") });
    out(p, row, () => renderKV(row));
    return;
  }
  if (sub === "create") {
    const row = (await trpcMutation("maintenance.create", specOf(p))) as { id?: string; title?: string };
    out(p, row, () => say(`Maintenance window "${row.title ?? ""}" created (${row.id ?? ""}).`));
    return;
  }
  if (sub === "cancel" || sub === "complete") {
    const row = await trpcMutation(`maintenance.${sub}`, { id: need(p, 2, `vigil maintenance ${sub} <id>`) });
    out(p, row ?? { ok: true }, () => say(sub === "cancel" ? "Maintenance cancelled." : "Maintenance completed."));
    return;
  }
  throw new UsageError(`Unknown subcommand "maintenance ${sub}". Run: vigil --help`);
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
    const row = await trpcQuery("bots.get", { id: need(p, 2, "vigil bots get <id>") });
    out(p, row, () => renderKV(row));
    return;
  }
  if (sub === "shards") {
    const rows = await trpcQuery("bots.shards", { id: need(p, 2, "vigil bots shards <id>") });
    out(p, rows, () => autoTable((rows ?? []) as Record<string, unknown>[], ["id", "status", "latency_ms", "guilds", "last_ready_at"]));
    return;
  }
  throw new UsageError(`Unknown subcommand "bots ${sub}". Run: vigil --help`);
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
    const row = await trpcMutation("customDomains.assign", { id, status_page_id: pageId });
    out(p, row, () => say("Domain assigned to the status page."));
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
  if (sub === "rm" || sub === "remove") {
    dashboardOnly("Removing a custom domain", DASH.domains);
  }
  throw new UsageError(`Unknown subcommand "domains ${sub}". Run: vigil domains --help`);
}

export async function email(p: Parsed): Promise<void> {
  const res = (await trpcQuery("emailSender.list", { limit: 50, offset: 0 })) as
    | { items?: Record<string, unknown>[]; available?: boolean }
    | null;
  const rows = res?.items ?? [];
  out(p, res, () => {
    if (rows.length === 0) {
      say("No custom email senders. Alert and subscriber mail goes out from the default Vigil sender.");
      say(`Set up your own domain in the dashboard: ${DASH.email}`);
      return;
    }
    autoTable(rows, ["id", "provider", "from_address", "purposes", "verified_at", "last_error"]);
  });
}

export async function team(p: Parsed): Promise<void> {
  const sub = p.positional[1] ?? "members";
  if (sub === "members") {
    const res = (await trpcQuery("team.members")) as { members?: Record<string, unknown>[]; invitations?: Record<string, unknown>[] } | null;
    out(p, res, () => {
      autoTable(res?.members ?? [], ["id", "name", "email", "role"]);
      const invites = res?.invitations ?? [];
      if (invites.length > 0) {
        say("");
        say("Pending invitations:");
        autoTable(invites, ["email", "role", "status", "expiresAt"]);
      }
    });
    return;
  }
  if (sub === "invite") {
    const emailAddr = need(p, 2, "vigil team invite <email> [--role member|admin]");
    const role = str(p.flags, "role") ?? "member";
    const row = await trpcMutation("team.invite", { email: emailAddr, role });
    out(p, row, () => say(`Invited ${emailAddr} as ${role}.`));
    return;
  }
  if (sub === "remove" || sub === "role") {
    dashboardOnly("Changing or removing a member", DASH.team);
  }
  throw new UsageError(`Unknown subcommand "team ${sub}". Run: vigil team --help`);
}

interface TeamRow {
  id: string;
  slug?: string;
  name?: string;
  role?: string;
  suspended?: boolean;
}

async function teamList(): Promise<{ teams: TeamRow[]; activeId: string | null }> {
  const res = (await trpcQuery("team.list")) as { teams?: TeamRow[]; activeId?: string | null } | null;
  return { teams: res?.teams ?? [], activeId: res?.activeId ?? null };
}

export async function teams(p: Parsed): Promise<void> {
  const sub = p.positional[1] ?? "list";
  if (sub === "list") {
    const { teams: rows, activeId } = await teamList();
    if (bool(p.flags, "json")) {
      printJson(rows.map((t) => ({ ...t, active: t.id === activeId })));
      return;
    }
    table(
      rows.map((t) => ({ ...t, active: t.id === activeId ? "yes" : "" })),
      ["id", "slug", "name", "role", "active"],
    );
    return;
  }
  if (sub === "switch") {
    const ref = need(p, 2, "vigil teams switch <team-id|slug>");
    const { teams: rows } = await teamList();
    const hit = rows.find((r) => r.id === ref || r.slug === ref || r.name === ref);
    if (!hit) throw new CliError(`No team "${ref}". Run: vigil teams`);
    await trpcMutation("team.setActive", { teamId: hit.id });
    say(`Active team is now ${hit.name ?? hit.slug ?? hit.id}.`);
    return;
  }
  throw new UsageError(`Unknown subcommand "teams ${sub}". Run: vigil teams --help`);
}

export async function billing(p: Parsed): Promise<void> {
  const [subscription, capabilities] = await Promise.all([
    trpcQuery("billing.subscription"),
    trpcQuery("billing.capabilities").catch(() => null),
  ]);
  const data = { subscription, capabilities, manage_url: DASH.billing };
  out(p, data, () => {
    const sub = (subscription ?? {}) as {
      plan?: string;
      package_id?: string;
      package?: { priceCentsMonthly?: number; includedSeats?: number };
      seats?: { members?: number; memberSeats?: number; notifyMembers?: number; notifySeats?: number };
      subscribers?: number;
      lastPayment?: { amount?: number; currency?: string; payment_method?: string; created_at?: string };
    };
    say(`Plan          ${sub.plan ?? "free"} (${sub.package_id ?? ""})`);
    if (sub.package?.priceCentsMonthly !== undefined) {
      say(`Price         $${(sub.package.priceCentsMonthly / 100).toFixed(2)} per month`);
    }
    if (sub.seats) {
      say(`Seats         ${sub.seats.members ?? 0}/${sub.seats.memberSeats ?? 0} members, ${sub.seats.notifyMembers ?? 0}/${sub.seats.notifySeats ?? 0} alert only`);
    }
    if (sub.subscribers !== undefined) say(`Subscribers   ${sub.subscribers}`);
    const lp = sub.lastPayment;
    if (lp?.amount !== undefined) {
      say(`Last payment  $${(lp.amount / 100).toFixed(2)} ${lp.currency ?? ""} via ${lp.payment_method ?? ""} on ${(lp.created_at ?? "").slice(0, 10)}`);
    }
    say("");
    say(`Payment methods, plan changes and invoices: ${DASH.billing}`);
  });
}

export async function logs(p: Parsed): Promise<void> {
  const sub = p.positional[1];
  if (sub === "detail") {
    const audience = need(p, 2, "vigil logs detail <alert|subscriber> <id>");
    const id = need(p, 3, "vigil logs detail <alert|subscriber> <id>");
    const row = await trpcQuery("deliveryLog.detail", { audience, id });
    out(p, row, () => renderKV(row));
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
  const res = (await trpcQuery("deliveryLog.list", input)) as { items?: Record<string, unknown>[]; total?: number } | null;
  out(p, res, () => {
    const items = res?.items ?? [];
    autoTable(items, ["id", "audience", "kind", "status", "subject", "created_at"]);
    const pager = pagerLine((input["offset"] as number) ?? 0, items.length, res?.total ?? items.length);
    if (pager) say(pager);
  });
}

export async function subscribers(p: Parsed): Promise<void> {
  const input: Record<string, unknown> = {};
  const pageId = str(p.flags, "page-id");
  const status = str(p.flags, "status");
  if (pageId) input["status_page_id"] = pageId;
  if (status) input["status"] = status;
  const limit = num(p.flags, "limit");
  if (limit !== undefined) input["limit"] = limit;
  const offset = num(p.flags, "offset") ?? 0;
  input["offset"] = offset;
  const res = (await trpcQuery("subscribers.page", Object.keys(input).length ? input : undefined)) as
    | { items?: Record<string, unknown>[]; total?: number }
    | null;
  out(p, res, () => {
    const items = res?.items ?? [];
    autoTable(items, ["id", "kind", "destination", "status", "created_at"]);
    const pager = pagerLine(offset, items.length, res?.total ?? items.length);
    if (pager) say(pager);
  });
}

export async function channelsExtra(p: Parsed, sub: string): Promise<void> {
  if (sub === "catalog") {
    const cat = (await trpcQuery("channels.catalog")) as { integrations?: Record<string, unknown>[] } | null;
    out(p, cat, () => autoTable(cat?.integrations ?? [], ["kind", "label", "group", "available", "coming_soon"]));
    return;
  }
  if (sub === "create") {
    const row = (await trpcMutation("channels.create", specOf(p))) as { id?: string; name?: string };
    out(p, row, () => say(`Channel "${row.name ?? ""}" created (${row.id ?? ""}). Try it: vigil channels test ${row.id ?? "<id>"}`));
    return;
  }
  if (sub === "test") {
    const id = need(p, 2, "vigil channels test <id> [--event monitor_down|monitor_up|ssl_expiry]");
    const res = await trpcMutation("channels.testSend", { id, event: str(p.flags, "event") ?? "monitor_down" });
    out(p, res ?? { ok: true }, () => say("Test alert sent."));
    return;
  }
  if (sub === "rm" || sub === "delete") {
    dashboardOnly("Deleting a channel", DASH.notifications);
  }
  throw new UsageError(`Unknown subcommand "channels ${sub}". Run: vigil channels --help`);
}
