import { describe, expect, it } from "vitest";
import { parseImport, tokenize } from "../src/lib/importParser.js";

describe("tokenize", () => {
  it("handles quotes and escapes", () => {
    expect(tokenize('a "b c" \'d e\' f\\ g')).toEqual(["a", "b c", "d e", "f g"]);
    expect(tokenize('--header "Authorization: Bearer x y"')).toEqual(["--header", "Authorization: Bearer x y"]);
    expect(tokenize("")).toEqual([]);
  });
});

describe("parseImport — CLI", () => {
  it("parses a remote http server", () => {
    const [s] = parseImport("claude mcp add --transport http linear-server https://mcp.linear.app/mcp");
    expect(s).toMatchObject({
      name: "linear-server",
      slug: "linear-server",
      type: "http",
      url: "https://mcp.linear.app/mcp",
      authType: "none",
    });
  });

  it("parses a bearer header into bearer auth", () => {
    const [s] = parseImport(
      'claude mcp add --transport http gh https://api.example.com/mcp --header "Authorization: Bearer tok123"',
    );
    expect(s).toMatchObject({ type: "http", authType: "bearer", bearerToken: "tok123" });
  });

  it("keeps non-bearer headers as custom headers", () => {
    const [s] = parseImport('claude mcp add --transport sse x https://e.com/sse --header "X-Api-Key: abc"');
    expect(s).toMatchObject({ type: "sse", authType: "headers", headers: { "X-Api-Key": "abc" } });
  });

  it("parses stdio with -- separator, env vars, and scope flags", () => {
    const [s] = parseImport(
      "claude mcp add airtable -s user -e AIRTABLE_API_KEY=key123 -- npx -y airtable-mcp-server --verbose",
    );
    expect(s).toMatchObject({
      name: "airtable",
      type: "stdio",
      command: "npx",
      args: ["-y", "airtable-mcp-server", "--verbose"],
      env: { AIRTABLE_API_KEY: "key123" },
    });
  });

  it("parses stdio without -- separator", () => {
    const [s] = parseImport("claude mcp add fs npx -y @modelcontextprotocol/server-filesystem /tmp");
    expect(s).toMatchObject({ type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] });
  });

  it("parses multiple lines and shell continuations", () => {
    const servers = parseImport(
      "claude mcp add --transport http a https://a.com/mcp\n$ claude mcp add b \\\n  -- npx b-server",
    );
    expect(servers.map((s) => s.name)).toEqual(["a", "b"]);
  });

  it("parses add-json", () => {
    const [s] = parseImport(`claude mcp add-json weather '{"type":"stdio","command":"uvx","args":["weather-mcp"]}'`);
    expect(s).toMatchObject({ name: "weather", type: "stdio", command: "uvx", args: ["weather-mcp"] });
  });

  it("sanitizes slugs (underscores become dashes)", () => {
    const [s] = parseImport("claude mcp add my_server -- npx x");
    expect(s.slug).toBe("my-server");
    expect(s.name).toBe("my_server");
  });
});

describe("parseImport — JSON", () => {
  it("parses an mcpServers block with multiple entries", () => {
    const servers = parseImport(`{
      "mcpServers": {
        "sequential-thinking": {
          "type": "stdio",
          "command": "npx",
          "args": ["-y", "@modelcontextprotocol/server-sequential-thinking"]
        },
        "linear": { "type": "http", "url": "https://mcp.linear.app/mcp" }
      }
    }`);
    expect(servers).toHaveLength(2);
    expect(servers[0]).toMatchObject({ name: "sequential-thinking", type: "stdio", command: "npx" });
    expect(servers[1]).toMatchObject({ name: "linear", type: "http", url: "https://mcp.linear.app/mcp" });
  });

  it("parses a bare name→config map", () => {
    const [s] = parseImport(`{"github": {"url": "https://api.githubcopilot.com/mcp/", "headers": {"Authorization": "Bearer gh_x"}}}`);
    expect(s).toMatchObject({ name: "github", type: "http", authType: "bearer", bearerToken: "gh_x" });
  });

  it("parses a single unnamed server object, inferring a name", () => {
    const [s] = parseImport(`{"type":"stdio","command":"npx","args":["-y","@modelcontextprotocol/server-sequential-thinking"]}`);
    expect(s).toMatchObject({ name: "sequential-thinking", slug: "sequential-thinking", type: "stdio" });
  });

  it("infers http type from url and stdio from command", () => {
    const [s] = parseImport(`{"context7": {"url": "https://mcp.context7.com/mcp"}}`);
    expect(s.type).toBe("http");
  });

  it("strips markdown fences", () => {
    const [s] = parseImport('```json\n{"x": {"command": "npx"}}\n```');
    expect(s).toMatchObject({ name: "x", command: "npx" });
  });

  it("rejects invalid input with useful messages", () => {
    expect(() => parseImport("{ not json")).toThrow(/Invalid JSON/);
    expect(() => parseImport("hello world")).toThrow(/Expected JSON|claude mcp add/);
    expect(() => parseImport(`{"bad": {"type": "stdio"}}`)).toThrow(/no command/);
    expect(() => parseImport(`{"bad": {"type": "http"}}`)).toThrow(/no url/);
  });
});
