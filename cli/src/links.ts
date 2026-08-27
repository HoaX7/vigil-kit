import { CliError } from "./http.js";

export const DASHBOARD = "https://tryvigil.dev/dashboard";

export const DASH = {
  billing: `${DASHBOARD}/billing`,
  notifications: `${DASHBOARD}/notifications`,
  domains: `${DASHBOARD}/settings/domains`,
  statusPages: `${DASHBOARD}/status-pages`,
  team: `${DASHBOARD}/account`,
  monitors: `${DASHBOARD}/monitors`,
  email: `${DASHBOARD}/settings/email`,
} as const;

/**
 * The guardrail for actions the CLI deliberately does not perform: anything
 * destructive to customer facing surfaces or gated to admins is done in the
 * dashboard, where the role and a confirmation stand in the way.
 */
export function dashboardOnly(action: string, url: string): never {
  throw new CliError(`${action} is managed in the dashboard: ${url}`);
}
