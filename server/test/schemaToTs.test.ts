import { describe, expect, it } from "vitest";
import { schemaToTs } from "../src/lib/schemaToTs.js";

/** Most cases only care about the rendered type. */
function ts(schema: unknown, defs?: Record<string, unknown>): string {
  return schemaToTs(schema, defs).type;
}

describe("schemaToTs — objects", () => {
  it("marks properties outside `required` optional", () => {
    expect(
      ts({
        type: "object",
        properties: { to: { type: "array", items: { type: "string" } }, subject: { type: "string" }, cc: { type: "array", items: { type: "string" } } },
        required: ["to", "subject"],
      }),
    ).toBe("{ to: string[]; subject: string; cc?: string[] }");
  });

  it("nests objects inline", () => {
    expect(
      ts({
        type: "object",
        properties: {
          user: {
            type: "object",
            properties: { id: { type: "integer" }, name: { type: "string" } },
            required: ["id"],
          },
        },
        required: ["user"],
      }),
    ).toBe("{ user: { id: number; name?: string } }");
  });

  it("quotes property names that are not TS identifiers", () => {
    expect(
      ts({
        type: "object",
        properties: { "content-type": { type: "string" }, "2fa": { type: "boolean" }, ok: { type: "string" } },
        required: ["content-type", "2fa", "ok"],
      }),
    ).toBe('{ "content-type": string; "2fa": boolean; ok: string }');
  });

  it("infers an object from `properties` alone (no `type`)", () => {
    expect(ts({ properties: { a: { type: "string" } }, required: ["a"] })).toBe("{ a: string }");
  });
});

describe("schemaToTs — additionalProperties", () => {
  it("renders a schema value as an index signature", () => {
    expect(ts({ type: "object", additionalProperties: { type: "number" } })).toBe("Record<string, number>");
  });

  it("intersects declared properties with the index signature", () => {
    expect(
      ts({
        type: "object",
        properties: { a: { type: "string" } },
        required: ["a"],
        additionalProperties: { type: "number" },
      }),
    ).toBe("{ a: string } & Record<string, number>");
  });

  it("treats `true` and a missing value as an open bag when nothing is declared", () => {
    expect(ts({ type: "object", additionalProperties: true })).toBe("Record<string, unknown>");
    expect(ts({ type: "object" })).toBe("Record<string, unknown>");
  });

  it("keeps `true` from polluting a declared shape", () => {
    expect(ts({ type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: true })).toBe(
      "{ a: string }",
    );
  });

  it("renders a closed empty object as Record<string, never>", () => {
    expect(ts({ type: "object", additionalProperties: false })).toBe("Record<string, never>");
  });
});

describe("schemaToTs — primitives, enums, consts", () => {
  it("maps integer to number", () => {
    expect(ts({ type: "integer" })).toBe("number");
  });

  it("renders string enums as quoted unions", () => {
    expect(ts({ type: "string", enum: ["a", "b"] })).toBe('"a" | "b"');
  });

  it("leaves numeric and mixed enum members unquoted where appropriate", () => {
    expect(ts({ enum: [1, 2, "three", true, null] })).toBe('1 | 2 | "three" | true | null');
  });

  it("renders const as a single literal", () => {
    expect(ts({ const: "fixed" })).toBe('"fixed"');
    expect(ts({ const: 42 })).toBe("42");
  });

  it("renders `type: [\"string\", \"null\"]` as a nullable union", () => {
    expect(ts({ type: ["string", "null"] })).toBe("string | null");
    expect(ts({ type: ["string", "number", "null"] })).toBe("string | number | null");
  });
});

describe("schemaToTs — arrays", () => {
  it("renders arrays of objects", () => {
    expect(
      ts({
        type: "array",
        items: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      }),
    ).toBe("{ id: string }[]");
  });

  it("parenthesises union element types", () => {
    expect(ts({ type: "array", items: { enum: ["a", "b"] } })).toBe('("a" | "b")[]');
    expect(ts({ type: "array", items: { type: ["string", "null"] } })).toBe("(string | null)[]");
  });

  it("does not parenthesise a union nested inside an object element", () => {
    expect(ts({ type: "array", items: { type: "object", properties: { a: { type: ["string", "null"] } } } })).toBe(
      "{ a?: string | null }[]",
    );
  });

  it("renders tuples from `items` arrays and `prefixItems`", () => {
    expect(ts({ type: "array", items: [{ type: "string" }, { type: "number" }] })).toBe("[string, number]");
    expect(ts({ type: "array", prefixItems: [{ type: "boolean" }, { enum: ["x"] }] })).toBe('[boolean, "x"]');
  });

  it("falls back to unknown[] with no items", () => {
    expect(ts({ type: "array" })).toBe("unknown[]");
  });
});

