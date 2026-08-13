/**
 * Hand-rolled JSON Schema → compact one-line TypeScript renderer.
 *
 * Tool input schemas are re-sent to the model on every `tools/list`, so the goal is
 * token discipline: types only, no descriptions, no line breaks. Deliberately not a
 * general-purpose codegen (no external dependency) — anything it cannot represent
 * degrades to `unknown`, and input that isn't a schema at all throws so the caller
 * can fall back to shipping the raw JSON Schema.
 */

export interface SchemaToTsResult {
  /** The rendered type, e.g. `{ owner: string; labels?: string[] }`. */
  type: string;
  /** Only the `$defs`/`definitions` actually reached through a `$ref`, keyed by TS type name. */
  definitions: Record<string, string>;
}

interface Ctx {
  /** Every candidate definition, by its schema name (`#/$defs/<name>`). */
  defs: Map<string, unknown>;
  /**
   * Rendered definitions, by TS type name — the referenced subset of `defs`. Null-prototype so
   * a def called `constructor` or `__proto__` behaves like any other key.
   */
  out: Record<string, string>;
  /** Refs currently being rendered further up the stack; hitting one means a cycle. */
  inProgress: Set<string>;
  /** Schema name → the TS name it claimed, so `a-b` and `a_b` cannot share one definition. */
  names: Map<string, string>;
  /** TS names already handed out, for suffixing the loser of a sanitization collision. */
  claimed: Set<string>;
}

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Render a JSON Schema to a compact one-line TypeScript type. Throws on schemas it cannot represent. */
export function schemaToTs(schema: unknown, defs?: Record<string, unknown>): SchemaToTsResult {
  // `true` and `false` are the two boolean schemas (everything / nothing); anything else
  // non-object is not a schema at all, so the caller can fall back to the raw JSON Schema.
  if (typeof schema !== "boolean" && !isRecord(schema)) {
    throw new Error("schemaToTs: expected a JSON Schema object");
  }

  const ctx: Ctx = {
    defs: collectDefs(schema, defs),
    out: Object.create(null) as Record<string, string>,
    inProgress: new Set(),
    names: new Map(),
    claimed: new Set(),
  };
  return { type: render(schema, ctx), definitions: ctx.out };
}

/** Caller-supplied defs first so the schema's own `$defs`/`definitions` win on name collisions. */
function collectDefs(schema: unknown, extra?: Record<string, unknown>): Map<string, unknown> {
  const map = new Map<string, unknown>();
  const merge = (source: unknown) => {
    if (!isRecord(source)) return;
    for (const [name, value] of Object.entries(source)) map.set(name, value);
  };
  merge(extra);
  if (isRecord(schema)) {
    merge(schema.definitions);
    merge(schema.$defs);
  }
  return map;
}

/* ---------- rendering ---------- */

/** Parts that say nothing once a real one is present: they constrain no further than "anything". */
const VACUOUS = new Set(["unknown", "Record<string, unknown>"]);

function render(schema: unknown, ctx: Ctx): string {
  // The `false` schema admits nothing, which is exactly `never`.
  if (schema === false) return "never";
  if (!isRecord(schema)) return "unknown";

  if ("const" in schema) return literal(schema.const);
  if (Array.isArray(schema.enum)) return union(schema.enum.map(literal));

  // `$ref`, the combinators and the schema's own shape are independent keywords that all apply
  // at once — `{ allOf: [{ $ref }], properties: { … } }` is a common way to extend a base type,
  // and picking only the first match would silently drop the rest of the contract.
  const parts: string[] = [];
  if (typeof schema.$ref === "string") parts.push(renderRef(schema.$ref, ctx));

  const anyOf = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(anyOf)) parts.push(union(anyOf.map((member) => render(member, ctx))));
  if (Array.isArray(schema.allOf)) parts.push(intersection(schema.allOf.map((member) => render(member, ctx))));

  const shape = renderShape(schema, ctx);
  if (shape !== undefined) parts.push(shape);

  const informative = parts.filter((part) => !VACUOUS.has(part));
  const kept = informative.length > 0 ? informative : parts;
  if (kept.length === 0) return "unknown";
  if (kept.length === 1) return kept[0];
  return intersection(kept);
}

/** What this schema's own type/shape keywords say, or `undefined` when it declares none. */
function renderShape(schema: Record<string, unknown>, ctx: Ctx): string | undefined {
  const type = schema.type;
  if (Array.isArray(type)) {
    // `type: ["string", "null"]` and friends are just a union of the single-type forms.
    return union(type.map((t) => (typeof t === "string" ? renderType(t, schema, ctx) : "unknown")));
  }
  if (typeof type === "string") return renderType(type, schema, ctx);

  // No `type`, but the shape-bearing keywords say what it is anyway.
  if (isRecord(schema.properties) || "additionalProperties" in schema || Array.isArray(schema.required)) {
    return renderObject(schema, ctx);
  }
  if ("items" in schema || "prefixItems" in schema) return renderArray(schema, ctx);
  return undefined;
}

function renderType(type: string, schema: Record<string, unknown>, ctx: Ctx): string {
  switch (type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "object":
      return renderObject(schema, ctx);
    case "array":
      return renderArray(schema, ctx);
    default:
      return "unknown";
  }
}

