import "dotenv/config";
import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { execSync } from "child_process";

const app = express();
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

// ── CORS — allow any origin (frontend may be served from Perplexity CDN) ──
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") { res.sendStatus(204); return; }
  next();
});

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      // ── Request line ──────────────────────────────────────────────
      const qs = Object.keys(req.query).length
        ? "\n  PARAMS  " + Object.entries(req.query)
            .flatMap(([k, v]) => Array.isArray(v) ? v.map(val => `${k}=${val}`) : [`${k}=${v}`])
            .join(" | ")
        : "";
      const body = req.method !== "GET" && req.body && Object.keys(req.body).length
        ? "\n  BODY    " + JSON.stringify(req.body).slice(0, 300)
        : "";

      // ── Response summary (avoid dumping huge arrays) ───────────────
      let resSummary = "";
      if (capturedJsonResponse) {
        if (Array.isArray(capturedJsonResponse)) {
          resSummary = `\n  RESP    [array ${capturedJsonResponse.length}]`;
        } else if (capturedJsonResponse.cases) {
          const r = capturedJsonResponse;
          const names = (r.cases as any[]).slice(0, 3).map((c: any) => c.caseName).join(", ");
          resSummary = `\n  RESP    total=${r.total} | ${names}${r.total > 3 ? " …" : ""}`;
        } else if (capturedJsonResponse.cloud) {
          resSummary = `\n  RESP    cloud=${capturedJsonResponse.cloud.length} keywords`;
        } else if (capturedJsonResponse.error || capturedJsonResponse.message) {
          resSummary = `\n  RESP    ${capturedJsonResponse.error ?? capturedJsonResponse.message}`;
        } else {
          resSummary = `\n  RESP    ${JSON.stringify(capturedJsonResponse).slice(0, 200)}`;
        }
      }

      const status = res.statusCode >= 400 ? `⚠ ${res.statusCode}` : `${res.statusCode}`;
      log(`${req.method} ${path}  [${status}]  ${duration}ms${qs}${body}${resSummary}`);
    }
  });

  next();
});

(async () => {
  // Seed database with caselaw records
  try {
    execSync("npx tsx server/seed.ts", { cwd: process.cwd(), stdio: "inherit" });
  } catch (e) {
    console.log("Seed skipped or already done.");
  }

  await registerRoutes(httpServer, app);

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    () => {
      log(`serving on port ${port}`);
    },
  );
})();
