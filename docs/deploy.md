# Deploying

Target: Vercel (free plan) with Neon Postgres (free plan).

## One-time setup

1. Create a Neon project and copy its pooled connection string.
2. Import this repository into Vercel (framework preset: Next.js, defaults are fine).
3. In Vercel project settings, add the environment variable `DATABASE_URL` set to the Neon connection string, for Production and Preview.
4. Add the host-account settings, also for Production and Preview:
   - `APP_URL`: the public origin used in emailed links, e.g. `https://<your-app>.vercel.app` (falls back to Vercel's production domain if unset).
   - `RESEND_API_KEY` and `EMAIL_FROM`: a Resend API key and a verified sender such as `Hybrid White Elephant <hello@yourdomain>`.
5. Apply migrations to the Neon database from your machine:

   ```bash
   DATABASE_URL='<neon connection string>' npm run db:migrate
   ```

6. Deploy. Check `https://<your-app>.vercel.app/api/health`: it should return `{"status":"ok"}`.

## Each schema change

Run `npm run db:generate` to create a migration, commit it, then run `npm run db:migrate` against Neon before (or as) the new code goes live.
