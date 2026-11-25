# hybrid-white-elephant

A mobile-first web app for running a white elephant gift exchange across a hybrid team. See [CONTEXT.md](CONTEXT.md) for the glossary.

## Stack

Next.js (TypeScript) on Vercel, Postgres on Neon, Drizzle for queries and migrations, Vitest for tests.

## Develop

```bash
npm install
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/hwe_dev   # any Postgres you can reach
npm run db:migrate
npm run dev
```

Health check: `GET /api/health` returns `{"status":"ok"}` when the database answers.

## Test

```bash
npm run typecheck
npm run test:engine   # pure engine and fake adapters; no database, fast
npm run test:http     # handlers against a throwaway Postgres database, with fake email and photo storage
npm test              # both
```

The HTTP tests create and drop their own database. They connect with `TEST_DATABASE_ADMIN_URL`
(default `postgres://postgres:postgres@localhost:5432/postgres`), which must be allowed to create databases.
CI runs the same commands against a Postgres 16 service container.

## Architecture seams

- `src/engine`: pure game engine. History, command, actor and time in; events or a rejection out. No I/O.
- `src/server`: request handlers that take their dependencies (database, email, photo storage, clock) as arguments, so tests can pass fakes.
- `src/ports` and `src/adapters`: interfaces for email and photo storage, plus in-memory fakes. Real adapters arrive with the features that need them.
- `src/app`: thin Next.js routes that wire production dependencies into the handlers.

## Deploy

See [docs/deploy.md](docs/deploy.md).
