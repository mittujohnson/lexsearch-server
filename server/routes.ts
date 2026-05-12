import { type Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import PDFDocument from "pdfkit";
import { db } from "./storage";
import { caseLists, caseListItems, cases, shortUrls } from "../shared/schema";
import { eq, and, sql } from "drizzle-orm";
import crypto from "crypto";

export async function registerRoutes(httpServer: Server, app: Express) {
  // Search cases
  app.get("/api/cases", async (req, res) => {
    const {
      q, jurisdiction, court, dateFrom, dateTo, legalIssue,
      causeOfAction, motionType, motionOutcome, factPattern, attorney,
      outcome, sortBy, sortDir, page, pageSize
    } = req.query as Record<string, string>;

    // outcomes[] supports multi-select: ?outcomes[]=plaintiff&outcomes[]=defendant
    const outcomesRaw = req.query["outcomes[]"];
    const outcomes = outcomesRaw
      ? Array.isArray(outcomesRaw) ? outcomesRaw as string[] : [outcomesRaw as string]
      : undefined;

    // legalIssues[] supports multi-select: ?legalIssues[]=Patent&legalIssues[]=TCPA
    const legalIssuesRaw = req.query["legalIssues[]"];
    const legalIssues = legalIssuesRaw
      ? Array.isArray(legalIssuesRaw) ? legalIssuesRaw as string[] : [legalIssuesRaw as string]
      : undefined;

    // keywords[] supports multi-select clicked keywords: ?keywords[]=TCPA&keywords[]=arbitration
    const keywordsRaw = req.query["keywords[]"];
    const keywords = keywordsRaw
      ? Array.isArray(keywordsRaw) ? keywordsRaw as string[] : [keywordsRaw as string]
      : undefined;
    const keywordMode = (req.query.keywordMode as string) === "OR" ? "OR" : "AND";
    const mustKwRaw = req.query["mustKeywords[]"];
    const mustKeywords = mustKwRaw ? (Array.isArray(mustKwRaw) ? mustKwRaw as string[] : [mustKwRaw as string]) : [];
    const anyKwRaw = req.query["anyKeywords[]"];
    const anyKeywords = anyKwRaw ? (Array.isArray(anyKwRaw) ? anyKwRaw as string[] : [anyKwRaw as string]) : [];

    const result = await storage.getCases({
      query: q,
      jurisdiction,
      court,
      dateFrom,
      dateTo,
      legalIssue,
      causeOfAction,
      motionType,
      motionOutcome,
      factPattern,
      attorney,
      outcomes,
      outcome,
      legalIssues,
      keywords,
      keywordMode,
      mustKeywords,
      anyKeywords,
      sortBy: sortBy as any,
      sortDir: sortDir as any,
      page: page ? parseInt(page) : 1,
      pageSize: pageSize ? parseInt(pageSize) : 20,
    });

    res.json(result);
  });

  // Outcome counts (for faceted checkbox display)
  app.get("/api/outcome-counts", async (req, res) => {
    const {
      q, jurisdiction, court, dateFrom, dateTo, legalIssue,
      causeOfAction, motionType, motionOutcome, factPattern, attorney
    } = req.query as Record<string, string>;

    const counts = await storage.getOutcomeCounts({
      query: q, jurisdiction, court, dateFrom, dateTo,
      legalIssue, causeOfAction, motionType, motionOutcome, factPattern, attorney,
    });
    res.json(counts);
  });

  // Get single case
  app.get("/api/cases/:id", async (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
    const c = await storage.getCaseById(id);
    if (!c) return res.status(404).json({ error: "Not found" });
    res.json(c);
  });

  // ─── Citation Report Export ─────────────────────────────────────

  // ── URL Shortener ─────────────────────────────────────────────────────
  // POST /api/shorten  { longUrl: string } → { code, shortUrl }
  app.post("/api/shorten", async (req, res) => {
    const { longUrl } = req.body;
    if (!longUrl || typeof longUrl !== "string") {
      return res.status(400).json({ error: "longUrl is required" });
    }
    if (longUrl.length > 8000) {
      return res.status(400).json({ error: "URL too long (max 8000 chars)" });
    }
    try {
      const record = await storage.createShortUrl(longUrl);
      res.json({ code: record.code, shortUrl: `/#/s/${record.code}` });
    } catch (err) {
      res.status(500).json({ error: "Failed to create short URL" });
    }
  });

  // GET /api/s/:code → { longUrl } (frontend will redirect)
  app.get("/api/s/:code", async (req, res) => {
    const { code } = req.params;
    if (!code || !/^[A-Za-z0-9]{4,12}$/.test(code)) {
      return res.status(400).json({ error: "Invalid code" });
    }
    const record = await storage.resolveShortUrl(code);
    if (!record) return res.status(404).json({ error: "Short URL not found" });
    res.json({ longUrl: record.longUrl, hitCount: record.hitCount });
  });

  app.get("/api/export/citation-report", async (req, res) => {
    try {
      const {
        q, jurisdiction, court, dateFrom, dateTo, legalIssue,
        causeOfAction, motionType, motionOutcome, factPattern, attorney,
        outcome, sortBy, sortDir, clientName, matterNumber, confidentiality,
        comments,
      } = req.query as Record<string, string>;
      const template: "standard" | "executive" | "detailed" =
        (req.query.template as string) === "executive" ? "executive" :
        (req.query.template as string) === "detailed"  ? "detailed"  : "standard";

      const outcomesRaw = req.query["outcomes[]"];
      const outcomes = outcomesRaw
        ? Array.isArray(outcomesRaw) ? outcomesRaw as string[] : [outcomesRaw as string]
        : undefined;

      const legalIssuesRaw = req.query["legalIssues[]"];
      const legalIssues = legalIssuesRaw
        ? Array.isArray(legalIssuesRaw) ? legalIssuesRaw as string[] : [legalIssuesRaw as string]
        : undefined;

      const keywordsRaw = req.query["keywords[]"];
      const keywords = keywordsRaw
        ? Array.isArray(keywordsRaw) ? keywordsRaw as string[] : [keywordsRaw as string]
        : undefined;
      const keywordMode = (req.query.keywordMode as string) === "OR" ? "OR" : "AND";
      const mustKwRaw = req.query["mustKeywords[]"];
      const mustKeywords = mustKwRaw ? (Array.isArray(mustKwRaw) ? mustKwRaw as string[] : [mustKwRaw as string]) : [];
      const anyKwRaw = req.query["anyKeywords[]"];
      const anyKeywords = anyKwRaw ? (Array.isArray(anyKwRaw) ? anyKwRaw as string[] : [anyKwRaw as string]) : [];

      // Fetch ALL matching cases (no pagination)
      const { cases: allCases, total } = await storage.getCases({
        query: q, jurisdiction, court, dateFrom, dateTo, legalIssue,
        causeOfAction, motionType, motionOutcome, factPattern, attorney,
        outcomes, outcome, legalIssues, keywords, keywordMode, mustKeywords, anyKeywords,
        sortBy: sortBy as any, sortDir: sortDir as any,
        page: 1, pageSize: 500,
      });

      const now = new Date();
      const dateStr = now.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
      const timeStr = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });

      // Build filter summary lines
      const filterLines: string[] = [];
      if (q) filterLines.push(`Query: ${q}`);
      if (jurisdiction) filterLines.push(`Jurisdiction: ${jurisdiction}`);
      if (court) filterLines.push(`Court: ${court}`);
      if (dateFrom || dateTo) filterLines.push(`Date range: ${dateFrom || "any"} – ${dateTo || "any"}`);
      if (legalIssues?.length) filterLines.push(`Legal issues: ${legalIssues.join(", ")}`);
      if (causeOfAction) filterLines.push(`Cause of action: ${causeOfAction}`);
      if (motionType) filterLines.push(`Motion type: ${motionType}`);
      if (motionOutcome) filterLines.push(`Motion outcome: ${motionOutcome}`);
      if (outcomes?.length) filterLines.push(`Outcomes: ${outcomes.join(", ")}`);
      if (keywords?.length) filterLines.push(`Keywords: ${keywords.join(` ${keywordMode} `)}`);

      // Outcome label map
      const outcomeLabel: Record<string, string> = {
        plaintiff: "Plaintiff Wins", defendant: "Defendant Wins",
        mixed: "Mixed / Partial", dismissed: "Dismissed",
        settled: "Settled", pending: "Pending",
      };

      // ── PDF generation ──────────────────────────────────────────────────────
      // Colors (hex)
      const C_NAVY    = "#1B2A4A";
      const C_GOLD    = "#C8860A";
      const C_WHITE   = "#FFFFFF";
      const C_LGRAY   = "#F2F4F8";
      const C_MGRAY   = "#D8DCE4";
      const C_DARK    = "#1C2333";
      const C_MUTED   = "#6B7280";
      const C_BLUE    = "#1A3A6B";
      // Confidentiality label
      const CONFIDENTIALITY_LABELS: Record<string, string> = {
        "attorney-work-product":  "ATTORNEY WORK PRODUCT",
        "privileged-confidential": "PRIVILEGED & CONFIDENTIAL",
        "confidential":            "CONFIDENTIAL",
        "work-product":            "WORK PRODUCT",
      };
      const confLabel = confidentiality ? (CONFIDENTIALITY_LABELS[confidentiality] ?? null) : null;

      // outcome colors
      const outcomeColor = (o: string) => {
        switch (o) {
          case "plaintiff":  return "#166534";
          case "defendant":  return "#991B1B";
          case "mixed":      return "#92400E";
          case "dismissed":  return "#374151";
          default:           return C_MUTED;
        }
      };

      const doc = new PDFDocument({
        size: "LETTER",
        margins: { top: 72, bottom: 72, left: 72, right: 72 },
        info: {
          Title: "LexSearch Citation Report",
          Author: "Perplexity Computer",
          Subject: "Caselaw Citation Report",
          Creator: "LexSearch",
        },
        autoFirstPage: true,
        bufferPages: true,
      });

      const chunks: Buffer[] = [];
      doc.on("data", (chunk: Buffer) => chunks.push(chunk));

      const PAGE_W = doc.page.width;
      const PAGE_H = doc.page.height;
      const MARGIN = 72;
      const INNER_W = PAGE_W - MARGIN * 2;

      // ── Header / Footer helpers (drawn after bufferPages) ──
      // Page index 0 is the cover — skip header/footer on it.
      // Interior pages (index 1+) are numbered starting at 1.
      const addHeaderFooter = () => {
        const range = doc.bufferedPageRange();
        const interiorCount = range.count - 1; // cover doesn't count
        for (let i = 0; i < range.count; i++) {
          doc.switchToPage(range.start + i);
          if (i === 0) continue; // cover page — handled separately
          const pageNum = i;

          // ── Diagonal watermark (drawn first, underneath content) ──
          if (confLabel) {
            doc.save();
            // Translate to page center, rotate 45° counter-clockwise
            doc.translate(PAGE_W / 2, PAGE_H / 2).rotate(-45);
            doc.fontSize(52).font("Helvetica-Bold")
               .fillOpacity(0.055).fillColor(C_NAVY)
               .text(confLabel, -(PAGE_W * 0.6), -26,
                     { width: PAGE_W * 1.2, align: "center", lineBreak: false });
            doc.fillOpacity(1);
            doc.restore();
          }

          // Header rule + label
          doc.save()
            .moveTo(MARGIN, 36).lineTo(PAGE_W - MARGIN, 36)
            .strokeColor(C_MGRAY).lineWidth(0.4).stroke()
            .fontSize(7.5).font("Helvetica").fillColor(C_MUTED)
            .text("LEXSEARCH", MARGIN, 22, { width: INNER_W / 2, lineBreak: false });
          // Confidentiality label in header (right-aligned, small)
          if (confLabel) {
            doc.fontSize(7).font("Helvetica-Bold").fillColor("#7A1F1F")
               .text(confLabel, MARGIN, 22, { align: "right", width: INNER_W, lineBreak: false });
          } else {
            doc.fontSize(7.5).font("Helvetica").fillColor(C_MUTED)
               .text("Citation Report", MARGIN, 22, { align: "right", width: INNER_W, lineBreak: false });
          }
          doc.restore();

          // Footer rule + page number
          doc.save()
            .moveTo(MARGIN, PAGE_H - 46).lineTo(PAGE_W - MARGIN, PAGE_H - 46)
            .strokeColor(C_MGRAY).lineWidth(0.4).stroke()
            .fontSize(7.5).font("Helvetica").fillColor(C_MUTED)
            .text(
              `Generated ${dateStr} at ${timeStr}  ·  Page ${pageNum} of ${interiorCount}`,
              MARGIN, PAGE_H - 36, { align: "center", width: INNER_W }
            )
            .restore();
        }
      };

      // ════════════════════════════════════════════════════════════
      // ── COVER PAGE ──
      // ════════════════════════════════════════════════════════════

      // Full navy top band
      doc.save()
         .rect(0, 0, PAGE_W, 260)
         .fill(C_NAVY)
         .restore();

      // Gold accent stripe at bottom of band
      doc.save()
         .rect(0, 254, PAGE_W, 6)
         .fill(C_GOLD)
         .restore();

      // LexSearch wordmark (top-left of band)
      doc.fontSize(11).font("Helvetica-Bold").fillColor(C_GOLD)
         .text("LEXSEARCH", MARGIN, 36);
      doc.moveDown(0.2);
      doc.fontSize(8).font("Helvetica").fillColor("#8BA3C7")
         .text("Caselaw Research Platform", MARGIN, doc.y);

      // Main title — centered in band
      doc.fontSize(34).font("Helvetica-Bold").fillColor(C_WHITE)
         .text("Citation Report", MARGIN, 110, { width: INNER_W, align: "center" });

      // Subtitle: result count
      doc.fontSize(13).font("Helvetica").fillColor("#8BA3C7")
         .text(
           `${total} case${total !== 1 ? "s" : ""} matched`,
           MARGIN, 158, { width: INNER_W, align: "center" }
         );

      // ── Client / Matter badge (inside navy band, bottom-right) ──
      if (clientName || matterNumber) {
        // Semi-transparent pill anchored bottom-right of band
        const BADGE_W = 220;
        const BADGE_H = matterNumber ? 46 : 30;
        const BADGE_X = PAGE_W - MARGIN - BADGE_W;
        const BADGE_Y = 260 - BADGE_H - 14;
        // Dark navy background
        doc.save()
           .rect(BADGE_X, BADGE_Y, BADGE_W, BADGE_H)
           .fill("#0F1D33")
           .restore();
        // Gold left accent
        doc.save()
           .rect(BADGE_X, BADGE_Y, 3, BADGE_H)
           .fill(C_GOLD)
           .restore();
        if (clientName) {
          doc.fontSize(7).font("Helvetica-Bold").fillColor(C_GOLD)
             .text("CLIENT", BADGE_X + 10, BADGE_Y + 6,
                   { width: BADGE_W - 14, lineBreak: false });
          doc.fontSize(9).font("Helvetica-Bold").fillColor(C_WHITE)
             .text(clientName, BADGE_X + 10, BADGE_Y + 16,
                   { width: BADGE_W - 14, lineBreak: false, ellipsis: true });
        }
        if (matterNumber) {
          const mY = clientName ? BADGE_Y + 28 : BADGE_Y + 6;
          doc.fontSize(7).font("Helvetica").fillColor("#8BA3C7")
             .text(`Matter: ${matterNumber}`, BADGE_X + 10, mY,
                   { width: BADGE_W - 14, lineBreak: false, ellipsis: true });
        }
      }

      // ── Meta block (below band) ──
      // Three-column meta grid when client info present, two-column otherwise
      const META_Y = 296;
      const hasMeta = !!(clientName || matterNumber);
      const COL2 = hasMeta ? INNER_W / 3 - 12 : INNER_W / 2 - 12;

      const metaBox = (x: number, label: string, value: string, w?: number) => {
        const bw = w ?? COL2;
        doc.fontSize(7).font("Helvetica-Bold").fillColor(C_GOLD)
           .text(label, x, META_Y, { width: bw });
        doc.fontSize(10).font("Helvetica").fillColor(C_DARK)
           .text(value, x, META_Y + 14, { width: bw });
      };

      if (hasMeta) {
        const colW3 = INNER_W / 3;
        metaBox(MARGIN,                "GENERATED",    `${dateStr} at ${timeStr}`, colW3 - 8);
        metaBox(MARGIN + colW3,        "CLIENT",        clientName  || "—",        colW3 - 8);
        metaBox(MARGIN + colW3 * 2,    "MATTER",        matterNumber || "—",        colW3 - 8);
      } else {
        metaBox(MARGIN,             "GENERATED",   `${dateStr} at ${timeStr}`);
        metaBox(MARGIN + COL2 + 24, "PREPARED BY",  "LexSearch Research Platform");
      }

      // Thin rule
      doc.save()
         .moveTo(MARGIN, META_Y + 52).lineTo(PAGE_W - MARGIN, META_Y + 52)
         .strokeColor(C_MGRAY).lineWidth(0.5).stroke()
         .restore();

      // ── Search query highlight ──
      if (q) {
        const QY = META_Y + 68;
        doc.fontSize(7).font("Helvetica-Bold").fillColor(C_GOLD)
           .text("SEARCH QUERY", MARGIN, QY);
        // Query pill background
        const qText = q;
        const qBoxH = 32;
        doc.save()
           .rect(MARGIN, QY + 14, INNER_W, qBoxH)
           .fill(C_LGRAY)
           .restore();
        // Gold left accent
        doc.save()
           .rect(MARGIN, QY + 14, 3, qBoxH)
           .fill(C_GOLD)
           .restore();
        doc.fontSize(11).font("Helvetica-Bold").fillColor(C_DARK)
           .text(`"${qText}"`, MARGIN + 12, QY + 20, { width: INNER_W - 16, lineBreak: false, ellipsis: true });
        doc.y = QY + 14 + qBoxH + 16;
      } else {
        doc.y = META_Y + 68;
      }

      // ── Active filters grid ──
      if (filterLines.length > 0) {
        doc.moveDown(0.4);
        doc.fontSize(7).font("Helvetica-Bold").fillColor(C_GOLD)
           .text("ACTIVE FILTERS", MARGIN, doc.y);
        doc.moveDown(0.35);

        // Draw filters as a two-column pill grid
        const PILL_H = 22;
        const PILL_GAP_X = 10;
        const PILL_GAP_Y = 6;
        const PILL_COL_W = (INNER_W - PILL_GAP_X) / 2;

        // Pair filter lines into rows of 2 (or 1 for the last if odd)
        const filterPairs: [string, string | null][] = [];
        for (let fi = 0; fi < filterLines.length; fi += 2) {
          filterPairs.push([filterLines[fi], filterLines[fi + 1] ?? null]);
        }

        filterPairs.forEach(([left, right]) => {
          const pY = doc.y;
          // Left pill
          doc.save().rect(MARGIN, pY, PILL_COL_W, PILL_H).fill(C_LGRAY).restore();
          doc.save().rect(MARGIN, pY, 3, PILL_H).fill(C_NAVY).restore();
          doc.fontSize(8).font("Helvetica").fillColor(C_DARK)
             .text(left, MARGIN + 8, pY + 7,
                   { width: PILL_COL_W - 12, lineBreak: false, ellipsis: true });
          // Right pill
          if (right) {
            const rx = MARGIN + PILL_COL_W + PILL_GAP_X;
            doc.save().rect(rx, pY, PILL_COL_W, PILL_H).fill(C_LGRAY).restore();
            doc.save().rect(rx, pY, 3, PILL_H).fill(C_NAVY).restore();
            doc.fontSize(8).font("Helvetica").fillColor(C_DARK)
               .text(right, rx + 8, pY + 7,
                     { width: PILL_COL_W - 12, lineBreak: false, ellipsis: true });
          }
          doc.y = pY + PILL_H + PILL_GAP_Y;
        });
        doc.moveDown(0.4);
      }

      // ── Attorney Notes / Comments ──
      if (comments?.trim()) {
        doc.moveDown(0.5);
        doc.fontSize(7).font("Helvetica-Bold").fillColor(C_GOLD)
           .text("ATTORNEY NOTES", MARGIN, doc.y);
        doc.moveDown(0.3);
        const notesBoxY = doc.y;
        doc.save()
           .rect(MARGIN, notesBoxY - 4, INNER_W, 4)
           .fill(C_GOLD)
           .restore();
        doc.save()
           .rect(MARGIN, notesBoxY, INNER_W, 60)
           .fill(C_LGRAY)
           .restore();
        doc.save()
           .rect(MARGIN, notesBoxY, 3, 60)
           .fill(C_NAVY)
           .restore();
        doc.fontSize(8.5).font("Helvetica").fillColor(C_DARK)
           .text(comments.trim(), MARGIN + 10, notesBoxY + 8, {
             width: INNER_W - 18,
             height: 44,
             ellipsis: true,
             lineBreak: true,
           });
        doc.y = notesBoxY + 68;
      }

      // ── Result summary stats bar ──
      {
        // Count outcomes
        const outcomeCounts: Record<string, number> = {};
        allCases.forEach(c => {
          outcomeCounts[c.outcome] = (outcomeCounts[c.outcome] ?? 0) + 1;
        });
        const statEntries = Object.entries(outcomeCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 4);

        const statsY = Math.max(doc.y + 8, PAGE_H - MARGIN - 120);

        // Stats band background
        const STATS_H = 64;
        doc.save()
           .rect(MARGIN, statsY, INNER_W, STATS_H)
           .fill(C_LGRAY)
           .restore();
        // Top gold rule
        doc.save()
           .rect(MARGIN, statsY, INNER_W, 2)
           .fill(C_GOLD)
           .restore();

        // Total cases stat (always shown)
        const allStats: [string, string][] = [
          [String(total), `Total Case${total !== 1 ? "s" : ""}`],
          ...statEntries.map(([k, v]) => [
            String(v),
            outcomeLabel[k] ?? k,
          ] as [string, string]),
        ];
        const statCols = Math.min(allStats.length, 4);
        const statColW = INNER_W / statCols;

        allStats.slice(0, 4).forEach(([val, lbl], si) => {
          const sx = MARGIN + si * statColW;
          // Vertical divider between stats (not before first)
          if (si > 0) {
            doc.save()
               .moveTo(sx, statsY + 10).lineTo(sx, statsY + STATS_H - 10)
               .strokeColor(C_MGRAY).lineWidth(0.5).stroke()
               .restore();
          }
          doc.fontSize(22).font("Helvetica-Bold").fillColor(C_NAVY)
             .text(val, sx, statsY + 10, { width: statColW, align: "center", lineBreak: false });
          doc.fontSize(7.5).font("Helvetica").fillColor(C_MUTED)
             .text(lbl, sx, statsY + 38, { width: statColW, align: "center", lineBreak: false });
        });
        doc.y = statsY + STATS_H;
      }

      // ── Confidentiality banner on cover (full-width ribbon above footer) ──
      if (confLabel) {
        const RIBBON_H = 28;
        const RIBBON_Y = PAGE_H - 90;
        // Deep red/maroon background
        doc.save()
           .rect(0, RIBBON_Y, PAGE_W, RIBBON_H)
           .fill("#6B1F1F")
           .restore();
        // Thin gold rule above ribbon
        doc.save()
           .rect(0, RIBBON_Y, PAGE_W, 2)
           .fill(C_GOLD)
           .restore();
        // Label centered
        doc.fontSize(9).font("Helvetica-Bold").fillColor(C_WHITE)
           .text(confLabel, 0, RIBBON_Y + 9,
                 { width: PAGE_W, align: "center", lineBreak: false });
      }

      // ── Cover footer note ──
      doc.save()
         .moveTo(MARGIN, PAGE_H - 48).lineTo(PAGE_W - MARGIN, PAGE_H - 48)
         .strokeColor(C_MGRAY).lineWidth(0.4).stroke()
         .restore();
      doc.fontSize(7.5).font("Helvetica").fillColor(C_MUTED)
         .text(
           "This report was generated by LexSearch and is intended for legal research purposes only. " +
           "Always verify citations independently before relying on them in legal proceedings.",
           MARGIN, PAGE_H - 38, { width: INNER_W, align: "center" }
         );

      // ════════════════════════════════════════════════════════════
      // ── CONTENT PAGES (template-specific) ──
      // ════════════════════════════════════════════════════════════

      // Shared helpers
      const drawTableHeader = (cols: [string, number, "left"|"right"|"center"][], colWidths: number[], rowH: number) => {
        let tx = MARGIN;
        const headerY = doc.y;
        colWidths.forEach((w, ci) => {
          doc.save().rect(tx, headerY, w, rowH).fill(C_NAVY).restore();
          doc.fontSize(8).font("Helvetica-Bold").fillColor(C_WHITE)
             .text(cols[ci][0], tx + 5, headerY + 5,
                   { width: w - 10, align: cols[ci][2], lineBreak: false });
          tx += w;
        });
        doc.y = headerY + rowH;
      };

      // ─────────────────────────────────────────────────────────────
      // EXECUTIVE SUMMARY: compact table only
      // ─────────────────────────────────────────────────────────────
      if (template === "executive") {
        doc.addPage();
        doc.fontSize(16).font("Helvetica-Bold").fillColor(C_DARK)
           .text("Executive Summary", MARGIN, MARGIN + 16);
        doc.moveDown(0.25);
        doc.save()
           .moveTo(MARGIN, doc.y).lineTo(MARGIN + 140, doc.y)
           .strokeColor(C_GOLD).lineWidth(2).stroke()
           .restore();
        doc.moveDown(0.6);

        const EXEC_COLS: [string, number, "left"|"right"|"center"][] = [
          ["#",            0.04, "right"],
          ["Citation",     0.18, "left"],
          ["Case Name",    0.28, "left"],
          ["Court",        0.18, "left"],
          ["Year",         0.07, "center"],
          ["Outcome",      0.13, "left"],
          ["Legal Issue",  0.12, "left"],
        ];
        const execColW = EXEC_COLS.map(([,r]) => Math.floor(INNER_W * r));
        const EXEC_ROW_H = 22;
        drawTableHeader(EXEC_COLS, execColW, EXEC_ROW_H);

        allCases.forEach((c, idx) => {
          if (doc.y + EXEC_ROW_H > PAGE_H - MARGIN - 50) {
            doc.addPage();
            drawTableHeader(EXEC_COLS, execColW, EXEC_ROW_H);
          }
          const rowFill = idx % 2 === 0 ? C_WHITE : C_LGRAY;
          const oLabel  = outcomeLabel[c.outcome] ?? c.outcome;
          const oColor  = outcomeColor(c.outcome);
          const legalIssueShort = (c.legalIssue ?? "").split("–").pop()?.trim().slice(0, 28) ?? "";
          const values  = [String(idx+1), c.citation, c.caseName, c.court, c.date.slice(0,4), oLabel, legalIssueShort];
          const colors  = [C_MUTED, C_BLUE, C_DARK, C_DARK, C_DARK, oColor, C_MUTED];
          const fonts   = ["Helvetica","Courier","Helvetica-Bold","Helvetica","Helvetica","Helvetica-Bold","Helvetica"];
          const rowY = doc.y;
          let rx = MARGIN;
          execColW.forEach((w, ci) => {
            doc.save().rect(rx, rowY, w, EXEC_ROW_H).fill(rowFill).restore();
            doc.save().moveTo(rx, rowY+EXEC_ROW_H).lineTo(rx+w, rowY+EXEC_ROW_H)
               .strokeColor(C_MGRAY).lineWidth(0.3).stroke().restore();
            doc.fontSize(8).font(fonts[ci]).fillColor(colors[ci])
               .text(values[ci], rx+5, rowY+5, { width: w-10, align: EXEC_COLS[ci][2], lineBreak: false, ellipsis: true });
            rx += w;
          });
          doc.y = rowY + EXEC_ROW_H;
        });

        doc.moveDown(0.5);
        doc.fontSize(8).font("Helvetica-Oblique").fillColor(C_MUTED)
           .text(`Showing ${allCases.length} of ${total} case${total !== 1 ? "s" : ""}${total > 500 ? " (capped at 500)" : ""}`);
      }

      // ─────────────────────────────────────────────────────────────
      // STANDARD + DETAILED: citation table + case summaries
      // ─────────────────────────────────────────────────────────────
      if (template === "standard" || template === "detailed") {
        doc.addPage();
        doc.fontSize(14).font("Helvetica-Bold").fillColor(C_DARK)
           .text("Citation Table", MARGIN, MARGIN + 16);
        doc.moveDown(0.5);

        const COLS: [string, number, "left"|"right"|"center"][] = [
          ["#",           0.04, "right"],
          ["Citation",    0.17, "left"],
          ["Case Name",   0.34, "left"],
          ["Court",       0.22, "left"],
          ["Year",        0.08, "center"],
          ["Outcome",     0.15, "left"],
        ];
        const colW = COLS.map(([,r]) => Math.floor(INNER_W * r));
        const ROW_H = 22;
        drawTableHeader(COLS, colW, ROW_H);

        allCases.forEach((c, idx) => {
          if (doc.y + ROW_H > PAGE_H - MARGIN - 50) {
            doc.addPage();
            drawTableHeader(COLS, colW, ROW_H);
          }
          const rowFill = idx % 2 === 0 ? C_WHITE : C_LGRAY;
          const oLabel  = outcomeLabel[c.outcome] ?? c.outcome;
          const oColor  = outcomeColor(c.outcome);
          const rowY = doc.y;
          const values = [String(idx+1), c.citation, c.caseName, c.court, c.date.slice(0,4), oLabel];
          const colors = [C_MUTED, C_BLUE, C_DARK, C_DARK, C_DARK, oColor];
          const fonts  = ["Helvetica","Courier","Helvetica-Bold","Helvetica","Helvetica","Helvetica-Bold"];
          let rx = MARGIN;
          colW.forEach((w, ci) => {
            doc.save().rect(rx, rowY, w, ROW_H).fill(rowFill).restore();
            doc.save().moveTo(rx, rowY+ROW_H).lineTo(rx+w, rowY+ROW_H)
               .strokeColor(C_MGRAY).lineWidth(0.3).stroke().restore();
            doc.fontSize(8).font(fonts[ci]).fillColor(colors[ci])
               .text(values[ci], rx+5, rowY+5,
                     { width: w-10, align: COLS[ci][2], lineBreak: false, ellipsis: true });
            rx += w;
          });
          doc.y = rowY + ROW_H;
        });

        doc.moveDown(0.5);
        doc.fontSize(8).font("Helvetica-Oblique").fillColor(C_MUTED)
           .text(`Showing ${allCases.length} of ${total} matching case${total !== 1 ? "s" : ""}${total > 500 ? " (capped at 500)" : ""}`);

        // ── Case Summaries section ──
        if (allCases.length > 0) {
          doc.addPage();
          const sectionTitle = template === "detailed" ? "Detailed Case Briefs" : "Batch Case Summaries";
          doc.fontSize(18).font("Helvetica-Bold").fillColor(C_DARK)
             .text(sectionTitle, MARGIN, MARGIN);
          doc.moveDown(0.2);
          doc.save()
             .moveTo(MARGIN, doc.y).lineTo(MARGIN + 160, doc.y)
             .strokeColor(C_GOLD).lineWidth(2).stroke()
             .restore();
          doc.moveDown(0.8);

          allCases.forEach((c, idx) => {
            let holdings: string[] = [];
            try { holdings = JSON.parse(c.holdings); } catch { holdings = []; }
            const firstHolding  = holdings[0] ?? "";
            const secondHolding = holdings[1] ?? "";
            const rawFact = c.factPattern ?? "";
            // Standard: short snippet; Detailed: full fact pattern
            const factSnippet = template === "detailed"
              ? rawFact
              : (rawFact.length > 220 ? rawFact.slice(0, 220).trimEnd() + "…" : rawFact);
            const oLabel = outcomeLabel[c.outcome] ?? c.outcome;
            const oColor = outcomeColor(c.outcome);

            let plaintiffAttorneys: string[] = [];
            let defendantAttorneys: string[] = [];
            try { plaintiffAttorneys = JSON.parse(c.plaintiffAttorneys ?? "[]"); } catch { plaintiffAttorneys = []; }
            try { defendantAttorneys = JSON.parse(c.defendantAttorneys ?? "[]"); } catch { defendantAttorneys = []; }

            const estimatedH = 100
              + (firstHolding ? 30 : 0) + (secondHolding ? 20 : 0)
              + (factSnippet ? Math.min(factSnippet.length / 4, 120) : 0)
              + (template === "detailed" ? 50 : 0);
            if (doc.y + estimatedH > PAGE_H - MARGIN - 50) doc.addPage();

            const blockY = doc.y;
            const textX  = MARGIN + 14;
            const textW  = INNER_W - 14;

            doc.fontSize(7.5).font("Helvetica-Bold").fillColor(C_MUTED)
               .text(`${idx + 1}.`, MARGIN + 4, blockY + 2, { width: 20, lineBreak: false });
            doc.fontSize(10).font("Helvetica-Bold").fillColor(C_NAVY)
               .text(c.caseName, textX, blockY, { width: textW });
            doc.moveDown(0.15);

            doc.fontSize(8).font("Courier").fillColor(C_BLUE)
               .text(c.citation, textX, doc.y, { continued: true });
            doc.font("Helvetica").fillColor(C_MUTED)
               .text(`  ·  ${c.court}  ·  ${c.date.slice(0, 4)}  `, { continued: true });
            doc.font("Helvetica-Bold").fillColor(oColor)
               .text(oLabel);
            doc.moveDown(0.3);

            // Detailed: motion outcome + attorneys
            if (template === "detailed") {
              if (c.motionType || c.motionOutcome) {
                const motionStr = [c.motionType, c.motionOutcome].filter(Boolean).join(" → ");
                doc.fontSize(8).font("Helvetica-Bold").fillColor(C_GOLD)
                   .text("MOTION", textX, doc.y, { continued: true });
                doc.font("Helvetica").fillColor(C_DARK)
                   .text(`  ${motionStr}`);
                doc.moveDown(0.2);
              }
              if (plaintiffAttorneys.length || defendantAttorneys.length) {
                if (plaintiffAttorneys.length) {
                  doc.fontSize(8).font("Helvetica-Bold").fillColor(C_GOLD)
                     .text("PLAINTIFF COUNSEL", textX, doc.y, { continued: true });
                  doc.font("Helvetica").fillColor(C_DARK)
                     .text(`  ${plaintiffAttorneys.join(", ")}`, { width: textW });
                  doc.moveDown(0.15);
                }
                if (defendantAttorneys.length) {
                  doc.fontSize(8).font("Helvetica-Bold").fillColor(C_GOLD)
                     .text("DEFENDANT COUNSEL", textX, doc.y, { continued: true });
                  doc.font("Helvetica").fillColor(C_DARK)
                     .text(`  ${defendantAttorneys.join(", ")}`, { width: textW });
                  doc.moveDown(0.15);
                }
                doc.moveDown(0.15);
              }
            }

            if (firstHolding) {
              doc.fontSize(8).font("Helvetica-Bold").fillColor(C_GOLD)
                 .text("HOLDING", textX, doc.y);
              doc.moveDown(0.1);
              doc.fontSize(9).font("Helvetica").fillColor(C_DARK)
                 .text(firstHolding, textX, doc.y, { width: textW });
              if (secondHolding) {
                doc.moveDown(0.1);
                doc.fontSize(9).font("Helvetica").fillColor(C_DARK)
                   .text(secondHolding, textX, doc.y, { width: textW });
              }
              doc.moveDown(0.3);
            }

            if (factSnippet) {
              doc.fontSize(8).font("Helvetica-Bold").fillColor(C_GOLD)
                 .text("FACT PATTERN", textX, doc.y);
              doc.moveDown(0.1);
              doc.fontSize(9).font("Helvetica-Oblique").fillColor(C_MUTED)
                 .text(factSnippet, textX, doc.y, { width: textW });
              doc.moveDown(0.3);
            }

            const blockEndY = doc.y;
            doc.save()
               .rect(MARGIN, blockY, 3, blockEndY - blockY)
               .fill(C_NAVY)
               .restore();
            doc.save()
               .moveTo(MARGIN, blockEndY + 4).lineTo(PAGE_W - MARGIN, blockEndY + 4)
               .strokeColor(C_MGRAY).lineWidth(0.4).stroke()
               .restore();
            doc.y = blockEndY + 12;
          });
        }
      }

      // ── Finalize: stamp headers/footers on all pages ──
      addHeaderFooter();
      doc.end();

      await new Promise<void>((resolve) => doc.on("end", resolve));
      const pdfBuf = Buffer.concat(chunks);

      const filename = `LexSearch-Citation-Report-${now.toISOString().slice(0, 10)}.pdf`;
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.setHeader("Content-Length", pdfBuf.length);
      res.send(pdfBuf);
    } catch (err) {
      console.error("Citation report error:", err);
      res.status(500).json({ error: "Failed to generate report" });
    }
  });

  // Get saved searches
  app.get("/api/saved-searches", async (_req, res) => {
    res.json(await storage.getSavedSearches());
  });

  // Create saved search
  app.post("/api/saved-searches", async (req, res) => {
    const { name, query, filters, confidentiality } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });
    const saved = await storage.createSavedSearch({
      name,
      query: query ?? "",
      filters: JSON.stringify(filters || {}),
      confidentiality: confidentiality ?? "none",
      createdAt: new Date().toISOString(),
    });
    res.json(saved);
  });

  // Delete saved search
  // PATCH /api/saved-searches/:id — update filters in-place (no delete+recreate, ID stays the same)
  app.patch("/api/saved-searches/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
      const { filters } = req.body;
      if (filters === undefined) return res.status(400).json({ error: "filters required" });
      const updated = await storage.updateSavedSearch(id, JSON.stringify(filters));
      if (!updated) return res.status(404).json({ error: "Not found" });
      res.json(updated);
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  app.delete("/api/saved-searches/:id", async (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
    await storage.deleteSavedSearch(id);
    res.json({ success: true });
  });

  // ─── Cluster Presets ────────────────────────────────────────
  app.get("/api/cluster-presets", async (_req, res) => {
    res.json(await storage.getClusterPresets());
  });

  app.post("/api/cluster-presets", async (req, res) => {
    const { name, cluster, keywords, kwSearch } = req.body;
    if (!name || !cluster) return res.status(400).json({ error: "name and cluster required" });
    const preset = await storage.createClusterPreset({
      name,
      cluster,
      keywords: JSON.stringify(keywords || []),
      kwSearch: kwSearch || "",
      createdAt: new Date().toISOString(),
    });
    res.json(preset);
  });

  app.delete("/api/cluster-presets/:id", async (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
    await storage.deleteClusterPreset(id);
    res.json({ success: true });
  });

  // Stats endpoint

// ─── Keyword Cluster Taxonomy ───────────────────────────────
// Maps lowercase keyword fragments → cluster label.
// First match wins (order matters — more specific first).
const CLUSTER_RULES: { pattern: RegExp; cluster: string }[] = [
  // Statutory / Code Citations
  { pattern: /\b(u\.s\.c|section \d|§|usc|cfaa|fcra|tcpa|dtsa|frand|fosta|tvpa|aks|faa|ada|title iii|rule 9|finra|sro|sherman act|false claims|qui tam|medicare|upcoding|kickback|dcma|dmca|section 512|section 365|chapter 11|section 101|section 230|alice\/mayo)\b/i, cluster: "Statutory & Regulatory" },
  // Constitutional issues
  { pattern: /\b(first amendment|due process|article iii|bivens|qualified immunity|strict scrutiny|compelled speech|constitutional|associational|standing|preemption|immunity|sovereign)\b/i, cluster: "Constitutional Issues" },
  // IP & Technology
  { pattern: /\b(copyright|patent|trademark|trade secret|fair use|dmca|safe harbor|section 512|alice|abstract idea|software patent|mayo|eligib|misappropriation|ip license|transformative|warhol|goldsmith|prince|commercial use|market harm|standard-essential|frand|llm|gpt|ai|openai|training data|generative|web scraping|data access|digital access|screen reader|aria|accessibility)\b/i, cluster: "IP & Technology" },
  // Parties / Named entities
  { pattern: /\b(twitter|linkedin|facebook|google|microsoft|openai|robinhood|hiq|at&t|concepcion|transunion|ramirez|warhol|goldsmith|new york times|x corp|media matters|duguid|gamestop|303 creative|nyt|apple|amazon|meta)\b/i, cluster: "Parties" },
  // Procedure & Remedies (includes courts, jurisdictions, outcomes)
  { pattern: /\b(class action|arbitration|injunction|tro|preliminary injunction|venue|anti-slapp|rule 9|standing|class action waiver|unconscionability|consumer contract|preemption|arbitr|discovery|certiorari|remand|motion to dismiss|summary judgment|waiver|qui tam|sanctions|due process|supreme court|circuit court|district court|court of appeals|federal circuit|ninth circuit|second circuit|third circuit|fourth circuit|fifth circuit|sixth circuit|seventh circuit|eighth circuit|tenth circuit|eleventh circuit|d\.c\. circuit|appellate|en banc|jurisdiction|docket|per curiam|rehearing|mandate|defendant wins|plaintiff wins|dismissal|dismiss|jmol|judgment as a matter|directed verdict|default judgment|bench trial|jury verdict|settlement|damages|attorney.s fees|attorney fees|costs awarded|affirmed|reversed|vacated|remanded|overruled)\b/i, cluster: "Procedure & Remedies" },
  // Business & Antitrust
  { pattern: /\b(antitrust|tying|market power|per se|sherman|patent misuse|patent license|bankruptcy|automatic stay|executory|chapter 11|section 365|saas|platform liabilit|secondary liabilit|payment processor|trade secret|misappropriation|tortious interference|defamation|anti-slapp)\b/i, cluster: "Business & Antitrust" },
  // Civil Rights & Social
  { pattern: /\b(lgbtq|disability|ada|title iii|public accommodation|sex trafficking|csam|fosta|election|ballot|civil rights|discrimination|harassment|compelled speech|expressive|wedding|colorado)\b/i, cluster: "Civil Rights & Social" },
  // Telecom / Digital Platforms
  { pattern: /\b(section 230|platform|autodialer|atds|text message|tcpa|random number|5g|lte|semiconductor|digital|web |online|internet|app |software|saas|llm|ai |gpt|training data)\b/i, cluster: "Telecom & Platforms" },
];

const CLUSTER_OTHER = "Other";

function assignCluster(keyword: string): string {
  const lower = keyword.toLowerCase();
  for (const { pattern, cluster } of CLUSTER_RULES) {
    if (pattern.test(lower)) return cluster;
  }
  return CLUSTER_OTHER;
}
// ──────────────────────────────────────────────────────────────

  app.get("/api/keyword-cloud", async (req, res) => {
    // Re-use the same filter parsing as /api/cases
    const q = req.query.q as string;
    const jurisdiction = req.query.jurisdiction as string;
    const court = req.query.court as string;
    const dateFrom = req.query.dateFrom as string;
    const dateTo = req.query.dateTo as string;
    const legalIssue = req.query.legalIssue as string;
    const causeOfAction = req.query.causeOfAction as string;
    const motionType = req.query.motionType as string;
    const motionOutcome = req.query.motionOutcome as string;
    const factPattern = req.query.factPattern as string;
    const attorney = req.query.attorney as string;

    const outcomesRaw2 = req.query["outcomes[]"];
    const outcomes2 = outcomesRaw2
      ? Array.isArray(outcomesRaw2) ? outcomesRaw2 as string[] : [outcomesRaw2 as string]
      : undefined;

    const legalIssuesRaw3 = req.query["legalIssues[]"];
    const legalIssues3 = legalIssuesRaw3
      ? Array.isArray(legalIssuesRaw3) ? legalIssuesRaw3 as string[] : [legalIssuesRaw3 as string]
      : undefined;

    const keywordsRaw2 = req.query["keywords[]"];
    const keywords2 = keywordsRaw2
      ? Array.isArray(keywordsRaw2) ? keywordsRaw2 as string[] : [keywordsRaw2 as string]
      : undefined;

    const keywordMode2 = (req.query.keywordMode as string) === "OR" ? "OR" : "AND";
    const mustKwRaw2 = req.query["mustKeywords[]"];
    const mustKeywords2 = mustKwRaw2 ? (Array.isArray(mustKwRaw2) ? mustKwRaw2 as string[] : [mustKwRaw2 as string]) : [];
    const anyKwRaw2 = req.query["anyKeywords[]"];
    const anyKeywords2 = anyKwRaw2 ? (Array.isArray(anyKwRaw2) ? anyKwRaw2 as string[] : [anyKwRaw2 as string]) : [];

    // Fetch all matching cases (no pagination)
    const { cases: matchedCases } = await storage.getCases({
      query: q, jurisdiction, court, dateFrom, dateTo,
      legalIssue, legalIssues: legalIssues3, causeOfAction, motionType, motionOutcome,
      factPattern, attorney, outcomes: outcomes2,
      keywords: keywords2, keywordMode: keywordMode2 as "AND" | "OR", mustKeywords: mustKeywords2, anyKeywords: anyKeywords2,
      page: 1, pageSize: 1000,
    });

    // Aggregate keyword frequencies across the result set
    const freq: Record<string, number> = {};
    for (const c of matchedCases) {
      try {
        const kws: string[] = JSON.parse(c.keywords || "[]");
        for (const kw of kws) {
          const k = kw.trim();
          if (k) freq[k] = (freq[k] || 0) + 1;
        }
      } catch { /* ignore parse errors */ }
    }

    // Sort by frequency descending, return top 40
    const cloud = Object.entries(freq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 40)
      .map(([keyword, count]) => ({ keyword, count, cluster: assignCluster(keyword) }));

    res.json({ cloud, total: matchedCases.length });
  });

  // ─── Facets endpoint ────────────────────────────────────────────────────
  // Returns distinct values + counts for court, outcome, motionType
  // Optionally scoped to the current search/filter result set
  app.get("/api/facets", async (req, res) => {
    try {
      const {
        q, jurisdiction, court, dateFrom, dateTo,
        causeOfAction, motionType, motionOutcome, attorney,
      } = req.query as Record<string, string>;

      const outcomesRaw = req.query["outcomes[]"];
      const outcomes = outcomesRaw
        ? Array.isArray(outcomesRaw) ? outcomesRaw as string[] : [outcomesRaw as string]
        : undefined;
      const legalIssuesRaw = req.query["legalIssues[]"];
      const legalIssues = legalIssuesRaw
        ? Array.isArray(legalIssuesRaw) ? legalIssuesRaw as string[] : [legalIssuesRaw as string]
        : undefined;
      const keywordsRaw = req.query["keywords[]"];
      const keywords = keywordsRaw
        ? Array.isArray(keywordsRaw) ? keywordsRaw as string[] : [keywordsRaw as string]
        : undefined;
      const keywordMode = (req.query.keywordMode as string) === "OR" ? "OR" : "AND";
      const mustKwRaw = req.query["mustKeywords[]"];
      const mustKeywords = mustKwRaw ? (Array.isArray(mustKwRaw) ? mustKwRaw as string[] : [mustKwRaw as string]) : [];
      const anyKwRaw = req.query["anyKeywords[]"];
      const anyKeywords = anyKwRaw ? (Array.isArray(anyKwRaw) ? anyKwRaw as string[] : [anyKwRaw as string]) : [];

      // Fetch up to 500 matched cases then aggregate in JS
      // (avoids complex dynamic SQL while staying fast for our dataset size)
      const { cases: matched } = await storage.getCases({
        query: q, jurisdiction, court, dateFrom, dateTo,
        causeOfAction, motionType, motionOutcome, attorney,
        outcomes, legalIssues, keywords, keywordMode, mustKeywords, anyKeywords,
        page: 1, pageSize: 500,
      });

      const tally = (key: keyof typeof matched[0]) => {
        const counts: Record<string, number> = {};
        matched.forEach(c => {
          const v = (c[key] as string) ?? "";
          if (v) counts[v] = (counts[v] ?? 0) + 1;
        });
        return Object.entries(counts)
          .sort((a, b) => b[1] - a[1])
          .map(([value, count]) => ({ value, count }));
      };

      res.json({
        courts:      tally("court"),
        outcomes:    tally("outcome"),
        motionTypes: tally("motionType"),
      });
    } catch (err) {
      console.error("Facets error:", err);
      res.status(500).json({ error: "Failed to load facets" });
    }
  });

  app.get("/api/stats", async (_req, res) => {
    const [{ cases: allCases }, { total }] = await Promise.all([
      storage.getCases({ pageSize: 1000 }),
      storage.getCases({ pageSize: 1 }),
    ]);
    const jurisdictions = [...new Set(allCases.map(c => c.jurisdiction))].sort();
    const courts = [...new Set(allCases.map(c => c.court))].sort();
    const legalIssuesRaw2 = allCases.map(c => c.legalIssue);
    const legalIssues = [...new Set([
      ...legalIssuesRaw2,
      ...legalIssuesRaw2.flatMap(iss => iss.split(/\s*[\u2013\-]\s*/).map((s: string) => s.trim()).filter(Boolean))
    ])].sort();
    const causeOfActions = [...new Set(allCases.map(c => c.causeOfAction))].sort();
    const motionTypes = [...new Set(allCases.map(c => c.motionType))].sort();
    const outcomes = [...new Set(allCases.map(c => c.outcome))].sort();
    res.json({ total, jurisdictions, courts, legalIssues, causeOfActions, motionTypes, outcomes });
  });

  // ────────────────────────────────────────────────────────────────────
  // Research Lists (Playlist) — CRUD + share
  // ────────────────────────────────────────────────────────────────────

  // GET /api/lists — all lists with case count
  app.get("/api/lists", async (_req, res) => {
    try {
      const rows = await db
        .select({
          id:        caseLists.id,
          name:      caseLists.name,
          createdAt: caseLists.createdAt,
          caseCount: sql<number>`cast(count(${caseListItems.id}) as int)`,
        })
        .from(caseLists)
        .leftJoin(caseListItems, eq(caseListItems.listId, caseLists.id))
        .groupBy(caseLists.id)
        .orderBy(sql`${caseLists.createdAt} desc`);
      res.json(rows);
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // POST /api/lists — create list { name }
  app.post("/api/lists", async (req, res) => {
    try {
      const { name } = req.body;
      if (!name?.trim()) return res.status(400).json({ error: "name required" });
      const [row] = await db.insert(caseLists).values({ name: name.trim() }).returning();
      res.json(row);
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // PATCH /api/lists/:id — rename { name }
  app.patch("/api/lists/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const { name } = req.body;
      if (!name?.trim()) return res.status(400).json({ error: "name required" });
      const [row] = await db.update(caseLists).set({ name: name.trim() }).where(eq(caseLists.id, id)).returning();
      if (!row) return res.status(404).json({ error: "not found" });
      res.json(row);
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // DELETE /api/lists/:id — delete list (cascade deletes items)
  app.delete("/api/lists/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      await db.delete(caseLists).where(eq(caseLists.id, id));
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // GET /api/lists/:id/cases — full case objects for list
  app.get("/api/lists/:id/cases", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const [list] = await db.select().from(caseLists).where(eq(caseLists.id, id));
      if (!list) return res.status(404).json({ error: "not found" });
      const items = await db
        .select({ case: cases, position: caseListItems.position, addedAt: caseListItems.addedAt, comment: caseListItems.comment })
        .from(caseListItems)
        .innerJoin(cases, eq(cases.id, caseListItems.caseId))
        .where(eq(caseListItems.listId, id))
        .orderBy(caseListItems.position, caseListItems.addedAt);
      res.json({ list, cases: items.map(r => ({ ...r.case, addedAt: r.addedAt, position: r.position, comment: r.comment ?? "" })) });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // POST /api/lists/:id/items — add case { caseId }
  app.post("/api/lists/:id/items", async (req, res) => {
    try {
      const listId = parseInt(req.params.id);
      const { caseId } = req.body;
      if (!caseId) return res.status(400).json({ error: "caseId required" });
      // get current max position
      const [{ maxPos }] = await db
        .select({ maxPos: sql<number>`coalesce(max(${caseListItems.position}), -1)` })
        .from(caseListItems).where(eq(caseListItems.listId, listId));
      const [row] = await db.insert(caseListItems)
        .values({ listId, caseId: parseInt(caseId), position: (maxPos ?? -1) + 1 })
        .onConflictDoNothing()
        .returning();
      res.json(row ?? { ok: true, duplicate: true });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // PATCH /api/lists/:id/items/:caseId — update comment
  app.patch("/api/lists/:id/items/:caseId", async (req, res) => {
    try {
      const listId = parseInt(req.params.id);
      const caseId = parseInt(req.params.caseId);
      const { comment } = req.body;
      if (comment === undefined) return res.status(400).json({ error: "comment required" });
      const [row] = await db
        .update(caseListItems)
        .set({ comment: String(comment) })
        .where(and(eq(caseListItems.listId, listId), eq(caseListItems.caseId, caseId)))
        .returning();
      if (!row) return res.status(404).json({ error: "item not found" });
      res.json(row);
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // DELETE /api/lists/:id/items/:caseId — remove a case from a list
  app.delete("/api/lists/:id/items/:caseId", async (req, res) => {
    try {
      const listId  = parseInt(req.params.id);
      const caseId  = parseInt(req.params.caseId);
      await db.delete(caseListItems).where(
        and(eq(caseListItems.listId, listId), eq(caseListItems.caseId, caseId))
      );
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // POST /api/lists/:id/share — generate short URL for a list
  app.post("/api/lists/:id/share", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const [list] = await db.select().from(caseLists).where(eq(caseLists.id, id));
      if (!list) return res.status(404).json({ error: "not found" });
      const longUrl = `/#/lists/${id}`;
      // reuse short_urls table
      const existing = await db.select().from(shortUrls).where(eq(shortUrls.longUrl, longUrl));
      if (existing.length > 0) return res.json({ code: existing[0].code });
      const code = crypto.randomBytes(4).toString("base64url").slice(0, 6);
      await db.insert(shortUrls).values({ code, longUrl });
      res.json({ code });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  return httpServer;
}
