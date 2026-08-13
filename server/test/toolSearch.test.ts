import { describe, expect, it } from "vitest";
import { paginate, searchTools, suggest, type SearchableTool } from "../src/core/toolSearch.js";

const names = (tools: SearchableTool[]) => tools.map((t) => t.name);

describe("searchTools ranking", () => {
  it("ranks a name hit above a server hit above a description-only hit", () => {
    const tools: SearchableTool[] = [
      { name: "y__compose", server: "y", description: "Draft a message and send it with gmail" },
      { name: "gmail__send", server: "gmail" },
      { name: "x__gmail", server: "x" },
    ];

    const hits = searchTools(tools, "gmail");
    expect(names(hits)).toEqual(["x__gmail", "gmail__send", "y__compose"]);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
    expect(hits[1].score).toBeGreaterThan(hits[2].score);
  });

  it("matches camelCase queries against snake_case tools", () => {
    const tools: SearchableTool[] = [
      { name: "calendar__create_event", server: "calendar" },
      { name: "calendar__delete_event", server: "calendar" },
    ];
    expect(names(searchTools(tools, "createEvent"))).toEqual(["calendar__create_event"]);
  });

  it("matches snake_case queries against camelCase tools", () => {
    const tools: SearchableTool[] = [
      { name: "calendar__createEvent", server: "calendar" },
      { name: "calendar__deleteEvent", server: "calendar" },
    ];
    expect(names(searchTools(tools, "create_event"))).toEqual(["calendar__createEvent"]);
  });

  it("filters by server slug when asked", () => {
    const tools: SearchableTool[] = [
      { name: "gmail__send_email", server: "gmail" },
      { name: "outlook__send_email", server: "outlook" },
    ];
    expect(names(searchTools(tools, "send email", { server: "outlook" }))).toEqual([
      "outlook__send_email",
    ]);
    expect(names(searchTools(tools, "send email", { server: "nope" }))).toEqual([]);
  });

  it("returns nothing for an empty or whitespace-only query", () => {
    const tools: SearchableTool[] = [{ name: "gmail__send_email", server: "gmail" }];
    expect(searchTools(tools, "")).toEqual([]);
    expect(searchTools(tools, "   \t\n ")).toEqual([]);
    expect(searchTools(tools, "!!!")).toEqual([]);
  });
});

describe("searchTools coverage gate", () => {
  it("drops a long query that only matches one of its tokens", () => {
    const tools: SearchableTool[] = [
      { name: "calendar__create_event", server: "calendar", description: "Create a calendar event" },
    ];
    // 1 of 3 tokens matched (0.33) is below the 0.6 floor for longer queries.
    expect(searchTools(tools, "delete recurring event")).toEqual([]);
  });

  it("requires full coverage for a two-token query", () => {
    const tools: SearchableTool[] = [{ name: "calendar__create_event", server: "calendar" }];
    expect(searchTools(tools, "delete event")).toEqual([]);
    expect(names(searchTools(tools, "create event"))).toEqual(["calendar__create_event"]);
  });

  it("keeps an exact phrase match while gating out its partially-matching neighbour", () => {
    const tools: SearchableTool[] = [
      { name: "calendar__create_recurring_event", server: "calendar" },
      { name: "notes__create_note", server: "notes" },
    ];
    expect(names(searchTools(tools, "create recurring event"))).toEqual([
      "calendar__create_recurring_event",
    ]);
  });
});

describe("searchTools determinism", () => {
  it("breaks equal-score ties by name and is stable across calls and input order", () => {
    const tools: SearchableTool[] = [
      { name: "zebra__send_email", server: "zebra" },
      { name: "alpha__send_email", server: "alpha" },
      { name: "middle__send_email", server: "middle" },
    ];

    const first = searchTools(tools, "send email");
    expect(names(first)).toEqual(["alpha__send_email", "middle__send_email", "zebra__send_email"]);
    expect(new Set(first.map((t) => t.score)).size).toBe(1);

    expect(searchTools(tools, "send email")).toEqual(first);
    expect(searchTools([...tools].reverse(), "send email")).toEqual(first);
  });
});

