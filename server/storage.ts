import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { cases, savedSearches, clusterPresets, shortUrls, type Case, type InsertCase, type SavedSearch, type InsertSavedSearch, type ClusterPreset, type InsertClusterPreset, type ShortUrl } from "@shared/schema";
import { ilike, or, and, gte, lte, eq, desc, asc, sql } from "drizzle-orm";

const client = postgres(process.env.DATABASE_URL!);
export const db = drizzle(client);

export interface SearchFilters {
  query?: string;
  jurisdiction?: string;
  court?: string;
  dateFrom?: string;
  dateTo?: string;
  legalIssue?: string;        // legacy single
  legalIssues?: string[];     // multi-select (OR logic)
  causeOfAction?: string;
  motionType?: string;
  motionOutcome?: string;
  factPattern?: string;
  attorney?: string;
  outcomes?: string[];        // multi-select
  outcome?: string;           // legacy single
  keywords?: string[];        // clicked keyword filters (legacy single-mode)
  keywordMode?: "AND" | "OR"; // how to combine multiple keywords (default AND)
  mustKeywords?: string[];    // Option C: ALL must match (AND)
  anyKeywords?: string[];     // Option C: AT LEAST ONE must match (OR)
  sortBy?: "date" | "relevance" | "citation_count" | "citation";
  sortDir?: "asc" | "desc";
  page?: number;
  pageSize?: number;
}

export interface IStorage {
  getCases(filters: SearchFilters): Promise<{ cases: Case[]; total: number }>;
  getCaseById(id: number): Promise<Case | undefined>;
  createCase(data: InsertCase): Promise<Case>;
  getSavedSearches(): Promise<SavedSearch[]>;
  createSavedSearch(data: InsertSavedSearch): Promise<SavedSearch>;
  updateSavedSearch(id: number, filters: string): Promise<SavedSearch | null>;
  deleteSavedSearch(id: number): Promise<void>;
  getClusterPresets(): Promise<ClusterPreset[]>;
  createClusterPreset(data: InsertClusterPreset): Promise<ClusterPreset>;
  deleteClusterPreset(id: number): Promise<void>;
  getOutcomeCounts(filters: Omit<SearchFilters, "outcomes" | "outcome">): Promise<{ outcome: string; count: number }[]>;
  createShortUrl(longUrl: string): Promise<ShortUrl>;
  resolveShortUrl(code: string): Promise<ShortUrl | undefined>;
}

// ── Query helpers ────────────────────────────────────────────────────────────

/**
 * Sanitise a user query string so it is safe to pass to websearch_to_tsquery.
 * websearch_to_tsquery is already injection-safe (it never throws), but we
 * strip characters that would produce an empty tsquery and fall back gracefully.
 */
