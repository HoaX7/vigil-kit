# Vigil Skills

Agent skills that teach Claude Code, Cursor, Windsurf and other compatible
agents how to set up Vigil monitoring in your codebase.

## Install

```bash
npx skills add HoaX7/vigil-sdk
```

Or copy a skill's folder into your project's `.claude/skills/` directory.

## Skills

| Skill | Description |
| --- | --- |
| [`discord-bot-monitoring`](./skills/discord-bot-monitoring) | Add per-shard Vigil monitoring to a Discord bot. Detects the language and library, installs the right SDK or wires the REST protocol, and verifies shards report. |
| [`uptime-monitoring`](./skills/uptime-monitoring) | Monitor websites, APIs, SSL certificates, DNS records, ports and cron jobs with the Vigil CLI. Installs the CLI, signs the user in through the browser, creates the monitors. |

## For agents

[`AGENTS.md`](./AGENTS.md) and [`CLAUDE.md`](./CLAUDE.md) index these skills:
which one matches a given ask, how to detect the user's stack, and the
conventions every integration must hold.

## What is Vigil

[Vigil](https://tryvigil.dev) is uptime monitoring with hosted status pages:
websites, APIs, SSL certificates, DNS records, ports, cron jobs and Discord
bots, with alerting over email, Discord, Slack, Telegram and webhooks.
