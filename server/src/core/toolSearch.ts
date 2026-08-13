/**
 * Ranked lexical search over a tool catalog. Pure and I/O-free: callers hand in
 * whatever catalog they already have (live upstream tools, cached rows, …) so this
 * module stays trivially testable and can run inside a tool call without awaiting anything.
 *
 * The scorer is field-weighted rather than TF-IDF: catalogs are small (hundreds of tools)
 * and the useful signal is almost entirely "which field did the query hit", not term rarity.
 */

import { parseNsName } from "./namespace.js";

export interface SearchableTool {
  /** Namespaced name, e.g. `gmail__send_email`. */
  name: string;
  /** Server slug, e.g. `gmail`. */
  server: string;
  description?: string;
}

export interface ToolMatch extends SearchableTool {
  score: number;
}

/** A hit on the tool's own name beats its server, which beats prose in the description. */
const WEIGHT_NAME = 10;
const WEIGHT_SERVER = 8;
const WEIGHT_DESCRIPTION = 5;

/** Phrase-level tiers (multiplied by the field weight). Only the strongest applicable one is awarded. */
const TIER_EXACT = 14;
const TIER_PREFIX = 9;
const TIER_SUBSTRING = 6;

/** Token-level tiers (multiplied by the field weight), awarded once per query token per field. */
const TOKEN_EXACT = 4;
const TOKEN_PREFIX = 2;
const TOKEN_SUBSTRING = 1;

const BONUS_FULL_COVERAGE = 25;
const BONUS_LEADING_TOKEN = 8;
const BONUS_WHOLE_NAME = 20;

/** Short queries are all-or-nothing; longer ones are allowed to miss a few words. */
const SHORT_QUERY_TOKENS = 2;
const LONG_QUERY_COVERAGE = 0.6;

/** How much character-level similarity is worth when ranking typo suggestions. */
const SUGGEST_SIMILARITY_WEIGHT = 120;

/** Edit distance that still reads as "the same word, typed badly", and what a hit is worth. */
const SUGGEST_MAX_DISTANCE = 2;
const SUGGEST_DISTANCE_CAP = 3;
const SUGGEST_DISTANCE_WEIGHT = 30;

/**
 * Longest query we score. Bounds scorer work (O(query tokens × tools × fields)), which runs
 * synchronously inside a tool call — a runaway model must not stall the event loop.
 */
const MAX_QUERY_CHARS = 256;

/**
 * `getUserV2` / `get_user.v2` / `get-user:v2` all collapse to `get user v2`, so a query
 * written in any casing convention lines up with a tool named in another.
 */
function normalize(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_./:-]+/g, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(normalized: string): string[] {
  return normalized.split(/[^a-z0-9]+/).filter((token) => token.length > 0);
}

/** Server slugs never contain underscores, so the first `__` is always the namespace boundary. */
function bareName(name: string): string {
  return parseNsName(name)?.name ?? name;
}

interface Query {
  phrase: string;
  tokens: string[];
}

function buildQuery(raw: string): Query {
  const phrase = normalize(raw);
  return { phrase, tokens: tokenize(phrase) };
}

interface FieldScore {
  score: number;
  exactPhrase: boolean;
  /** Which query tokens this field accounted for, positionally. Feeds the coverage gate. */
  matched: boolean[];
}

function scoreField(text: string, weight: number, query: Query): FieldScore {
  const matched = query.tokens.map(() => false);
  if (!text) return { score: 0, exactPhrase: false, matched };

  const phrase = normalize(text);
  const tokens = tokenize(phrase);
  let score = 0;
  let exactPhrase = false;

  // Phrase tiers nest (exact implies prefix implies substring), so award only the best one.
  if (phrase === query.phrase) {
    score += weight * TIER_EXACT;
    exactPhrase = true;
  } else if (phrase.startsWith(query.phrase)) {
    score += weight * TIER_PREFIX;
  } else if (phrase.includes(query.phrase)) {
    score += weight * TIER_SUBSTRING;
  }

  // Token hits accumulate on top of the phrase tier: matching more of the query is worth more.
  for (let i = 0; i < query.tokens.length; i++) {
    const qt = query.tokens[i];
    let tier = 0;
    if (tokens.includes(qt)) tier = TOKEN_EXACT;
    else if (tokens.some((ft) => ft.startsWith(qt) || qt.startsWith(ft))) tier = TOKEN_PREFIX;
    else if (phrase.includes(qt)) tier = TOKEN_SUBSTRING;
    if (tier > 0) {
      score += weight * tier;
      matched[i] = true;
    }
  }

  return { score, exactPhrase, matched };
}

interface ToolScore {
  score: number;
  /** Fraction of query tokens that matched somewhere. */
  coverage: number;
  exactPhrase: boolean;
}

function scoreTool(tool: SearchableTool, query: Query): ToolScore {
  const bare = bareName(tool.name);
  const fields = [
    scoreField(bare, WEIGHT_NAME, query),
    scoreField(tool.server, WEIGHT_SERVER, query),
    scoreField(tool.description ?? "", WEIGHT_DESCRIPTION, query),
  ];

  let score = fields.reduce((sum, field) => sum + field.score, 0);
  const exactPhrase = fields.some((field) => field.exactPhrase);
  const matchedTokens = query.tokens.filter((_, i) => fields.some((field) => field.matched[i])).length;
  const coverage = query.tokens.length === 0 ? 0 : matchedTokens / query.tokens.length;

  // Hitting every word of the query is the strongest relevance signal there is.
  score += coverage >= 1 ? BONUS_FULL_COVERAGE : Math.round(coverage * 10);

  // `send_email` should outrank `resend_email` for the query "send email".
  const bareTokens = tokenize(normalize(bare));
  if (bareTokens.length > 0 && bareTokens[0] === query.tokens[0]) score += BONUS_LEADING_TOKEN;

  // Someone typing a tool's full name (bare or namespaced) wants that tool, not a cousin.
  if (normalize(bare) === query.phrase || normalize(tool.name) === query.phrase) score += BONUS_WHOLE_NAME;

  return { score, coverage, exactPhrase };
}

