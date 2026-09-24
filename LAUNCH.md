# VeyroHood launch checklist (by tomorrow)

Site repo: https://github.com/joinveyrohood/NFTwhitelist
Pages URL: https://joinveyrohood.github.io/NFTwhitelist/
Worker name: veyrohood-api-v2
Expected worker URL: https://veyrohood-api-v2.mdb885941.workers.dev

## 1) GitHub secrets
Repo Settings → Secrets → Actions:
- CLOUDFLARE_API_TOKEN
- CLOUDFLARE_ACCOUNT_ID

Then run workflow: Deploy VeyroHood Worker

## 2) Cloudflare Worker secrets
In Cloudflare dashboard → Workers → veyrohood-api-v2 → Settings → Variables:
- ETHEREUM_RPC = your Ethereum HTTPS RPC
- ROBINHOOD_RPC = your Robinhood Chain HTTPS RPC

D1 binding must stay:
- binding DB
- database veyrohood-db
- id 9da108b5-5b86-4a13-982a-ce9bd52c6a1b

## 3) GitHub Pages
Settings → Pages → Deploy from branch → main / root

Open:
- https://joinveyrohood.github.io/NFTwhitelist/
- /missions.html
- /verify.html

## 4) Domain (if ready)
Point veyrohood.com to GitHub Pages or Cloudflare.
CORS already allows:
- https://veyrohood.com
- https://www.veyrohood.com
- https://joinveyrohood.github.io
- https://joinveyrohood.github.io/NFTwhitelist

## Live flow tomorrow
1. Home
2. Missions (X follow, Discord, quote, reply)
3. Verify form
4. Pay $0.30 USDG on Robinhood or Ethereum to treasury 0xf6F80827cBAf83798c7763FCd915C0068F2bE60C
5. First 1000 paid = OG number
6. Referral link after paid verify

Not required for tomorrow:
- NFT mint contract
- $2 claim / admin payout panel
- X performance WL lottery
