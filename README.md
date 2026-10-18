# shopify-catalogue-fetcher

Nightly GitHub Actions job that pulls the public Shopify catalogues (`/products.json`, `/meta.json`,
per-product barcodes) of 37x Ltd's approved affiliate merchants and hands them to the
`shopify-catalogue-37x` Cloudflare Worker, which normalises them and stores them in R2.

Fetching runs here because Shopify throttles and soft-blocks Cloudflare Worker egress.
One request per second across all stores; backs off on 429 / Retry-After.

Secrets/vars: `INGEST_KEY` (secret, shared with the Worker), `WORKER_URL` (variable).
No credentials or data are stored in this repository.

## Recorded prices and nightly operation

The active runner is `dougs123/shopify-catalogue-fetcher`. The organisation copy
is disabled; keep it disabled to avoid duplicate crawling. Scheduled starts are
00:20, 06:20, 12:20 and 18:20 UTC, with three disjoint merchant shards.
GitHub may delay starts. The first pass collects the day's catalogues and the
later passes retry unfinished stores. Existing request pacing and backoff remain.

Unchanged prices remain recorded prices. A successful complete download supplies
`fetched_at`; the Worker keeps this observation date separately from each variant's
`price_changed_at`. Legacy change dates remain unknown where no history exists.
No fixed price-age expiry is applied. Availability and merchant/source rights still
apply. A failed, truncated, malformed or capped download never replaces the last
complete catalogue. Such stores remain retryable and the run log states why.

Cloudflare publishes a progress index at most every 15 minutes, including the last
successful source date, current attempt status and pending store count. An incomplete
day does not stop successful records being discoverable. A retained record is not
represented as newly checked merely because the summary was rebuilt.

Run `npm test` before publishing changes. Credentials stay in GitHub Actions secrets;
no catalogue records or credentials belong in this repository.
