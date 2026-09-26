# Shots: a tiny gallery for the R2 screenshot bucket

No framework and no build step: one HTML page plus two Pages Functions.

```
public/index.html            the gallery (grid by month, filter, lightbox, copy link, delete)
functions/api/_middleware.js only lets requests through that carry a valid Cloudflare Access token
functions/api/list.js        GET  /api/list    lists the bucket, newest first
functions/api/delete.js      POST /api/delete  deletes one object
wrangler.toml                project name, R2 binding, public URL, Access settings
```

Images load directly from your public R2 URL. The functions only return the list and handle deletes.
The bucket is reached through a binding, so no API keys are stored anywhere.

## Deploy (about 10 minutes)

You need Node.js installed. Run everything from this folder.

**1. Log in and deploy**
```
npx wrangler login
npx wrangler pages deploy
```
On the first run, wrangler offers to create a project called `shots` and gives you a URL like
`https://shots-xxx.pages.dev`. The page will load but say "Not authorized". That's expected:
the API refuses every request until Access is set up (step 2), so the bucket is never exposed.

**2. Put Cloudflare Access in front of it**
1. Cloudflare dashboard → **Zero Trust**. The first time, pick a team name and the **Free** plan.
2. **Access → Applications → Add an application → Self-hosted**.
3. Domain: your `shots-xxx.pages.dev` hostname. Add a second one, `*.shots-xxx.pages.dev`,
   so preview deployments are protected too.
4. Policy: **Allow**, Include → **Emails** → your email address.
5. Save, then open the application and copy its **Application Audience (AUD) Tag**.
6. Your team domain is under **Settings → Custom pages** (or shown in the Access login URL):
   `https://<team>.cloudflareaccess.com`.

**3. Add those two values to `wrangler.toml` and redeploy**
```toml
ACCESS_TEAM_DOMAIN = "https://<team>.cloudflareaccess.com"
ACCESS_AUD = "<the AUD tag>"
```
```
npx wrangler pages deploy
```
Open the site. Access asks for your email, sends a one-time code, and after that you see your gallery.

## Changing things later
- **Custom domain for images:** change `PUBLIC_BASE` in `wrangler.toml` and redeploy.
  Existing r2.dev links keep working as long as the dev URL stays enabled on the bucket.
- **Local testing:** create a `.dev.vars` file containing `DEV_NO_AUTH=true`, then run
  `npx wrangler pages dev`. That uses a simulated local bucket, not your real one.
  Never set `DEV_NO_AUTH` on the deployed site.

## Notes
- Individual image links stay public (that's how sharing works). Only browsing the full list and
  deleting files require your login.
- Each load fetches up to 5,000 items, and a "Load more" button appears beyond that.
- Delete removes the file from R2, so any link you've shared to it stops working.
