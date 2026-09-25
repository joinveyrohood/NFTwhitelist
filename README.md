# VeyroHood — NFT Community

Earn your place. Mint your hood.

Public site: https://joinveyrohood.github.io/NFTwhitelist/  
API: https://veyrohood-api-v2.mdb885941.workers.dev  
Repo: https://github.com/joinveyrohood/NFTwhitelist

## Live numbers
- Supply: 10,000
- OG: #1–#1000 (paid verification sequence)
- WL: #1001–#10000 (random + X performance)
- Fee: $0.30 USDG
- Referral: 20% = $0.06 / 80% = $0.24
- Claim floor: $2
- Rule: 1 wallet = 1 NFT

Treasury (public receive only): `0xf6F80827cBAf83798c7763FCd915C0068F2bE60C`

USDG
- Ethereum: `0xe343167631d89B6Ffc58B88d6b7fB0228795491D`
- Robinhood Chain 4663: `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`

## Free stack
GitHub repo + GitHub Pages + GitHub Actions + Cloudflare Workers + D1.

D1 free plan is not unlimited. After 1 Sep 2026, daily row read/write caps fail the query until midnight UTC.

Never put private keys, seed phrases, or withdrawal keys in this repo.

## Deploy
1. GitHub Pages: Settings → Pages → Deploy from branch → `main` / root
2. Actions secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
3. Worker secrets: `ADMIN_SECRET`, optional `ETHEREUM_RPC`, `ROBINHOOD_RPC`
4. D1 binding already in `backend/wrangler.toml` (`veyrohood-db`)

See `LAUNCH.md`.
