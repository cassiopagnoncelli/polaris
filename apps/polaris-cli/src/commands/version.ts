import type { CommandContext, CommandDefinition } from "../command.js";
import { renderAccordingTo } from "../output.js";

/**
 * `polaris version` — prints CLI build metadata.
 *
 * Read-only, never touches the control-plane API. Exists in this task so the
 * shell can be verified end-to-end (argv parse, config load, logger, output
 * streams) without needing the API service from P6-000.
 *
 * Human form is two lines: the version on its own, then a `node ...` build
 * footer. JSON form returns the full `PackageMeta` so scripted runners can
 * grab the git SHA.
 */
export const versionCommand: CommandDefinition = {
  id: "version",
  mutates: false,
  register: (parent, deps) => {
    parent
      .command("version")
      .description("Print the polaris CLI version and build metadata.")
      .action(deps.runCommand({ id: "version", mutates: false }, runVersion));
  },
};

function runVersion(_args: unknown, ctx: CommandContext): undefined {
  const { meta } = ctx;
  const footer = [`node ${meta.nodeVersion}`];
  if (meta.gitSha) footer.push(`sha ${meta.gitSha}`);
  if (meta.buildTime) footer.push(`built ${meta.buildTime}`);
  const human = `polaris ${meta.version}\n${footer.join(" · ")}`;
  ctx.output.writeOut(
    renderAccordingTo(ctx.config.output, {
      human,
      json: {
        name: "polaris",
        version: meta.version,
        node: meta.nodeVersion,
        git_sha: meta.gitSha ?? null,
        build_time: meta.buildTime ?? null,
      },
    }),
  );
  return undefined;
}
