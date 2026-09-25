# VeyroHood — live by tomorrow

Site is already on GitHub Pages:
https://joinveyrohood.github.io/NFTwhitelist/

Worker:
https://veyrohood-api-v2.mdb885941.workers.dev

veyrohood.com DNS is not resolving yet. Point the domain at GitHub Pages or Cloudflare Pages when you own it. CORS already allows both hosts.

## Must do tonight
1. Confirm GitHub Pages source is `main` / root.
2. Confirm Actions secrets exist:
   - CLOUDFLARE_API_TOKEN
   - CLOUDFLARE_ACCOUNT_ID
3. After this commit, Actions deploys `veyrohood-api-v2`.
4. In Cloudflare Worker settings add secret `ADMIN_SECRET` (long random string).
5. Open admin: https://joinveyrohood.github.io/NFTwhitelist/admin.html
6. Do a $0.30 USDG test pay from a burner wallet, then Recheck hash.

## Fee
Exact amount encoded: 300000 units = $0.30 USDG (6 decimals).

## Not blocking launch
- Custom domain
- NFT mint contract address
- Cloudflare Access in front of admin.html (recommended after launch)
- X API auto-scoring (admin can paste performance scores)

## Do not
- Put treasury private key anywhere
- Trust frontend "success" as payment proof
- Reset nft_allocation_counter
