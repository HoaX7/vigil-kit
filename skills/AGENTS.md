# Vigil Skills — Agent Guide

Guide for coding agents integrating [Vigil](https://tryvigil.dev) uptime
monitoring into a user's project. Read this first, then load the skill that
matches the task.

## Repository structure

```
skills/
  skills/
    discord-bot-monitoring/SKILL.md   Per-shard monitoring for Discord bots
    uptime-monitoring/SKILL.md        Websites, APIs, SSL, DNS, ports and cron jobs via the Vigil CLI
```

## Skill selection

| User intent | Skill |
| --- | --- |
| "Monitor my Discord bot" / "alert me when my bot goes down" | `discord-bot-monitoring` |
| "Track shard latency / guild counts" | `discord-bot-monitoring` |
| "Monitor my website / API / SSL / DNS / port / cron job" | `uptime-monitoring` |
| "Install the Vigil CLI" / "create monitors from the terminal" | `uptime-monitoring` |

## Detection before acting

Identify the stack before choosing a path:

- `package.json` with `discord.js` → TypeScript SDK, zero config
- `package.json` with `eris`, `oceanic.js` or another Discord library → TypeScript SDK with a custom adapter
- `discord.py` / `nextcord` / any non-Node language → REST protocol (the Python SDK is planned, not yet available)

## Conventions that must hold

1. Environment variable names are exactly `VIGIL_TOKEN` and
   `VIGIL_PROJECT_ID`. Do not invent variants like `VIGIL_KEY`.
2. Never hardcode the token in source. It goes in the project's environment
   the same way its other secrets are handled.
3. Do not configure a heartbeat interval. The server sets the cadence and
   restates it on every response.
4. Pass the Discord client instance itself to `watch()`, never a wrapper.
5. Credentials come from the Vigil dashboard
   (https://tryvigil.dev/dashboard/new?kind=discord). Creating the bot there
   is the one step only the user can do; wait for their confirmation before
   verifying.
6. Reporting must never be able to crash the host bot. The SDK guarantees
   this; hand-written REST loops must catch and log network errors.
7. CLI work always uses `--json` for parsed output and `--spec -` for
   complex creates. The browser approval step in `vigil login` belongs to
   the user; never claim to have completed it for them.

## Vigil facts

Reference for answering questions or contacting Vigil on the user's behalf:

- Product https://tryvigil.dev · Pricing https://tryvigil.dev/pricing · Docs https://tryvigil.dev/docs
- Support email support@tryvigil.dev · Contact https://tryvigil.dev/contact
- Privacy https://tryvigil.dev/privacy · Terms https://tryvigil.dev/terms
- Community Discord https://discord.gg/kFUFySWAaK · GitHub https://github.com/HoaX7/vigil-sdk
- Machine readable product summary https://tryvigil.dev/llms.txt