function sanitiseQuery(q: string): string {
  return q.replace(/[;'"\\]/g, " ").trim();
}

/**
 * Build the shared WHERE conditions for a given filter set.
 * - Main text search  → GIN  tsvector @@ websearch_to_tsquery  (fast, ranked)
 * - Keyword facets   → GIN  tsvector @@ plainto_tsquery        (per-keyword)
 * - Exact filters    → BTREE eq / ILIKE for partial fields
 */
function buildConditions(filters: Omit<SearchFilters, "sortBy" | "sortDir" | "page" | "pageSize">): any[] {
  const {
    query, jurisdiction, court, dateFrom, dateTo,
    legalIssue, legalIssues = [], causeOfAction,
    motionType, motionOutcome, factPattern, attorney,
    outcome, outcomes = [], keywords = [], keywordMode = "AND",
    mustKeywords = [], anyKeywords = [],
  } = filters;

  const conditions: any[] = [];

  // ── Main free-text search via GIN tsvector ──────────────────────────────
  if (query && query.trim()) {
    const safe = sanitiseQuery(query);
    conditions.push(
      sql`search_vector @@ websearch_to_tsquery('english', ${safe})`
    );
  }

  // ── Keyword facets (clicked chips) ─────────────────────────────────────
  // Option C two-tier keyword logic
  // mustKeywords: ALL must match (each adds its own AND condition)
  if (mustKeywords.length > 0) {
    mustKeywords.forEach(kw =>
      conditions.push(sql`search_vector @@ plainto_tsquery('english', ${kw})`)
    );
  }
  // anyKeywords: AT LEAST ONE must match (OR across all)
  if (anyKeywords.length > 0) {
    const anyClauses = anyKeywords.map(
      kw => sql`search_vector @@ plainto_tsquery('english', ${kw})`
    );
    conditions.push(or(...anyClauses));
  }
  // Legacy single-mode keywords (backward compat — only used if two-tier not set)
  if (keywords.length > 0 && mustKeywords.length === 0 && anyKeywords.length === 0) {
    const kwClauses = keywords.map(
      kw => sql`search_vector @@ plainto_tsquery('english', ${kw})`
    );
    if (keywordMode === "OR") {
      conditions.push(or(...kwClauses));
    } else {
      kwClauses.forEach(c => conditions.push(c));
    }
  }

  // ── Exact / partial filter fields (BTREE indexes) ──────────────────────
  if (jurisdiction) conditions.push(eq(cases.jurisdiction, jurisdiction) as any);
  if (court)        conditions.push(ilike(cases.court, `%${court}%`) as any);
  if (dateFrom)     conditions.push(gte(cases.date, dateFrom) as any);
  if (dateTo)       conditions.push(lte(cases.date, dateTo) as any);

  // Legal issue: multi-select OR, or single legacy value
  const legalIssueList = legalIssues.length > 0
    ? legalIssues
    : legalIssue ? [legalIssue] : [];
  if (legalIssueList.length === 1) {
    conditions.push(ilike(cases.legalIssue, `%${legalIssueList[0]}%`) as any);
  } else if (legalIssueList.length > 1) {
    conditions.push(or(...legalIssueList.map(li => ilike(cases.legalIssue, `%${li}%`))) as any);
  }

  if (causeOfAction) conditions.push(ilike(cases.causeOfAction, `%${causeOfAction}%`) as any);
  if (motionType)    conditions.push(ilike(cases.motionType,    `%${motionType}%`) as any);
  if (motionOutcome) conditions.push(eq(cases.motionOutcome, motionOutcome) as any);
  if (factPattern)   conditions.push(ilike(cases.factPattern,  `%${factPattern}%`) as any);

  // Outcome multi-select (OR logic)
  const outcomeList = outcomes.length > 0 ? outcomes : outcome ? [outcome] : [];
  if (outcomeList.length === 1) {
    conditions.push(eq(cases.outcome, outcomeList[0]) as any);
  } else if (outcomeList.length > 1) {
    conditions.push(or(...outcomeList.map(o => eq(cases.outcome, o))) as any);
  }

  // Attorney search (ILIKE on JSON text columns)
  if (attorney) {
    const a = `%${attorney}%`;
    conditions.push(
      or(
        ilike(cases.plaintiffAttorneys, a),
        ilike(cases.defendantAttorneys, a)
      ) as any
    );
  }

  return conditions;
}

// ── Storage class ─────────────────────────────────────────────────────────────
export class Storage implements IStorage {

  async getCases(filters: SearchFilters): Promise<{ cases: Case[]; total: number }> {
    const {
      query,
      sortBy = "relevance", sortDir = "desc",
      page = 1, pageSize = 20,
    } = filters;

    const conditions = buildConditions(filters);
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const offset = (page - 1) * pageSize;

    // ── Sort column ────────────────────────────────────────────────────────
    // When a free-text query is present and user wants relevance sort,
    // order by ts_rank so highest-matching docs bubble to the top.
    let orderExpr: any;
    if (sortBy === "relevance" && query && query.trim()) {
      const safe = sanitiseQuery(query);
      const dir = sortDir === "asc" ? sql`ASC` : sql`DESC`;
      orderExpr = sql`ts_rank(search_vector, websearch_to_tsquery('english', ${safe})) ${dir}`;
    } else {
      const col =
        sortBy === "date"           ? cases.date
        : sortBy === "citation_count" ? cases.citationCount
        : sortBy === "citation"       ? cases.citation
        : cases.relevanceScore;
      orderExpr = sortDir === "asc" ? asc(col) : desc(col);
    }

    const [rows, countRows] = await Promise.all([
      db.select().from(cases)
        .where(where)
        .orderBy(orderExpr)
        .limit(pageSize)
        .offset(offset),
      db.select({ count: sql<number>`cast(count(*) as integer)` })
        .from(cases)
        .where(where),
    ]);

    return { cases: rows, total: countRows[0]?.count ?? 0 };
  }

  async getCaseById(id: number): Promise<Case | undefined> {
    const rows = await db.select().from(cases).where(eq(cases.id, id));
    return rows[0];
  }

  async createCase(data: InsertCase): Promise<Case> {
    const rows = await db.insert(cases).values(data).returning();
    return rows[0];
  }

  async getSavedSearches(): Promise<SavedSearch[]> {
    return db.select().from(savedSearches).orderBy(desc(savedSearches.id));
  }

  async createSavedSearch(data: InsertSavedSearch): Promise<SavedSearch> {
    const rows = await db.insert(savedSearches).values(data).returning();
    return rows[0];
  }

  async updateSavedSearch(id: number, filters: string): Promise<SavedSearch | null> {
    const rows = await db.update(savedSearches).set({ filters }).where(eq(savedSearches.id, id)).returning();
    return rows[0] ?? null;
  }

  async deleteSavedSearch(id: number): Promise<void> {
    await db.delete(savedSearches).where(eq(savedSearches.id, id));
  }

  async getClusterPresets(): Promise<ClusterPreset[]> {
    return db.select().from(clusterPresets).orderBy(desc(clusterPresets.id));
  }

  async createClusterPreset(data: InsertClusterPreset): Promise<ClusterPreset> {
    const rows = await db.insert(clusterPresets).values(data).returning();
    return rows[0];
  }

  async deleteClusterPreset(id: number): Promise<void> {
    await db.delete(clusterPresets).where(eq(clusterPresets.id, id));
  }

  async getOutcomeCounts(
    baseFilters: Omit<SearchFilters, "outcomes" | "outcome">
  ): Promise<{ outcome: string; count: number }[]> {
    const conditions = buildConditions(baseFilters);
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await db
      .select({
        outcome: cases.outcome,
        count: sql<number>`cast(count(*) as integer)`,
      })
      .from(cases)
      .where(where)
      .groupBy(cases.outcome)
      .orderBy(desc(sql`count(*)`));

    return rows.map(r => ({ outcome: r.outcome, count: r.count }));
  }

  // ── URL Shortener ────────────────────────────────────────────────────────

  /** Generate a random 6-char alphanumeric code (YouTube-style) */
  private generateCode(length = 6): string {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
    let code = "";
    for (let i = 0; i < length; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
  }

  async createShortUrl(longUrl: string): Promise<ShortUrl> {
    // Check if this exact long URL already has a code — reuse it
    const existing = await db
      .select()
      .from(shortUrls)
      .where(eq(shortUrls.longUrl, longUrl))
      .limit(1);
    if (existing.length > 0) return existing[0];

    // Generate a unique code (retry on collision — astronomically rare)
    let code = this.generateCode();
    let attempts = 0;
    while (attempts < 5) {
      const clash = await db.select().from(shortUrls).where(eq(shortUrls.code, code)).limit(1);
      if (clash.length === 0) break;
      code = this.generateCode();
      attempts++;
    }

    const rows = await db.insert(shortUrls).values({ code, longUrl }).returning();
    return rows[0];
  }

  async resolveShortUrl(code: string): Promise<ShortUrl | undefined> {
    const rows = await db.select().from(shortUrls).where(eq(shortUrls.code, code)).limit(1);
    if (rows.length === 0) return undefined;
    // Increment hit counter asynchronously (fire-and-forget)
    db.update(shortUrls)
      .set({ hitCount: sql`hit_count + 1` })
      .where(eq(shortUrls.code, code))
      .execute()
      .catch(() => {});
    return rows[0];
  }
}

export const storage = new Storage();
