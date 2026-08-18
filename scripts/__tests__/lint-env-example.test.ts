/**
 * The inverse of `lint-process-env`: a variable documented must be read.
 */

import { describe, expect, it } from "vitest";

import { documentedVariables, findUnreadVariables } from "../lint-env-example.mjs";

describe("documentedVariables", () => {
  it("reads assignments, not mentions in prose", () => {
    // A comment saying "see also POLARIS_X" documents a variable ABOUT
    // which something is said; what an operator copies is the assignment.
    const names = documentedVariables(
      ["# See also POLARIS_MENTIONED_ONLY", "POLARIS_REAL=1", "", "# POLARIS_COMMENTED=2"].join(
        "\n",
      ),
    );
    expect([...names]).toEqual(["POLARIS_REAL"]);
  });

  it("ignores blank lines and section rules", () => {
    expect([...documentedVariables("# ====\n\nPOLARIS_A=x\n")]).toEqual(["POLARIS_A"]);
  });
});

describe("the repository", () => {
  it("documents no variable that nothing reads", () => {
    // The gate. Eight `_CONCURRENCY` knobs and `POLARIS_GEOIP_DB_PATH`
    // were documented and read by nothing — an operator setting one gets
    // silence, and concludes the knob had no effect rather than that it
    // was never wired.
    expect(findUnreadVariables()).toEqual([]);
  });
});