/** Below this, the result is noise rather than a weak match, and is dropped outright. */
function coverageFloor(query: Query): number {
  return query.tokens.length <= SHORT_QUERY_TOKENS ? 1 : LONG_QUERY_COVERAGE;
}

/**
 * Ranked matches, best first. An empty or punctuation-only query returns `[]` — the caller
 * decides whether that means "enumerate everything" or "ask the user for a query".
 */
export function searchTools(
  tools: SearchableTool[],
  query: string,
  opts?: { server?: string },
): ToolMatch[] {
  const q = buildQuery(query.slice(0, MAX_QUERY_CHARS));
  if (q.tokens.length === 0) return [];

  const pool = opts?.server === undefined ? tools : tools.filter((t) => t.server === opts.server);
  const floor = coverageFloor(q);
  const matches: ToolMatch[] = [];

  for (const tool of pool) {
    const { score, coverage, exactPhrase } = scoreTool(tool, q);
    // An exact phrase hit is unambiguous intent, so it never gets gated out.
    if (!exactPhrase && coverage < floor) continue;
    matches.push({ ...tool, score });
  }

  // Ties break on name so pagination over repeated calls stays stable.
  matches.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return matches;
}

/** Offset/limit slicing with the cursor bookkeeping every paged tool response needs. */
export function paginate<T>(
  all: readonly T[],
  offset: number,
  limit: number,
): { items: T[]; total: number; hasMore: boolean; nextOffset: number | null } {
  const start = Math.max(0, offset);
  const size = Math.max(0, limit);
  const total = all.length;
  // A zero-size page never advances, so it must not hand back a cursor that repeats forever.
  const hasMore = size > 0 && start + size < total;
  return {
    items: all.slice(start, start + size),
    total,
    hasMore,
    nextOffset: hasMore ? start + size : null,
  };
}

/** Character bigrams, used for the typo tolerance the token-based scorer can't provide. */
function bigrams(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < text.length; i++) out.push(text.slice(i, i + 2));
  return out;
}

/** Sørensen–Dice over character bigrams: `sned email` ≈ `send email` even though no token matches. */
function diceSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const left = bigrams(a);
  const right = bigrams(b);
  if (left.length === 0 || right.length === 0) return 0;

  const pool = new Map<string, number>();
  for (const gram of left) pool.set(gram, (pool.get(gram) ?? 0) + 1);

  let hits = 0;
  for (const gram of right) {
    const remaining = pool.get(gram) ?? 0;
    if (remaining > 0) {
      pool.set(gram, remaining - 1);
      hits++;
    }
  }
  return (2 * hits) / (left.length + right.length);
}

/**
 * Levenshtein distance, capped: once every path through a row already costs `cap`, the answer
 * can only be `cap` or more, so we stop. Callers only care whether a typo is close, not how far
 * a mismatch is, and the cap keeps a long name from costing a full O(n × m) table.
 */
function levenshtein(a: string, b: string, cap: number): number {
  if (a === b) return 0;
  // Length alone already forces at least this many edits.
  if (Math.abs(a.length - b.length) >= cap) return cap;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = new Array<number>(b.length + 1);
    row[0] = i;
    let rowMin = row[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      if (row[j] < rowMin) rowMin = row[j];
    }
    if (rowMin >= cap) return cap;
    prev = row;
  }
  return Math.min(prev[b.length], cap);
}

/**
 * "Did you mean …?" for a tool name an agent got wrong. Uses the search scorer (ungated —
 * a misspelling by definition fails coverage) blended with character similarity, which is what
 * separates `send_email` from every other `*_email` tool when the query is `sned_email`.
 */
export function suggest(tools: SearchableTool[], misspelled: string, max = 3): string[] {
  const q = buildQuery(bareName(misspelled.slice(0, MAX_QUERY_CHARS)));
  if (q.tokens.length === 0) return [];

  const target = q.phrase.replace(/ /g, "");
  const ranked: Array<{ name: string; rank: number }> = [];

  for (const tool of tools) {
    const { score } = scoreTool(tool, q);
    const candidate = normalize(bareName(tool.name)).replace(/ /g, "");
    const distance = levenshtein(target, candidate, SUGGEST_DISTANCE_CAP);
    // Either kind of overlap qualifies, and neither alone is enough on its own terms: a
    // single-token typo like `qurey` shares no token or substring with `query`, while a
    // multi-word miss is too far in edit distance to be caught by that alone.
    if (score <= 0 && distance > SUGGEST_MAX_DISTANCE) continue;
    const closeness =
      distance <= SUGGEST_MAX_DISTANCE ? (SUGGEST_DISTANCE_CAP - distance) * SUGGEST_DISTANCE_WEIGHT : 0;
    ranked.push({
      name: tool.name,
      rank: score + diceSimilarity(target, candidate) * SUGGEST_SIMILARITY_WEIGHT + closeness,
    });
  }

  ranked.sort((a, b) => b.rank - a.rank || a.name.localeCompare(b.name));
  return ranked.slice(0, Math.max(0, max)).map((entry) => entry.name);
}
