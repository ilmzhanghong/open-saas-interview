# <YOUR_APP_NAME>

Built with [Wasp](https://wasp.sh), based on the [Open Saas](https://opensaas.sh) template.

## Development

### Running locally

- Make sure you have the `.env.client` and `.env.server` files with correct dev values in the root of the project.
- Run the database with `wasp start db` and leave it running.
- Run `wasp start` and leave it running.
- [OPTIONAL]: If this is the first time starting the app, or you've just made changes to your entities/prisma schema, also run `wasp db migrate-dev`.

## AI Operation Protection

`generateGptResponse` runs through a reusable protection layer (`src/ai-protection/`):
quota reserve-commit, rate limiting, prompt deduplication and call logging.

- `RATE_LIMIT_STORE=memory|db` (default `memory`): `memory` is a per-instance
  sliding window; switch to `db` for multi-instance deployments (fixed window,
  backed by the `RateLimitCounter` table).
- Rate limit / dedupe TTL / quota cost are configured per operation in
  `protectAiOperation` (see `src/demo-ai-app/operations.ts`).
- Every attempt is recorded in `AIOperationLog` (status: in_progress /
  completed / failed).

Run the concurrency smoke test (requires a stub OpenAI, see script header):

```bash
export DATABASE_URL=$(sed -n 's/^DATABASE_URL=//p' .wasp/out/server/.env)
node scripts/concurrency-smoke.mjs
```