describe("schemaToTs — combinators", () => {
  it("renders anyOf and oneOf as unions", () => {
    expect(ts({ anyOf: [{ type: "string" }, { type: "number" }] })).toBe("string | number");
    expect(ts({ oneOf: [{ type: "string" }, { type: "null" }] })).toBe("string | null");
  });

  it("dedupes union members", () => {
    expect(ts({ anyOf: [{ type: "string" }, { type: "string" }] })).toBe("string");
  });

  it("renders allOf as an intersection", () => {
    expect(
      ts({
        allOf: [
          { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
          { type: "object", properties: { b: { type: "number" } }, required: ["b"] },
        ],
      }),
    ).toBe("{ a: string } & { b: number }");
  });

  it("collapses a single allOf member and dedupes identical ones", () => {
    expect(ts({ allOf: [{ type: "string" }] })).toBe("string");
    expect(ts({ allOf: [{ type: "string" }, { type: "string" }] })).toBe("string");
  });
});

describe("schemaToTs — $ref and definitions", () => {
  it("emits a bare name and renders only referenced defs", () => {
    const result = schemaToTs({
      type: "object",
      properties: { node: { $ref: "#/$defs/Node" } },
      required: ["node"],
      $defs: {
        Node: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        Unused: { type: "object", properties: { nope: { type: "string" } } },
      },
    });
    expect(result.type).toBe("{ node: Node }");
    expect(result.definitions).toEqual({ Node: "{ id: string }" });
  });

  it("honours legacy `definitions` and a caller-supplied defs map", () => {
    expect(
      schemaToTs({ $ref: "#/definitions/Id", definitions: { Id: { type: "string" } } }),
    ).toEqual({ type: "Id", definitions: { Id: "string" } });

    expect(schemaToTs({ $ref: "#/$defs/Id" }, { Id: { type: "number" } })).toEqual({
      type: "Id",
      definitions: { Id: "number" },
    });
  });

  it("terminates on a cyclic ref pair and emits both definitions", () => {
    const result = schemaToTs({
      $ref: "#/$defs/A",
      $defs: {
        A: { type: "object", properties: { b: { $ref: "#/$defs/B" } }, required: ["b"] },
        B: { type: "object", properties: { a: { $ref: "#/$defs/A" } } },
      },
    });
    expect(result.type).toBe("A");
    expect(result.definitions).toEqual({ A: "{ b: B }", B: "{ a?: A }" });
  });

  it("degrades unresolvable refs to unknown", () => {
    expect(ts({ $ref: "#/$defs/Missing" })).toBe("unknown");
    expect(ts({ $ref: "https://example.com/schema.json" })).toBe("unknown");
    expect(schemaToTs({ $ref: "#/$defs/Missing" }).definitions).toEqual({});
  });
});

describe("schemaToTs — fallbacks and bad input", () => {
  it("renders unrepresentable or empty schemas as unknown", () => {
    expect(ts({})).toBe("unknown");
    expect(ts(true)).toBe("unknown");
    expect(ts({ type: "widget" })).toBe("unknown");
    expect(ts({ "x-vendor-thing": 1 })).toBe("unknown");
  });

  it("throws on input that is not a schema at all, so the caller can fall back to raw JSON Schema", () => {
    expect(() => schemaToTs(null)).toThrow();
    expect(() => schemaToTs("x")).toThrow();
    expect(() => schemaToTs(undefined)).toThrow();
    expect(() => schemaToTs(42)).toThrow();
    expect(() => schemaToTs([{ type: "string" }])).toThrow();
  });
});

describe("schemaToTs — sibling keywords", () => {
  const base = { Base: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } };

  it("keeps the schema's own shape alongside an allOf $ref", () => {
    const result = schemaToTs({
      type: "object",
      allOf: [{ $ref: "#/$defs/Base" }],
      properties: { body: { type: "string" } },
      required: ["body"],
      $defs: base,
    });
    expect(result.type).toBe("Base & { body: string }");
    expect(result.definitions).toEqual({ Base: "{ id: string }" });
  });

  it("keeps the schema's own shape alongside a direct $ref", () => {
    expect(ts({ $ref: "#/$defs/Base", properties: { body: { type: "string" } }, required: ["body"] }, base)).toBe(
      "Base & { body: string }",
    );
  });

  it("parenthesises a union sibling inside the intersection", () => {
    expect(
      ts({
        properties: { kind: { type: "string" } },
        required: ["kind"],
        anyOf: [
          { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
          { type: "object", properties: { b: { type: "string" } }, required: ["b"] },
        ],
      }),
    ).toBe("({ a: string } | { b: string }) & { kind: string }");
  });

  it("drops a part that says nothing once a real one is present", () => {
    // `type: "object"` with nothing declared only means "an object", which the ref already implies.
    expect(ts({ type: "object", allOf: [{ $ref: "#/$defs/Base" }] }, base)).toBe("Base");
    expect(ts({ allOf: [{ $ref: "#/$defs/Missing" }], type: "string" })).toBe("string");
  });
});

describe("schemaToTs — definition names", () => {
  it("emits definitions named after Object.prototype members", () => {
    const result = schemaToTs({
      type: "object",
      properties: { c: { $ref: "#/$defs/constructor" }, p: { $ref: "#/$defs/__proto__" } },
      required: ["c", "p"],
      // Computed so it becomes an own property rather than the literal's prototype setter.
      $defs: { constructor: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }, ["__proto__"]: { type: "string" } },
    });

    expect(result.type).toBe("{ c: constructor; p: __proto__ }");
    expect(Object.keys(result.definitions).sort()).toEqual(["__proto__", "constructor"]);
    expect(result.definitions["constructor"]).toBe("{ id: string }");
    expect(result.definitions["__proto__"]).toBe("string");
    expect(JSON.stringify(result.definitions)).toBe('{"constructor":"{ id: string }","__proto__":"string"}');
  });

  it("suffixes names that sanitize onto an already-claimed one", () => {
    const result = schemaToTs({
      type: "object",
      properties: { first: { $ref: "#/$defs/a-b" }, second: { $ref: "#/$defs/a_b" } },
      required: ["first", "second"],
      $defs: { "a-b": { type: "string" }, a_b: { type: "number" } },
    });
    expect(result.type).toBe("{ first: a_b; second: a_b_2 }");
    expect(result.definitions).toEqual({ a_b: "string", a_b_2: "number" });
  });
});

