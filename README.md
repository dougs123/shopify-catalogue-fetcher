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

## Automatic discovery of newly approved Awin merchants

Every scheduled sweep first reads the current joined Awin merchant list through a
private Cloudflare service binding. The existing importer keeps its API credential;
it is never copied into this repository or sent to the runner. Discovery includes
approved merchants without product feeds and deduplicates their storefront domains.

Known Shopify stores reuse their verified platform identity. New domains are checked
for Shopify storefront globals or headers. Shopify CDN images alone require a matching
product catalogue response. Confirmed stores are automatically enrolled in the existing
catalogue queue with their approved Awin relationships. Their shop base currency is
checked by the scraper; it is not inferred from the merchant's Awin commission currency.

Discovery runs before the three catalogue shards on the existing nightly/retry schedule.
The first inventory pass may span several sweeps; newly seen domains are prioritised
before the remaining initial backlog. Unavailable/challenged stores retry, while negative
platform results are rechecked periodically or when a new merchant approval changes the
domain's relationships. No unavailable retailer response is bypassed. Existing disabled
stores remain disabled. Property sites are unchanged.

Use a manual run with `discovery_only=true` to check onboarding without starting another
full catalogue sweep. Discovery failure remains visible in the workflow while existing
catalogue collection can continue.

## Ten-platform catalogue ingestion

`platforms.mjs` contains adapters for Shopify, WooCommerce, Magento/Adobe Commerce,
BigCommerce, PrestaShop, Shopware, Squarespace Commerce, Wix Stores, Salesforce Commerce
Cloud and OpenCart. These are ten major supported platforms, not a claimed global ranking.
WooCommerce uses its public Store API where available. Other storefront adapters follow
published product sitemaps and extract explicit product/variant structured data. Shopify
keeps its existing full-catalogue scraper; its R2 captures are imported without fetching
those stores twice. Restricted platform administration APIs require merchant credentials
and are not used by these public-page adapters.

The separate `nightly-commerce-platforms` workflow starts at 03:10 UTC with sweeps at
09:10,15:10,21:10 UTC. Three disjoint merchant shards refresh the current joined Awin list,
identify platforms, capture product facts, prices, currency, availability and identifiers,
and publish validated compressed feeds into R2. Large storefronts retain crawl cursors
and continue on later sweeps. Robots exclusions, crawl delays and inaccessible responses
are respected. Failed or incomplete requests preserve prior valid records and real dates.

Raw captures retain useful product descriptions, images and attributes. Serving feeds
require an exact valid GTIN, explicit price currency and availability, a current approved
merchant relationship and a matching programme market. Unknown/range/ambiguous variants
remain held. Original source dates and actual offer expiry survive; rebuilding a feed
does not manufacture a fresh price check. Explicit unavailable records supersede older
observations within their merchant/product feed. No price-age-only expiry is added.

The shared catalogue freezes each commerce manifest alongside the Awin source release,
checks every compressed feed's checksum/count, and applies its existing rights, market,
identity and route rules. Existing comparison readers and the specialist projections can
then consume those admitted records through their normal refreshes. This does not claim
that every public page has already refreshed or that Google has indexed it. Property sites
and property ingestion remain excluded. Full native graphs, credentials and inventories
stay in private Cloudflare/R2 storage; only authored code and aggregate receipts go in Git.
