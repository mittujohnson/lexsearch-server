# LexSearch Server

Express + Drizzle ORM + PostgreSQL API server for the LexSearch caselaw research platform.

## Setup

```bash
npm install
cp .env.example .env
# Edit .env and set DATABASE_URL
```

## Environment Variables

Create a `.env` file:

```env
DATABASE_URL=postgresql://postgres:password@localhost:5432/lexsearch1
NODE_ENV=production
```

## Development

```bash
npm run dev
# Server starts on port 5000
```

## Production Build

```bash
npm run build
# Output: dist/index.cjs
```

## Deployment (EC2 + PM2)

```bash
# Build locally
npm run build

# Push to server
rsync -az dist/index.cjs ec2-user@<server-ip>:~/lexsearch/dist/

# Restart
ssh ec2-user@<server-ip> "pm2 restart lexsearch"
```

## Database

- PostgreSQL on localhost:5432/lexsearch1
- Schema managed via Drizzle ORM: `npm run db:push`
- Seed: runs automatically on first start

## Related Repos

- **Frontend UI:** [lexsearch-ui](https://github.com/mittujohnson/lexsearch-ui)