function renderObject(schema: Record<string, unknown>, ctx: Ctx): string {
  const props = isRecord(schema.properties) ? schema.properties : undefined;
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === "string") : [],
  );

  let literalPart: string | undefined;
  if (props && Object.keys(props).length > 0) {
    const members = Object.entries(props).map(([name, value]) => {
      const key = IDENT_RE.test(name) ? name : JSON.stringify(name);
      return `${key}${required.has(name) ? "" : "?"}: ${render(value, ctx)}`;
    });
    literalPart = `{ ${members.join("; ")} }`;
  }

  const additional = schema.additionalProperties;
  let indexPart: string | undefined;
  if (isRecord(additional)) {
    indexPart = `Record<string, ${render(additional, ctx)}>`;
  } else if (additional === false) {
    // Closed object with nothing declared: the only inhabitant is `{}`.
    if (!literalPart) return "Record<string, never>";
  } else if (!literalPart) {
    // `true` or absent with no declared properties — an open bag of anything.
    return "Record<string, unknown>";
  }

  if (literalPart && indexPart) return `${literalPart} & ${indexPart}`;
  return indexPart ?? literalPart ?? "Record<string, unknown>";
}

function renderArray(schema: Record<string, unknown>, ctx: Ctx): string {
  // Tuple form: draft 2020-12 `prefixItems`, or the legacy array-valued `items`.
  const tuple = Array.isArray(schema.prefixItems)
    ? schema.prefixItems
    : Array.isArray(schema.items)
      ? schema.items
      : undefined;
  if (tuple) {
    const members = tuple.map((item) => render(item, ctx));
    // A typed tail after the fixed head: 2020-12 spells it `items` next to `prefixItems`, the
    // legacy form `additionalItems`. `false` (or absent) closes the tuple, so only a schema counts.
    const rest = Array.isArray(schema.prefixItems) ? schema.items : schema.additionalItems;
    if (isRecord(rest)) {
      const element = render(rest, ctx);
      members.push(`...${isCompound(element) ? `(${element})` : element}[]`);
    }
    return `[${members.join(", ")}]`;
  }

  if (!("items" in schema)) return "unknown[]";
  const element = render(schema.items, ctx);
  return `${isCompound(element) ? `(${element})` : element}[]`;
}

/* ---------- $ref ---------- */

function renderRef(ref: string, ctx: Ctx): string {
  const name = refName(ref);
  if (name === undefined || !ctx.defs.has(name)) return "unknown";

  const tsName = typeName(name, ctx);
  // A ref already on the stack is a cycle: emit the bare name and stop — the frame that
  // started it still writes the body, so cyclic pairs terminate with both defs present.
  if (!ctx.inProgress.has(name) && !Object.hasOwn(ctx.out, tsName)) {
    ctx.inProgress.add(name);
    ctx.out[tsName] = render(ctx.defs.get(name), ctx);
    ctx.inProgress.delete(name);
  }
  return tsName;
}

/** Only local `#/$defs/X` and `#/definitions/X` pointers resolve; anything else degrades to `unknown`. */
function refName(ref: string): string | undefined {
  const match = /^#\/(?:\$defs|definitions)\/([^/]+)$/.exec(ref);
  if (!match) return undefined;
  return match[1].replace(/~1/g, "/").replace(/~0/g, "~");
}

/**
 * The TS name a def goes by, claimed once and remembered: sanitizing is lossy (`a-b` and `a_b`
 * both want `a_b`), so the first schema name to ask wins it and later ones get `_2`, `_3`, ….
 */
function typeName(name: string, ctx: Ctx): string {
  const existing = ctx.names.get(name);
  if (existing !== undefined) return existing;

  const safe = name.replace(/[^A-Za-z0-9_$]/g, "_");
  const base = /^[0-9]/.test(safe) ? `_${safe}` : safe;
  let claimed = base;
  for (let n = 2; ctx.claimed.has(claimed); n++) claimed = `${base}_${n}`;

  ctx.names.set(name, claimed);
  ctx.claimed.add(claimed);
  return claimed;
}

/* ---------- combinators ---------- */

function union(members: string[]): string {
  const parts = dedupe(members);
  if (parts.length === 0) return "unknown";
  return parts.join(" | ");
}

function intersection(members: string[]): string {
  const parts = dedupe(members);
  if (parts.length === 0) return "unknown";
  if (parts.length === 1) return parts[0];
  // A union member inside an intersection needs parens to keep its precedence.
  return parts.map((p) => (topLevelHas(p, "|") ? `(${p})` : p)).join(" & ");
}

function dedupe(members: string[]): string[] {
  const seen = new Set<string>();
  return members.filter((m) => (seen.has(m) ? false : (seen.add(m), true)));
}

function literal(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  return "unknown";
}

/** True when the rendered type has a top-level `|` or `&`, i.e. needs parens before `[]`. */
function isCompound(type: string): boolean {
  return topLevelHas(type, "|&");
}

/** Scan for any of `ops` outside braces/brackets/parens/angles and string literals. */
function topLevelHas(type: string, ops: string): boolean {
  let depth = 0;
  let quote: string | undefined;
  for (let i = 0; i < type.length; i++) {
    const ch = type[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "{" || ch === "[" || ch === "(" || ch === "<") depth++;
    else if (ch === "}" || ch === "]" || ch === ")" || ch === ">") depth--;
    else if (depth === 0 && ops.includes(ch)) return true;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
