# Vigil CLI

Vigil uptime monitoring from the terminal. Create monitors, manage projects
and inspect alert channels without opening the dashboard. The CLI drives the
same API as the dashboard, so everything it creates shows up there.

## Install

```bash
curl -fsSL https://cli.tryvigil.dev | bash
```

Needs Node.js 18 or newer. Installs a single `vigil` command to
`/usr/local/bin` (if writable) or `~/.local/bin`. Set `VIGIL_INSTALL_DIR` to
choose another location. Update any time with `vigil update`.

## Sign in

```bash
vigil login
```

Prints a one time code and a URL. Open the URL, sign in to Vigil and approve
the code; the CLI picks the session up and stores it in
`~/.vigil/config.json` (permissions 0600). Sessions expire; run `vigil login`
again when a command says so.

## Commands

```
vigil login | logout | whoami
vigil overview | plan | billing
vigil projects list | create <name>
vigil monitors list | get | create | update | rm | pause | resume | check
vigil incidents list | get | ack | resolve | update
vigil channels list | catalog | create | test
vigil status-pages list | get | create | add-monitor
vigil maintenance list | get | create | cancel | complete
vigil bots list | get | shards
vigil domains list | add | assign | verify | rm
vigil subscribers | logs | email
vigil team members | invite <email>
vigil api <router.procedure> [--input <json|->]
vigil version | update
```

`vigil --help` documents every flag. Plan limits are enforced by the server
on every call; `vigil plan` shows what the current plan allows.

## For scripts and agents

- `--json` on any command prints machine readable JSON on stdout; logs go to
  stderr.
- `vigil monitors create --spec -` reads a full JSON monitor definition from
  stdin, mirroring the API's create input exactly.
- `VIGIL_TOKEN` and `VIGIL_API_URL` override the stored login, for CI and
  self hosted setups.

```bash
vigil monitors create --spec - --json <<'EOF'
{
  "project_id": "production",
  "name": "API health",
  "kind": "http",
  "target": "https://api.example.com/health",
  "expected_status_codes": [200],
  "interval_seconds": 60
}
EOF
```

Monitor kinds: `http`, `ssl`, `dns`, `tcp`, `udp`, `ping`, `push` (cron jobs
and heartbeats).

## Development

```bash
npm install
npm run typecheck
npm run build        # bundles src into dist/vigil.mjs
node dist/vigil.mjs --help
```

The published artifact is the single file `dist/vigil.mjs`, served from
https://cli.tryvigil.dev/vigil.mjs by the installer.
