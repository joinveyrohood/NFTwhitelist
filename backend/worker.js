import { Wallet, JsonRpcProvider, Contract } from "ethers";

const CONFIG = {
  treasury: "0xf6F80827cBAf83798c7763FCd915C0068F2bE60C",
  minPayment: 300000n,
  commission: 60000n,
  ogLimit: 1000,
  supply: 10000,
  minClaim: 0.3,
  feeUsd: "0.30",
  allowedOrigins: [
    "https://veyrohood.com",
    "https://www.veyrohood.com",
    "https://joinveyrohood.github.io",
    "https://joinveyrohood.github.io/NFTwhitelist"
  ],
  chains: {
    "1": { name: "Ethereum", token: "0xe343167631d89B6Ffc58B88d6b7fB0228795491D", rpcKey: "ETHEREUM_RPC", fallbacks: ["https://ethereum-rpc.publicnode.com", "https://rpc.ankr.com/eth"] },
    "4663": { name: "Robinhood", token: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", rpcKey: "ROBINHOOD_RPC", fallbacks: ["https://rpc.mainnet.chain.robinhood.com", "https://robinhood.drpc.org"] }
  }
};

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ERC20_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address account) view returns (uint256)"
];

function corsHeaders(origin) {
  const allowed = CONFIG.allowedOrigins.includes(origin) ? origin : CONFIG.allowedOrigins[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    Vary: "Origin"
  };
}
function json(data, status, origin) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...corsHeaders(origin) } });
}
function normalizeAddress(value) {
  return typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value) ? value.toLowerCase() : null;
}
function normalizeTx(value) {
  return typeof value === "string" && /^0x[a-fA-F0-9]{64}$/.test(value) ? value.toLowerCase() : null;
}
function topicAddress(topic) {
  if (!topic || !/^0x[a-fA-F0-9]{64}$/.test(topic)) return null;
  return ("0x" + topic.slice(-40)).toLowerCase();
}
function cleanHandle(value) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/^@+/, "").slice(0, 64);
}
function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}
function makeReferralCode(wallet) {
  return "VH" + wallet.slice(2, 8).toUpperCase() + wallet.slice(-4).toUpperCase();
}
function money(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}
function toMicros(usd) {
  return Math.round(money(usd) * 1000000);
}
async function runIgnore(env, sql) {
  try { await env.DB.prepare(sql).run(); } catch (_error) {}
}
async function ensureSchema(env) {
  if (!env.DB) throw new Error("D1 database is not bound");
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS verifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_address TEXT NOT NULL,
      x_username TEXT,
      discord_username TEXT,
      quote_link TEXT,
      reply_link TEXT,
      referral_code TEXT,
      payment_tx TEXT,
      payment_amount TEXT,
      payment_verified INTEGER DEFAULT 0,
      network TEXT,
      status TEXT DEFAULT 'submitted',
      og_number INTEGER,
      nft_number INTEGER,
      allocation_type TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      verified_at TEXT
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS referral_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_address TEXT NOT NULL UNIQUE,
      referral_code TEXT NOT NULL UNIQUE,
      available_balance TEXT DEFAULT '0',
      total_earned TEXT DEFAULT '0',
      total_withdrawn TEXT DEFAULT '0',
      referred_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS referral_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      referrer_wallet TEXT NOT NULL,
      source_wallet TEXT,
      source_payment_tx TEXT,
      chain_id INTEGER,
      amount_usdg_micros INTEGER,
      entry_type TEXT,
      idempotency_key TEXT UNIQUE,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS referral_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      referrer_id INTEGER,
      referred_verification_id INTEGER,
      commission_amount TEXT,
      status TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_address TEXT NOT NULL,
      amount TEXT NOT NULL,
      chain_id INTEGER,
      status TEXT DEFAULT 'pending',
      payout_tx TEXT,
      admin_note TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS counters (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      next_og_number INTEGER DEFAULT 1,
      next_wl_number INTEGER DEFAULT 1001
    )`)
  ]);
  for (const sql of [
    "ALTER TABLE verifications ADD COLUMN nft_number INTEGER",
    "ALTER TABLE verifications ADD COLUMN allocation_type TEXT",
    "ALTER TABLE referral_users ADD COLUMN total_withdrawn TEXT DEFAULT '0'",
    "INSERT OR IGNORE INTO counters (id, next_og_number, next_wl_number) VALUES (1, 1, 1001)"
  ]) await runIgnore(env, sql);
  await runIgnore(env, "CREATE UNIQUE INDEX IF NOT EXISTS idx_verifications_wallet ON verifications (wallet_address)");
}
function rpcList(env, chainId) {
  const chain = CONFIG.chains[String(chainId)];
  const urls = [];
  if (chain && env[chain.rpcKey]) urls.push(env[chain.rpcKey]);
  if (chain) urls.push(...chain.fallbacks);
  return [...new Set(urls.filter(Boolean))];
}
async function rpcCall(rpcUrl, method, params = []) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  if (!response.ok) throw new Error("RPC HTTP " + response.status);
  const result = await response.json();
  if (result.error) throw new Error(result.error.message || "RPC returned an error");
  return result.result;
}
async function rpcCallAny(env, chainId, method, params = []) {
  const errors = [];
  for (const url of rpcList(env, chainId)) {
    try { return await rpcCall(url, method, params); } catch (error) { errors.push(error.message); }
  }
  throw new Error("RPC request failed: " + errors.join(" | "));
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function verifyOnChain(env, chainId, wallet, txHash) {
  const chain = CONFIG.chains[String(chainId)];
  if (!chain) throw new Error("Unsupported network");
  const actualChainId = await rpcCallAny(env, chainId, "eth_chainId");
  if (BigInt(actualChainId) !== BigInt(chainId)) throw new Error("RPC chain ID mismatch");
  let receipt = null;
  for (let i = 0; i < 6; i++) {
    receipt = await rpcCallAny(env, chainId, "eth_getTransactionReceipt", [txHash]);
    if (receipt) break;
    await sleep(1500);
  }
  if (!receipt) throw new Error("Transaction not found yet. Wait and tap Recheck.");
  if (receipt.status !== "0x1") throw new Error("Transaction failed on-chain");
  const tx = await rpcCallAny(env, chainId, "eth_getTransactionByHash", [txHash]);
  const sender = tx ? normalizeAddress(tx.from) : null;
  if (sender && sender !== wallet) throw new Error("Transaction sender does not match wallet");
  let paidAmount = 0n;
  for (const log of receipt.logs || []) {
    if (normalizeAddress(log.address) !== chain.token.toLowerCase()) continue;
    if (!log.topics || log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
    const from = topicAddress(log.topics[1]);
    const to = topicAddress(log.topics[2]);
    if (to !== CONFIG.treasury.toLowerCase()) continue;
    if (from && from !== wallet) continue;
    if (!/^0x[0-9a-fA-F]+$/.test(log.data || "")) continue;
    paidAmount += BigInt(log.data);
  }
  if (paidAmount < CONFIG.minPayment) throw new Error("Required $0.30 USDG transfer to treasury not found");
  return { chainName: chain.name, amountMicros: paidAmount.toString() };
}
async function handleSubmitVerification(request, env, origin) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON body" }, 400, origin); }
  const wallet = normalizeAddress(body.wallet_address || body.wallet);
  const xUsername = cleanHandle(body.x_username);
  const discordUsername = cleanHandle(body.discord_username);
  const quoteLink = String(body.quote_link || "").trim();
  const replyLink = String(body.reply_link || "").trim();
  const referralCode = cleanHandle(body.referral_code || body.ref || "");
  if (!wallet) return json({ error: "Connect a valid wallet first" }, 400, origin);
  if (!xUsername) return json({ error: "X username is required" }, 400, origin);
  if (!discordUsername) return json({ error: "Discord username is required" }, 400, origin);
  if (!isHttpUrl(quoteLink)) return json({ error: "Valid quote link is required" }, 400, origin);
  if (!isHttpUrl(replyLink)) return json({ error: "Valid reply link is required" }, 400, origin);
  const existing = await env.DB.prepare("SELECT id, payment_verified, status FROM verifications WHERE lower(wallet_address) = ? LIMIT 1").bind(wallet).first();
  if (existing) {
    return json({
      success: true,
      id: existing.id,
      alreadySubmitted: true,
      paymentVerified: existing.payment_verified === 1,
      status: existing.status,
      message: existing.payment_verified === 1 ? "Wallet already verified" : "Submission found. Continue to $0.30 USDG payment."
    }, 200, origin);
  }
  const inserted = await env.DB.prepare("INSERT INTO verifications (wallet_address, x_username, discord_username, quote_link, reply_link, referral_code, status) VALUES (?, ?, ?, ?, ?, ?, 'submitted')").bind(wallet, xUsername, discordUsername, quoteLink, replyLink, referralCode || null).run();
  return json({ success: true, id: inserted.meta.last_row_id, paymentRequired: true, amountUsd: CONFIG.feeUsd, treasury: CONFIG.treasury, message: "Details saved. Pay $0.30 USDG to finish verification." }, 200, origin);
}
async function assignOgIfNeeded(env, verificationId) {
  const counter = await env.DB.prepare("SELECT next_og_number FROM counters WHERE id = 1").first();
  let next = Number(counter && counter.next_og_number || 1);
  if (next > CONFIG.ogLimit) return null;
  await env.DB.batch([
    env.DB.prepare("UPDATE verifications SET og_number = ?, nft_number = ?, allocation_type = 'OG' WHERE id = ? AND og_number IS NULL").bind(next, next, verificationId),
    env.DB.prepare("UPDATE counters SET next_og_number = ? WHERE id = 1").bind(next + 1)
  ]);
  return next;
}
async function handleVerifyPayment(request, env, origin) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON body" }, 400, origin); }
  const wallet = normalizeAddress(body.wallet || body.wallet_address);
  const txHash = normalizeTx(body.txHash || body.payment_tx);
  let chainId = Number(body.chainId);
  if (!wallet || !txHash) return json({ error: "Invalid wallet or transaction hash" }, 400, origin);
  try {
    let chainResult = null;
    const tryIds = [chainId, 4663, 1].filter((id, i, arr) => CONFIG.chains[String(id)] && arr.indexOf(id) === i);
    const errors = [];
    for (const id of tryIds) {
      try { chainResult = await verifyOnChain(env, id, wallet, txHash); chainId = id; break; } catch (error) { errors.push(String(id) + ": " + error.message); }
    }
    if (!chainResult) throw new Error(errors.join(" | "));
    const used = await env.DB.prepare("SELECT id FROM verifications WHERE lower(payment_tx) = ? AND lower(wallet_address) != ? LIMIT 1").bind(txHash, wallet).first();
    if (used) return json({ error: "Transaction already used" }, 409, origin);
    let verification = await env.DB.prepare("SELECT id, wallet_address, referral_code, payment_verified, og_number FROM verifications WHERE lower(wallet_address) = ? ORDER BY id DESC LIMIT 1").bind(wallet).first();
    if (!verification) {
      const created = await env.DB.prepare("INSERT INTO verifications (wallet_address, status) VALUES (?, 'submitted')").bind(wallet).run();
      verification = { id: created.meta.last_row_id, wallet_address: wallet, referral_code: null, payment_verified: 0, og_number: null };
    }
    if (verification.payment_verified === 1) return json({ success: true, message: "Payment already verified", ogNumber: verification.og_number }, 200, origin);
    const update = await env.DB.prepare("UPDATE verifications SET payment_tx = ?, payment_amount = ?, payment_verified = 1, network = ?, status = 'verified', verified_at = CURRENT_TIMESTAMP WHERE id = ? AND COALESCE(payment_verified, 0) = 0").bind(txHash, chainResult.amountMicros, chainResult.chainName, verification.id).run();
    if (!update.meta.changes) return json({ error: "Payment record changed; please retry" }, 409, origin);
    const ogNumber = await assignOgIfNeeded(env, verification.id);
    if (!ogNumber) {
      await env.DB.prepare("UPDATE verifications SET allocation_type = 'WL_POOL' WHERE id = ?").bind(verification.id).run();
    }
    const ownCode = makeReferralCode(wallet);
    await env.DB.prepare("INSERT OR IGNORE INTO referral_users (wallet_address, referral_code) VALUES (?, ?)").bind(wallet, ownCode).run();
    let commissionCredited = false;
    const referralCode = verification.referral_code;
    if (referralCode) {
      const referrer = await env.DB.prepare("SELECT id, wallet_address FROM referral_users WHERE referral_code = ? LIMIT 1").bind(referralCode).first();
      if (referrer && normalizeAddress(referrer.wallet_address) !== wallet) {
        const idempotencyKey = "commission:" + chainId + ":" + txHash;
        const ledgerInsert = await env.DB.prepare("INSERT OR IGNORE INTO referral_ledger (referrer_wallet, source_wallet, source_payment_tx, chain_id, amount_usdg_micros, entry_type, idempotency_key) VALUES (?, ?, ?, ?, ?, 'commission', ?)").bind(normalizeAddress(referrer.wallet_address), wallet, txHash, chainId, Number(CONFIG.commission), idempotencyKey).run();
        if (ledgerInsert.meta.changes === 1) {
          await env.DB.batch([
            env.DB.prepare("UPDATE referral_users SET available_balance = CAST(COALESCE(available_balance, '0') AS REAL) + 0.06, total_earned = CAST(COALESCE(total_earned, '0') AS REAL) + 0.06, referred_count = COALESCE(referred_count, 0) + 1 WHERE id = ?").bind(referrer.id),
            env.DB.prepare("INSERT OR IGNORE INTO referral_events (referrer_id, referred_verification_id, commission_amount, status) VALUES (?, ?, '0.06', 'credited')").bind(referrer.id, verification.id)
          ]);
          commissionCredited = true;
        }
      }
    }
    return json({
      success: true,
      paymentVerified: true,
      network: chainResult.chainName,
      paidAmountMicros: chainResult.amountMicros,
      commissionCredited,
      ogNumber,
      allocationType: ogNumber ? "OG" : "WL_POOL",
      referralCode: ownCode,
      referralLink: "https://joinveyrohood.github.io/NFTwhitelist/verify.html?ref=" + ownCode
    }, 200, origin);
  } catch (error) {
    return json({ error: error.message || "Payment verification failed" }, 400, origin);
  }
}
async function handleStats(env, origin) {
  try {
    const row = await env.DB.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN COALESCE(payment_verified, 0) = 1 THEN 1 ELSE 0 END) AS verified, SUM(CASE WHEN og_number IS NOT NULL THEN 1 ELSE 0 END) AS og FROM verifications").first();
    let leaderboard = [];
    try {
      const board = await env.DB.prepare("SELECT referral_code, referred_count, total_earned, total_withdrawn FROM referral_users ORDER BY COALESCE(referred_count, 0) DESC, CAST(total_earned AS REAL) DESC LIMIT 20").all();
      leaderboard = board && board.results ? board.results : [];
    } catch (_error) {}
    const og = Number(row && row.og || 0);
    const joined = Number(row && row.verified || 0);
    return json({
      success: true,
      supply: CONFIG.supply,
      ogLimit: CONFIG.ogLimit,
      joined,
      submitted: Number(row && row.total || 0),
      og,
      ogLeft: Math.max(0, CONFIG.ogLimit - og),
      wlPool: Math.max(0, joined - og),
      leaderboard
    }, 200, origin);
  } catch (error) {
    return json({ success: false, error: error.message || "Stats query failed", joined: 0, submitted: 0, og: 0, leaderboard: [] }, 200, origin);
  }
}
async function handleMe(request, env, origin) {
  const wallet = normalizeAddress(new URL(request.url).searchParams.get("wallet"));
  if (!wallet) return json({ error: "Wallet required" }, 400, origin);
  const verification = await env.DB.prepare("SELECT payment_verified, og_number, nft_number, allocation_type, status FROM verifications WHERE lower(wallet_address) = ? ORDER BY id DESC LIMIT 1").bind(wallet).first();
  const ref = await env.DB.prepare("SELECT referral_code, available_balance, total_earned, total_withdrawn, referred_count FROM referral_users WHERE lower(wallet_address) = ? LIMIT 1").bind(wallet).first();
  const pending = await env.DB.prepare("SELECT id, amount, status FROM claims WHERE lower(wallet_address) = ? AND status IN ('pending','approved','paying') ORDER BY id DESC LIMIT 1").bind(wallet).first();
  const available = money(ref && ref.available_balance);
  const paymentVerified = !!(verification && verification.payment_verified === 1);
  const ogNumber = verification && verification.og_number ? verification.og_number : null;
  const code = (ref && ref.referral_code) || (paymentVerified ? makeReferralCode(wallet) : null);
  const autoPayoutReady = !!(env.PAYOUT_PRIVATE_KEY);
  return json({
    success: true,
    wallet,
    paymentVerified,
    ogNumber,
    nftNumber: verification && verification.nft_number ? verification.nft_number : ogNumber,
    allocationType: ogNumber ? "OG" : (paymentVerified ? "WL" : null),
    mintEligible: paymentVerified,
    wlPool: paymentVerified && !ogNumber,
    status: verification ? verification.status : "none",
    referralCode: code,
    referralLink: code ? "https://joinveyrohood.github.io/NFTwhitelist/verify.html?ref=" + code : null,
    availableBalance: available,
    totalEarned: money(ref && ref.total_earned),
    totalWithdrawn: money(ref && ref.total_withdrawn),
    referredCount: Number(ref && ref.referred_count || 0),
    canClaim: paymentVerified && available >= CONFIG.minClaim && !pending,
    minClaim: CONFIG.minClaim,
    autoPayoutReady,
    pendingClaim: pending || null,
    message: !verification ? "This wallet has not submitted yet." : !paymentVerified ? "Details saved. Pay $0.30 USDG to verify." : ogNumber ? ("OG #" + ogNumber + ". Paid wallet. Eligible to mint.") : "Verified paid wallet. In WL / random + admin pool for remaining 9,000."
  }, 200, origin);
}
async function sendUsdg(env, chainId, toWallet, usdAmount) {
  const key = env.PAYOUT_PRIVATE_KEY;
  if (!key) throw new Error("AUTO_PAYOUT_OFF");
  const chain = CONFIG.chains[String(chainId)];
  if (!chain) throw new Error("Unsupported payout network");
  const rpcUrl = rpcList(env, chainId)[0];
  if (!rpcUrl) throw new Error("No RPC for payout");
  const provider = new JsonRpcProvider(rpcUrl, Number(chainId));
  const signer = new Wallet(key, provider);
  const token = new Contract(chain.token, ERC20_ABI, signer);
  const micros = BigInt(toMicros(usdAmount));
  const tx = await token.transfer(toWallet, micros);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error("Payout transaction failed");
  return receipt.hash;
}
async function handleClaim(request, env, origin) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON body" }, 400, origin); }
  const wallet = normalizeAddress(body.wallet || body.wallet_address);
  const chainId = Number(body.chainId || 4663);
  if (!wallet) return json({ error: "Connect wallet first" }, 400, origin);
  const paid = await env.DB.prepare("SELECT payment_verified FROM verifications WHERE lower(wallet_address) = ? ORDER BY id DESC LIMIT 1").bind(wallet).first();
  if (!paid || paid.payment_verified !== 1) return json({ error: "Pay $0.30 USDG and verify first" }, 403, origin);
  const user = await env.DB.prepare("SELECT id, available_balance, total_withdrawn FROM referral_users WHERE lower(wallet_address) = ? LIMIT 1").bind(wallet).first();
  if (!user) return json({ error: "No referral balance yet" }, 400, origin);
  const available = money(user.available_balance);
  if (available < CONFIG.minClaim) return json({ error: "Minimum claim is $0.30. Need more paid referrals." }, 400, origin);
  const open = await env.DB.prepare("SELECT id FROM claims WHERE lower(wallet_address) = ? AND status IN ('pending','approved','paying') LIMIT 1").bind(wallet).first();
  if (open) return json({ error: "A claim is already pending" }, 409, origin);
  const amount = available.toFixed(2);
  const inserted = await env.DB.prepare("INSERT INTO claims (wallet_address, amount, chain_id, status, updated_at) VALUES (?, ?, ?, 'paying', CURRENT_TIMESTAMP)").bind(wallet, amount, chainId).run();
  const claimId = inserted.meta.last_row_id;
  await env.DB.prepare("UPDATE referral_users SET available_balance = '0' WHERE id = ?").bind(user.id).run();
  if (!env.PAYOUT_PRIVATE_KEY) {
    await env.DB.prepare("UPDATE claims SET status = 'pending', admin_note = 'auto payout secret missing', updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(claimId).run();
    return json({ success: true, autoPaid: false, message: "Claim queued. Add Cloudflare secret PAYOUT_PRIVATE_KEY to enable auto USDG payout." }, 200, origin);
  }
  try {
    const hash = await sendUsdg(env, chainId, wallet, amount);
    const withdrawn = money(user.total_withdrawn) + money(amount);
    await env.DB.batch([
      env.DB.prepare("UPDATE claims SET status = 'paid', payout_tx = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(hash, claimId),
      env.DB.prepare("UPDATE referral_users SET total_withdrawn = ? WHERE id = ?").bind(withdrawn.toFixed(2), user.id)
    ]);
    return json({ success: true, autoPaid: true, payoutTx: hash, message: "Auto paid " + amount + " USDG. Tx " + hash }, 200, origin);
  } catch (error) {
    await env.DB.prepare("UPDATE claims SET status = 'pending', admin_note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(String(error.message || "payout failed").slice(0, 180), claimId).run();
    return json({ success: true, autoPaid: false, error: error.message, message: "Claim saved. Auto payout failed; admin can retry." }, 200, origin);
  }
}
async function handleClaims(request, env, origin) {
  const wallet = normalizeAddress(new URL(request.url).searchParams.get("wallet"));
  if (!wallet) return json({ error: "Wallet required" }, 400, origin);
  const rows = await env.DB.prepare("SELECT id, amount, chain_id, status, payout_tx, created_at FROM claims WHERE lower(wallet_address) = ? ORDER BY id DESC LIMIT 20").bind(wallet).all();
  return json({ success: true, claims: (rows && rows.results) || [] }, 200, origin);
}
function adminOk(request, env) {
  const expected = env.ADMIN_SECRET || env.ADMIN_API_SECRET;
  if (!expected) return false;
  const header = request.headers.get("Authorization") || "";
  return header === "Bearer " + expected || header === expected;
}
async function handleAdminOverview(request, env, origin) {
  if (!adminOk(request, env)) return json({ error: "Unauthorized" }, 401, origin);
  const counter = await env.DB.prepare("SELECT next_og_number, next_wl_number FROM counters WHERE id = 1").first();
  const applications = await env.DB.prepare("SELECT id, wallet_address, x_username, status, og_number, nft_number, allocation_type, payment_tx FROM verifications ORDER BY id DESC LIMIT 100").all();
  const claims = await env.DB.prepare("SELECT id, wallet_address, amount, chain_id, status, payout_tx FROM claims ORDER BY id DESC LIMIT 100").all();
  const referrals = await env.DB.prepare("SELECT referral_code, referred_count, available_balance, total_earned, total_withdrawn FROM referral_users ORDER BY referred_count DESC LIMIT 100").all();
  const wlCandidates = await env.DB.prepare("SELECT wallet_address, x_username, status FROM verifications WHERE COALESCE(payment_verified,0)=1 AND og_number IS NULL AND (allocation_type IS NULL OR allocation_type = 'WL_POOL') ORDER BY id ASC LIMIT 200").all();
  return json({
    success: true,
    counter: counter || { next_og_number: 1, next_wl_number: 1001 },
    applications: (applications && applications.results) || [],
    claims: (claims && claims.results) || [],
    referrals: (referrals && referrals.results) || [],
    wlCandidates: (wlCandidates && wlCandidates.results) || []
  }, 200, origin);
}
async function handleAdminClaims(request, env, origin) {
  if (!adminOk(request, env)) return json({ error: "Unauthorized" }, 401, origin);
  if (request.method === "GET") {
    const rows = await env.DB.prepare("SELECT * FROM claims ORDER BY id DESC LIMIT 100").all();
    return json({ success: true, claims: (rows && rows.results) || [] }, 200, origin);
  }
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON body" }, 400, origin); }
  const id = Number(body.id);
  const action = String(body.action || "");
  const claim = await env.DB.prepare("SELECT * FROM claims WHERE id = ?").bind(id).first();
  if (!claim) return json({ error: "Claim not found" }, 404, origin);
  if (action === "reject" && (claim.status === "pending" || claim.status === "approved" || claim.status === "paying")) {
    await env.DB.batch([
      env.DB.prepare("UPDATE claims SET status = 'rejected', updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(id),
      env.DB.prepare("UPDATE referral_users SET available_balance = CAST(COALESCE(available_balance, '0') AS REAL) + ? WHERE lower(wallet_address) = ?").bind(Number(claim.amount), String(claim.wallet_address).toLowerCase())
    ]);
    return json({ success: true, message: "Claim rejected and balance returned" }, 200, origin);
  }
  if (action === "approve" && claim.status === "pending") {
    if (env.PAYOUT_PRIVATE_KEY) {
      try {
        const hash = await sendUsdg(env, claim.chain_id || 4663, claim.wallet_address, claim.amount);
        await env.DB.prepare("UPDATE claims SET status = 'paid', payout_tx = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(hash, id).run();
        await env.DB.prepare("UPDATE referral_users SET total_withdrawn = CAST(COALESCE(total_withdrawn,'0') AS REAL) + ? WHERE lower(wallet_address) = ?").bind(Number(claim.amount), String(claim.wallet_address).toLowerCase()).run();
        return json({ success: true, autoPaid: true, payoutTx: hash, message: "Approved and auto paid" }, 200, origin);
      } catch (error) {
        await env.DB.prepare("UPDATE claims SET status = 'approved', admin_note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(String(error.message || "payout failed").slice(0, 180), id).run();
        return json({ success: true, autoPaid: false, message: "Approved. Auto payout failed: " + error.message }, 200, origin);
      }
    }
    await env.DB.prepare("UPDATE claims SET status = 'approved', updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(id).run();
    return json({ success: true, message: "Claim approved. Send payout then mark paid." }, 200, origin);
  }
  if (action === "paid") {
    const tx = normalizeTx(body.payout_tx);
    if (!tx) return json({ error: "payout_tx required" }, 400, origin);
    await env.DB.prepare("UPDATE claims SET status = 'paid', payout_tx = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(tx, id).run();
    return json({ success: true, message: "Marked paid" }, 200, origin);
  }
  if (action === "retry" && env.PAYOUT_PRIVATE_KEY) {
    try {
      const hash = await sendUsdg(env, claim.chain_id || 4663, claim.wallet_address, claim.amount);
      await env.DB.prepare("UPDATE claims SET status = 'paid', payout_tx = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(hash, id).run();
      return json({ success: true, autoPaid: true, payoutTx: hash, message: "Retry paid" }, 200, origin);
    } catch (error) {
      return json({ error: error.message || "Retry failed" }, 400, origin);
    }
  }
  return json({ error: "Invalid action" }, 400, origin);
}
async function handleWlRun(request, env, origin) {
  if (!adminOk(request, env)) return json({ error: "Unauthorized" }, 401, origin);
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const count = Math.max(1, Math.min(500, Number(body.count || 10)));
  const candidates = await env.DB.prepare("SELECT id FROM verifications WHERE COALESCE(payment_verified,0)=1 AND og_number IS NULL AND (nft_number IS NULL) ORDER BY RANDOM() LIMIT ?").bind(count).all();
  const rows = (candidates && candidates.results) || [];
  const allocated = [];
  for (const row of rows) {
    const counter = await env.DB.prepare("SELECT next_wl_number FROM counters WHERE id = 1").first();
    const next = Number(counter && counter.next_wl_number || 1001);
    if (next > CONFIG.supply) break;
    await env.DB.batch([
      env.DB.prepare("UPDATE verifications SET nft_number = ?, allocation_type = 'WL' WHERE id = ?").bind(next, row.id),
      env.DB.prepare("UPDATE counters SET next_wl_number = ? WHERE id = 1").bind(next + 1)
    ]);
    allocated.push({ id: row.id, nftNumber: next });
  }
  return json({ success: true, allocated }, 200, origin);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
    try { await ensureSchema(env); } catch (error) {
      return json({ error: error.message || "Database unavailable" }, 500, origin);
    }
    if (url.pathname === "/" || url.pathname === "/api/health") {
      return json({ status: "online", service: "VeyroHood API", version: "0.4.0", fee: "0.30 USDG", minClaim: "0.30", autoPayout: !!(env.PAYOUT_PRIVATE_KEY) }, 200, origin);
    }
    if ((url.pathname === "/verify" || url.pathname === "/api/verify") && request.method === "POST") return handleSubmitVerification(request, env, origin);
    if (url.pathname === "/api/verify-payment" && request.method === "POST") return handleVerifyPayment(request, env, origin);
    if ((url.pathname === "/api/stats" || url.pathname === "/stats") && request.method === "GET") return handleStats(env, origin);
    if (url.pathname === "/api/me" && request.method === "GET") return handleMe(request, env, origin);
    if (url.pathname === "/api/claim" && request.method === "POST") return handleClaim(request, env, origin);
    if (url.pathname === "/api/claims" && request.method === "GET") return handleClaims(request, env, origin);
    if (url.pathname === "/api/admin/overview" && request.method === "GET") return handleAdminOverview(request, env, origin);
    if (url.pathname === "/api/admin/claims") return handleAdminClaims(request, env, origin);
    if (url.pathname === "/api/admin/wl-run" && request.method === "POST") return handleWlRun(request, env, origin);
    return json({ error: "Not found" }, 404, origin);
  }
};
