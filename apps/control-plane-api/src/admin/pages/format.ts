/**
 * Display formatting shared by the pages.
 *
 * Timestamps render in UTC, always, with the zone spelled out. Polaris stores
 * everything in UTC (`docs/instructions/claude.md` "Engineering Defaults"),
 * and an operator comparing a page against `polaris audit list` or a Grafana
 * panel should not have to work out whose local time they are looking at.
 */

/** `2026-08-11 07:42:19Z`, or an em dash for null. */
export function formatInstant(value: Date | string | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return `${date.toISOString().slice(0, 19).replace("T", " ")}Z`;
}

/** Date only — for grouping columns where the time adds noise. */
export function formatDate(value: Date | string | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toISOString().slice(0, 10);
}

/** `yes` / `no`, so a boolean column reads at a glance. */
export function formatBool(value: boolean): string {
  return value ? "yes" : "no";
}