describe("schemaToTs — the false schema", () => {
  it("renders as never, at the top level and nested", () => {
    expect(ts(false)).toBe("never");
    expect(ts({ type: "object", properties: { nope: false }, required: ["nope"] })).toBe("{ nope: never }");
    expect(ts({ type: "array", items: false })).toBe("never[]");
  });
});

describe("schemaToTs — tuple rest elements", () => {
  it("renders a typed tail after the fixed head", () => {
    expect(ts({ type: "array", prefixItems: [{ type: "string" }], items: { type: "number" } })).toBe(
      "[string, ...number[]]",
    );
    expect(ts({ type: "array", items: [{ type: "string" }], additionalItems: { enum: ["a", "b"] } })).toBe(
      '[string, ...("a" | "b")[]]',
    );
  });

  it("keeps the tuple closed when no tail is allowed", () => {
    expect(ts({ type: "array", prefixItems: [{ type: "string" }], items: false })).toBe("[string]");
    expect(ts({ type: "array", items: [{ type: "string" }], additionalItems: false })).toBe("[string]");
    expect(ts({ type: "array", prefixItems: [{ type: "string" }, { type: "number" }] })).toBe("[string, number]");
  });
});

describe("schemaToTs — real-world schema", () => {
  // Modelled on GitHub MCP's create_issue: descriptions everywhere, which is exactly the
  // token weight the compact rendering is meant to shed.
  const createIssue = {
    type: "object",
    properties: {
      owner: { type: "string", description: "Repository owner" },
      repo: { type: "string", description: "Repository name" },
      title: { type: "string", description: "Issue title" },
      body: { type: "string", description: "Issue body content" },
      assignees: { type: "array", items: { type: "string" }, description: "Usernames to assign" },
      labels: { type: "array", items: { type: "string" }, description: "Labels to apply" },
      milestone: { type: "integer", description: "Milestone number" },
      state: { type: "string", enum: ["open", "closed"], description: "Issue state" },
    },
    required: ["owner", "repo", "title"],
  };

  it("renders the exact compact type", () => {
    expect(ts(createIssue)).toBe(
      '{ owner: string; repo: string; title: string; body?: string; assignees?: string[]; labels?: string[]; milestone?: number; state?: "open" | "closed" }',
    );
  });

  it("is at least 60% smaller than the raw JSON Schema", () => {
    const raw = JSON.stringify(createIssue).length;
    const compact = ts(createIssue).length;
    expect(compact / raw).toBeLessThanOrEqual(0.4);
  });
});
