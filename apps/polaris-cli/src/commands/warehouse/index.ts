/**
 * `polaris warehouse` — scheduled loads out of ClickHouse.
 *
 * Exports only. Nothing here reads a warehouse back into Polaris: that
 * is the reverse-ETL runner's job [[XTSWPW63]], and it goes through the
 * ingester rather than around it.
 */

import type { CommandDefinition } from "../../command.js";
import { warehouseExportCommand } from "./export.js";

export const warehouseCommand: CommandDefinition = {
  id: "warehouse",
  mutates: false,
  register: (parent, deps) => {
    const group = parent
      .command("warehouse")
      .description("Warehouse loads: day-partitioned Parquet exports from ClickHouse.");
    warehouseExportCommand.register(group, deps);
  },
};

export { buildWarehouseExportRunner, warehouseExportCommand } from "./export.js";
