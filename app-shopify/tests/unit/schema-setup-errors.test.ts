import { describe, expect, it } from "vitest";
import { assertSchemaMutationSucceeded } from "../../scripts/schema-setup-errors";

describe("assertSchemaMutationSucceeded", () => {
  it("accepts a created definition only when its response node exists", () => {
    expect(assertSchemaMutationSucceeded("Create schema", [], { id: "definition-1" })).toBe("created");
    expect(() => assertSchemaMutationSucceeded("Create schema", [], null)).toThrow("missing created definition");
  });

  it("rejects an absent mutation payload", () => {
    expect(() => assertSchemaMutationSucceeded("Create schema", undefined, undefined)).toThrow("missing mutation payload");
  });

  it("accepts duplicate-only responses without a created node", () => {
    expect(assertSchemaMutationSucceeded("Create schema", [{ field: null, message: "Definition exists", code: "TAKEN" }], null)).toBe("already_exists");
  });

  it("rejects a validation error even when a duplicate error is also present", () => {
    expect(() => assertSchemaMutationSucceeded("Create schema", [
      { field: ["type"], message: "Type already exists" },
      { field: ["access"], message: "Access denied" },
    ], null)).toThrow("Access denied");
  });
});
