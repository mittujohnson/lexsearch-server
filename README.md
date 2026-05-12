# LexSearch Server

Express + Drizzle ORM + PostgreSQL API server for the LexSearch caselaw research platform.

## Setup

```bash
npm install
cp .env.example .env
# Edit .env and set DATABASE_URL
```

## Environment Variables

```env
DATABASE_URL=postgresql://postgres:password@localhost:5432/lexsearch1
NODE_ENV=production
```

## Development

```bash
npm run dev       # starts on port 5000
npm run check     # TypeScript type-check
npm run build     # bundle → dist/index.cjs
```

## Deployment (EC2 + PM2)

```bash
npm run build
rsync -az dist/index.cjs ec2-user@<server-ip>:~/lexsearch/dist/
ssh ec2-user@<server-ip> "pm2 restart lexsearch"
```

## Database

- PostgreSQL on localhost:5432/lexsearch1
- Schema managed via Drizzle ORM: `npm run db:push`
- Seed runs automatically on first start (skipped if cases table is non-empty)

## Related Repos

- **Frontend UI:** [lexsearch-ui](https://github.com/mittujohnson/lexsearch-ui)

---

## API Reference

Base URL: `http://localhost:5000`

---

### Cases

#### `GET /api/cases`

Search and filter cases. Returns a paginated result set.

**Query parameters**

| Parameter | Type | Description |
|---|---|---|
| `q` | string | Full-text search query (uses PostgreSQL `websearch_to_tsquery`) |
| `jurisdiction` | string | Exact match, e.g. `Federal`, `9th Circuit` |
| `court` | string | Partial match (ILIKE) |
| `dateFrom` | string | ISO date `YYYY-MM-DD` (inclusive) |
| `dateTo` | string | ISO date `YYYY-MM-DD` (inclusive) |
| `legalIssue` | string | Partial match (legacy single value) |
| `legalIssues[]` | string[] | Multi-select OR; use bracket notation |
| `causeOfAction` | string | Partial match |
| `motionType` | string | Partial match |
| `motionOutcome` | string | Exact match, e.g. `granted`, `denied` |
| `factPattern` | string | Partial match |
| `attorney` | string | Partial match across plaintiff and defendant attorney fields |
| `outcome` | string | Exact match (legacy single value) |
| `outcomes[]` | string[] | Multi-select OR: `plaintiff`, `defendant`, `mixed`, `dismissed`, `settled` |
| `keywords[]` | string[] | Legacy keyword filter (see two-tier system below) |
| `keywordMode` | `AND`\|`OR` | How to combine `keywords[]` (default `AND`) |
| `mustKeywords[]` | string[] | All must match (AND). Takes precedence over `keywords[]` |
| `anyKeywords[]` | string[] | At least one must match (OR). Takes precedence over `keywords[]` |
| `sortBy` | string | `relevance` (default), `date`, `citation_count`, `citation` |
| `sortDir` | string | `asc`, `desc` (default `desc`) |
| `page` | number | Page number (default `1`) |
| `pageSize` | number | Results per page (default `20`) |

**Response**

```json
{
  "cases": [
    {
      "id": 1,
      "citation": "593 U.S. 1 (2021)",
      "caseName": "TransUnion LLC v. Ramirez",
      "court": "U.S. Supreme Court",
      "jurisdiction": "Federal",
      "date": "2021-06-25",
      "outcome": "defendant",
      "legalIssue": "Standing – Article III – FCRA",
      "causeOfAction": "Fair Credit Reporting Act (15 U.S.C. § 1681)",
      "motionType": "Summary Judgment",
      "motionOutcome": "granted",
      "factPattern": "...",
      "plaintiffAttorneys": "[\"Samuel Issacharoff\"]",
      "defendantAttorneys": "[\"Paul Clement\"]",
      "judges": "[\"Kavanaugh, J.\"]",
      "summary": "...",
      "holdings": "[\"To establish Article III standing...\"]",
      "relevanceScore": 96,
      "citationCount": 2103,
      "keywords": "[\"standing\",\"Article III\",\"FCRA\"]",
      "searchVector": null
    }
  ],
  "total": 42
}
```

**Examples**

```bash
# Free-text search
GET /api/cases?q=standing+Article+III&sortBy=relevance

# Multi-select outcomes with keyword filter
GET /api/cases?outcomes[]=plaintiff&outcomes[]=mixed&q=copyright

# Two-tier keyword filter: must include "TCPA" AND at least one of "arbitration" or "class action"
GET /api/cases?mustKeywords[]=TCPA&anyKeywords[]=arbitration&anyKeywords[]=class+action

# Paginated, sorted by date
GET /api/cases?jurisdiction=Federal&sortBy=date&sortDir=desc&page=2&pageSize=10
```

---

#### `GET /api/cases/:id`

Fetch a single case by ID.

```bash
GET /api/cases/7
```

```json
{ "id": 7, "caseName": "...", ... }
```

Returns `404` if not found.

---

### Search Metadata

#### `GET /api/stats`

Returns distinct filter values across the entire dataset, useful for populating dropdowns.

```bash
GET /api/stats
```

```json
{
  "total": 120,
  "jurisdictions": ["9th Circuit", "Federal", "State"],
  "courts": ["U.S. Court of Appeals for the Ninth Circuit", "U.S. Supreme Court"],
  "legalIssues": ["Constitutional Law – Bivens Actions", "Standing – Article III – FCRA"],
  "causeOfActions": ["Civil Rights (42 U.S.C. § 1983)", "Copyright Infringement"],
  "motionTypes": ["Motion to Dismiss", "Summary Judgment"],
  "outcomes": ["defendant", "dismissed", "mixed", "plaintiff", "settled"]
}
```

---

#### `GET /api/outcome-counts`

Returns per-outcome counts for the current filter set (used for faceted checkboxes). Accepts the same filter parameters as `GET /api/cases`, excluding `outcome` and `outcomes[]`.

```bash
GET /api/outcome-counts?q=patent&jurisdiction=Federal
```

```json
[
  { "outcome": "defendant", "count": 18 },
  { "outcome": "plaintiff", "count": 9 },
  { "outcome": "mixed", "count": 4 }
]
```

---

#### `GET /api/facets`

Returns value/count breakdowns for `courts`, `outcomes`, and `motionTypes` across the current filter result set (up to 500 cases). Accepts the same filter parameters as `GET /api/cases`.

```bash
GET /api/facets?q=arbitration
```

```json
{
  "courts": [
    { "value": "U.S. Supreme Court", "count": 5 },
    { "value": "U.S. Court of Appeals for the Ninth Circuit", "count": 3 }
  ],
  "outcomes": [
    { "value": "defendant", "count": 6 },
    { "value": "plaintiff", "count": 2 }
  ],
  "motionTypes": [
    { "value": "Motion to Dismiss", "count": 4 }
  ]
}
```

---

#### `GET /api/keyword-cloud`

Aggregates keyword frequencies across the matching result set and returns the top 40 keywords with cluster labels. Accepts the same filter parameters as `GET /api/cases`.

```bash
GET /api/keyword-cloud?q=TCPA&jurisdiction=Federal
```

```json
{
  "cloud": [
    { "keyword": "arbitration", "count": 12, "cluster": "Procedure & Remedies" },
    { "keyword": "TCPA", "count": 10, "cluster": "Statutory & Regulatory" },
    { "keyword": "class action", "count": 8, "cluster": "Procedure & Remedies" }
  ],
  "total": 34
}
```

Cluster values: `Statutory & Regulatory`, `Constitutional Issues`, `IP & Technology`, `Parties`, `Procedure & Remedies`, `Business & Antitrust`, `Civil Rights & Social`, `Telecom & Platforms`, `Other`.

---

### Saved Searches

#### `GET /api/saved-searches`

```json
[
  {
    "id": 1,
    "name": "TCPA arbitration cases",
    "query": "TCPA",
    "filters": "{\"outcomes\":[\"defendant\"]}",
    "confidentiality": "none",
    "createdAt": "2024-01-15T10:00:00.000Z"
  }
]
```

#### `POST /api/saved-searches`

```json
// Request
{
  "name": "TCPA arbitration cases",
  "query": "TCPA",
  "filters": { "outcomes": ["defendant"] },
  "confidentiality": "attorney-work-product"
}

// Response: saved search object
```

`confidentiality` values: `none`, `confidential`, `privileged-confidential`, `attorney-work-product`, `work-product`.

#### `PATCH /api/saved-searches/:id`

Updates the `filters` field of an existing saved search (preserves ID).

```json
// Request
{ "filters": { "outcomes": ["plaintiff", "mixed"] } }

// Response: updated saved search object
```

#### `DELETE /api/saved-searches/:id`

```json
// Response
{ "success": true }
```

---

### Cluster Presets

Saved keyword cluster configurations for the keyword cloud panel.

#### `GET /api/cluster-presets`

```json
[
  {
    "id": 1,
    "name": "IP Focus",
    "cluster": "IP & Technology",
    "keywords": "[\"patent\",\"copyright\",\"fair use\"]",
    "kwSearch": "patent",
    "createdAt": "2024-01-15T10:00:00.000Z"
  }
]
```

#### `POST /api/cluster-presets`

```json
// Request
{
  "name": "IP Focus",
  "cluster": "IP & Technology",
  "keywords": ["patent", "copyright", "fair use"],
  "kwSearch": "patent"
}

// Response: preset object
```

#### `DELETE /api/cluster-presets/:id`

```json
{ "success": true }
```

---

### URL Shortener

Shortens search state strings (frontend encodes full filter state into the URL).

#### `POST /api/shorten`

```json
// Request
{ "longUrl": "/?q=TCPA&outcomes[]=defendant&page=1" }

// Response
{ "code": "aB3xYz", "shortUrl": "/#/s/aB3xYz" }
```

If the same `longUrl` is submitted again, the existing code is returned.

#### `GET /api/s/:code`

```bash
GET /api/s/aB3xYz
```

```json
{ "longUrl": "/?q=TCPA&outcomes[]=defendant&page=1", "hitCount": 3 }
```

The hit counter increments asynchronously. Returns `404` if the code does not exist.

---

### Research Lists

Named lists of saved cases ("playlists").

#### `GET /api/lists`

```json
[
  { "id": 1, "name": "Key FCRA Cases", "createdAt": "2024-01-15T10:00:00.000Z", "caseCount": 5 }
]
```

#### `POST /api/lists`

```json
// Request
{ "name": "Key FCRA Cases" }

// Response: list object (without caseCount)
```

#### `PATCH /api/lists/:id`

Rename a list.

```json
// Request
{ "name": "Top FCRA Cases" }

// Response: updated list object
```

#### `DELETE /api/lists/:id`

Deletes the list and all its items (cascade).

```json
{ "ok": true }
```

#### `GET /api/lists/:id/cases`

Returns the list metadata and full case objects for every item, ordered by `position` then `addedAt`.

```json
{
  "list": { "id": 1, "name": "Key FCRA Cases", "createdAt": "..." },
  "cases": [
    {
      "id": 7,
      "caseName": "TransUnion LLC v. Ramirez",
      "citation": "593 U.S. 1 (2021)",
      "addedAt": "2024-01-16T09:00:00.000Z",
      "position": 0,
      "comment": "Lead case for standing argument"
    }
  ]
}
```

#### `POST /api/lists/:id/items`

Add a case to a list. Duplicate additions are silently ignored.

```json
// Request
{ "caseId": 7 }

// Response: list item row, or { "ok": true, "duplicate": true }
```

#### `PATCH /api/lists/:id/items/:caseId`

Update the attorney comment on a list item.

```json
// Request
{ "comment": "Key standing precedent — cite in section 2" }

// Response: updated list item row
```

#### `DELETE /api/lists/:id/items/:caseId`

```json
{ "ok": true }
```

#### `POST /api/lists/:id/share`

Generates (or reuses) a short URL for the list. The resolved `longUrl` is `/#/lists/:id`.

```json
// Response
{ "code": "Xk9mQr" }
```

---

### Citation Report Export

#### `GET /api/export/citation-report`

Generates and streams a PDF citation report for the current filter set (up to 500 cases).

Accepts all filter parameters from `GET /api/cases`, plus:

| Parameter | Type | Description |
|---|---|---|
| `template` | string | `standard` (default), `executive`, `detailed` |
| `clientName` | string | Displayed on cover page badge |
| `matterNumber` | string | Displayed on cover page badge |
| `confidentiality` | string | Watermark/ribbon: `confidential`, `privileged-confidential`, `attorney-work-product`, `work-product` |
| `comments` | string | Attorney notes block on cover page |

**Response:** `application/pdf` download.

```bash
GET /api/export/citation-report?q=TCPA&outcomes[]=defendant&template=detailed&clientName=Acme+Corp&confidentiality=attorney-work-product
```

Templates:
- **standard** — citation table + batch case summaries (holding + fact snippet per case)
- **executive** — compact citation table only
- **detailed** — citation table + full case briefs (fact pattern, motion outcome, counsel)