describe("paginate", () => {
  const all = ["a", "b", "c", "d", "e"];

  it("reports more pages mid-list", () => {
    expect(paginate(all, 0, 2)).toEqual({
      items: ["a", "b"],
      total: 5,
      hasMore: true,
      nextOffset: 2,
    });
    expect(paginate(all, 2, 2)).toEqual({
      items: ["c", "d"],
      total: 5,
      hasMore: true,
      nextOffset: 4,
    });
  });

  it("closes the cursor on the last page", () => {
    expect(paginate(all, 4, 2)).toEqual({
      items: ["e"],
      total: 5,
      hasMore: false,
      nextOffset: null,
    });
    expect(paginate(all, 0, 5)).toEqual({
      items: all,
      total: 5,
      hasMore: false,
      nextOffset: null,
    });
  });

  it("handles an offset past the end and a negative offset", () => {
    expect(paginate(all, 99, 10)).toEqual({
      items: [],
      total: 5,
      hasMore: false,
      nextOffset: null,
    });
    expect(paginate(all, -3, 2)).toEqual({
      items: ["a", "b"],
      total: 5,
      hasMore: true,
      nextOffset: 2,
    });
    expect(paginate([], 0, 10)).toEqual({ items: [], total: 0, hasMore: false, nextOffset: null });
  });

  it("never hands back a cursor that cannot advance", () => {
    // A zero-size page would otherwise report hasMore with nextOffset === offset, forever.
    expect(paginate(all, 0, 0)).toEqual({ items: [], total: 5, hasMore: false, nextOffset: null });
    expect(paginate(all, 2, -1)).toEqual({ items: [], total: 5, hasMore: false, nextOffset: null });
  });
});

describe("searchTools query bounds", () => {
  const tools: SearchableTool[] = [
    { name: "gmail__send_email", server: "gmail", description: "Send an email message" },
    { name: "calendar__create_event", server: "calendar" },
  ];

  it("scores only the first 256 characters of a runaway query", () => {
    const huge = `send email ${"x".repeat(1_000_000)}`;
    expect(() => searchTools(tools, huge)).not.toThrow();
    expect(searchTools(tools, huge)).toEqual(searchTools(tools, huge.slice(0, 256)));
    expect(() => suggest(tools, huge)).not.toThrow();
    expect(suggest(tools, huge)).toEqual(suggest(tools, huge.slice(0, 256)));
  });
});

describe("suggest", () => {
  const catalog: SearchableTool[] = [
    { name: "gmail__send_email", server: "gmail", description: "Send an email message" },
    { name: "gmail__forward_email", server: "gmail" },
    { name: "gmail__list_messages", server: "gmail" },
    { name: "calendar__create_event", server: "calendar" },
  ];

  it("recovers from a transposition typo", () => {
    expect(suggest(catalog, "sned_email")[0]).toBe("gmail__send_email");
  });

  it("accepts a namespaced misspelling too", () => {
    expect(suggest(catalog, "gmail__sned_email")[0]).toBe("gmail__send_email");
  });

  it("recovers from a single-token typo with no lexical overlap at all", () => {
    const db: SearchableTool[] = [
      { name: "db__query", server: "db", description: "Run a read-only SQL statement" },
      { name: "db__insert", server: "db" },
    ];
    expect(suggest(db, "qurey")[0]).toBe("db__query");
    expect(suggest(db, "db__qurey")[0]).toBe("db__query");
  });

  it("returns nothing for garbage", () => {
    expect(suggest(catalog, "qqq_zzz")).toEqual([]);
    expect(suggest(catalog, "zzz_qqq")).toEqual([]);
    expect(suggest(catalog, "   ")).toEqual([]);
  });

  it("respects max", () => {
    expect(suggest(catalog, "sned_email", 1)).toEqual(["gmail__send_email"]);
    expect(suggest(catalog, "email").length).toBeLessThanOrEqual(3);
  });
});
