import { pgTable, text, integer, serial, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const cases = pgTable("cases", {
  id: serial("id").primaryKey(),
  citation: text("citation").notNull(),
  caseName: text("case_name").notNull(),
  court: text("court").notNull(),
  jurisdiction: text("jurisdiction").notNull(),
  date: text("date").notNull(),
  outcome: text("outcome").notNull(), // "plaintiff", "defendant", "mixed", "dismissed", "settled"
  legalIssue: text("legal_issue").notNull(),
  causeOfAction: text("cause_of_action").notNull(),
  motionType: text("motion_type").notNull(),
  motionOutcome: text("motion_outcome").notNull(),
  factPattern: text("fact_pattern").notNull(),
  plaintiffAttorneys: text("plaintiff_attorneys").notNull(), // JSON
  defendantAttorneys: text("defendant_attorneys").notNull(), // JSON
  judges: text("judges").notNull(), // JSON
  summary: text("summary").notNull(),
  holdings: text("holdings").notNull(), // JSON array
  relevanceScore: integer("relevance_score").notNull().default(0),
  citationCount: integer("citation_count").notNull().default(0),
  keywords: text("keywords").notNull(), // JSON array
  // Generated tsvector column — managed by Postgres, read-only in ORM
  searchVector: text("search_vector"),
});

export type Case = typeof cases.$inferSelect;
export const insertCaseSchema = createInsertSchema(cases).omit({ id: true });
export type InsertCase = z.infer<typeof insertCaseSchema>;

export const savedSearches = pgTable("saved_searches", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  query: text("query").notNull(),
  filters: text("filters").notNull(), // JSON
  confidentiality: text("confidentiality").notNull().default("none"),
  createdAt: text("created_at").notNull(),
});

export type SavedSearch = typeof savedSearches.$inferSelect;
export const insertSavedSearchSchema = createInsertSchema(savedSearches).omit({ id: true });
export type InsertSavedSearch = z.infer<typeof insertSavedSearchSchema>;

export const clusterPresets = pgTable("cluster_presets", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  cluster: text("cluster").notNull(),       // e.g. "Constitutional Issues"
  keywords: text("keywords").notNull(),     // JSON array of active keyword strings
  kwSearch: text("kw_search").notNull(),    // the keyword filter string (may be empty)
  createdAt: text("created_at").notNull(),
});

export type ClusterPreset = typeof clusterPresets.$inferSelect;
export const insertClusterPresetSchema = createInsertSchema(clusterPresets).omit({ id: true });
export type InsertClusterPreset = z.infer<typeof insertClusterPresetSchema>;

export const shortUrls = pgTable("short_urls", {
  id:        serial("id").primaryKey(),
  code:      text("code").notNull(),       // 6-char alphanumeric code
  longUrl:   text("long_url").notNull(),   // full search state string
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  hitCount:  integer("hit_count").notNull().default(0),
});

export type ShortUrl = typeof shortUrls.$inferSelect;
export const insertShortUrlSchema = createInsertSchema(shortUrls).omit({ id: true, createdAt: true, hitCount: true });
export type InsertShortUrl = z.infer<typeof insertShortUrlSchema>;

// ── Research Lists (Playlist) ──────────────────────────────────────────────
export const caseLists = pgTable("case_lists", {
  id:        serial("id").primaryKey(),
  name:      text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export type CaseList = typeof caseLists.$inferSelect;
export const insertCaseListSchema = createInsertSchema(caseLists).omit({ id: true, createdAt: true });
export type InsertCaseList = z.infer<typeof insertCaseListSchema>;

export const caseListItems = pgTable("case_list_items", {
  id:       serial("id").primaryKey(),
  listId:   integer("list_id").notNull().references(() => caseLists.id, { onDelete: "cascade" }),
  caseId:   integer("case_id").notNull().references(() => cases.id,     { onDelete: "cascade" }),
  position: integer("position").notNull().default(0),
  addedAt:  timestamp("added_at",  { withTimezone: true }).defaultNow(),
  comment:  text("comment").notNull().default(""),
});

export type CaseListItem = typeof caseListItems.$inferSelect;
export const insertCaseListItemSchema = createInsertSchema(caseListItems).omit({ id: true, addedAt: true });
export type InsertCaseListItem = z.infer<typeof insertCaseListItemSchema>;
