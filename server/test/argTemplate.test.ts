import { describe, expect, it } from "vitest";
import { expandArgs } from "../src/lib/argTemplate.js";

describe("expandArgs", () => {
  const env = { EMAIL: "me@x.com", LICENSE_KEY: "k-123", EMPTY: "" };

  it("fills ${VAR} from the server's env, anywhere in an argument", () => {
    expect(expandArgs(["-y", "shadcn-studio-mcp", "EMAIL=${EMAIL}", "--key=${LICENSE_KEY}!"], env)).toEqual({
      args: ["-y", "shadcn-studio-mcp", "EMAIL=me@x.com", "--key=k-123!"],
    });
    expect(expandArgs(["${EMAIL}:${LICENSE_KEY}"], env)).toEqual({ args: ["me@x.com:k-123"] });
  });

  it("leaves arguments without placeholders alone, including bare $VAR", () => {
    expect(expandArgs(["$EMAIL", "a$b", "{x}", "$"], env)).toEqual({ args: ["$EMAIL", "a$b", "{x}", "$"] });
  });

  it("uses ${VAR:-fallback} only when VAR isn't set", () => {
    expect(expandArgs(["${PORT:-3000}", "${EMAIL:-nobody}", "${EMPTY:-x}", "${NOPE:-}"], env)).toEqual({
      args: ["3000", "me@x.com", "", ""],
    });
  });

  it("treats $${VAR} as a literal ${VAR}", () => {
    expect(expandArgs(["$${EMAIL}", "$${NOPE}"], env)).toEqual({ args: ["${EMAIL}", "${NOPE}"] });
  });

  it("never reads the switchboard's own process env", () => {
    process.env.SB_ARG_TEMPLATE_TEST = "leak";
    try {
      expect(expandArgs(["${SB_ARG_TEMPLATE_TEST}"], {})).toHaveProperty("error");
    } finally {
      delete process.env.SB_ARG_TEMPLATE_TEST;
    }
  });

  it("names every missing variable instead of substituting an empty string", () => {
    expect(expandArgs(["${A}", "${EMAIL}", "${B}${A}"], env)).toEqual({
      error:
        "Arguments use ${A}, ${B}, but the server has no env var A, B.\n" +
        "→ Edit the server and add it under Environment variables.",
    });
    expect(expandArgs(["${A}"], {})).toEqual({
      error:
        "Argument uses ${A}, but the server has no env var A.\n" +
        "→ Edit the server and add it under Environment variables.",
    });
  });
});
