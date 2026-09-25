const CONFIG = {
  treasury: "0xf6F80827cBAf83798c7763FCd915C0068F2bE60C",
  minPayment: 20000n,
  commission: 4000n,
  ogLimit: 1000,
  minClaim: 2,
  allowedOrigins: ["https://veyrohood.com","https://www.veyrohood.com","https://joinveyrohood.github.io","https://joinveyrohood.github.io/NFTwhitelist"],
  chains: {
    "1": { name: "Ethereum", token: "0xe343167631d89B6Ffc58B88d6b7fB0228795491D", rpcKey: "ETHEREUM_RPC" },
    "4663": { name: "Robinhood", token: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", rpcKey: "ROBINHOOD_RPC" }
  }
};
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
function corsHeaders(origin) {
  const allowed = CONFIG.allowedOrigins.includes(origin) ? origin : CONFIG.allowedOrigins[0];
  return { "Access-Control-Allow-Origin": allowed, "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization", "Vary": "Origin" };
}
function json(data, status, origin) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...corsHeaders(origin) } });
}
function normalizeAddress(value) { return typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value) ? value.toLowerCase() : null; }
function normalizeTx(value) { return typeof value === "string" && /^0x[a-fA-F0-9]{64}$/.test(value) ? value.toLowerCase() : null; }
function topicAddress(topic) { if (!topic || !/^0x[a-fA-F0-9]{64}$/.test(topic)) return null; return ("0x" + topic.slice(-40)).toLowerCase(); }
function cleanHandle(value) { if (typeof value !== "string") return ""; return value.trim().replace(/^@+/, "").slice(0, 64); }
function isHttpUrl(value) { try { const url = new URL(value); return url.protocol === "https:" || url.protocol === "http:"; } catch { return false; } }
function makeReferralCode(wallet) { return "VH" + wallet.slice(2, 8).toUpperCase() + wallet.slice(-4).toUpperCase(); }
function money(value) { const n = Number(value || 0); return Number.isFinite(n) ? n : 0; }
async function runIgnore(env, sql) { try { await env.DB.prepare(sql).run(); } catch (_error) {} }
async function ensureSchema(env) {
  if (!env.DB) throw new Error("D1 database is not bound");
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS verifications (id INTEGER PRIMARY KEY AUTOINCREMENT, wallet_address TEXT NOT NULL, x_username TEXT, discord_username TEXT, quote_link TEXT, reply_link TEXT, referral_code TEXT, payment_tx TEXT, payment_amount TEXT, payment_verified INTEGER DEFAULT 0, network TEXT, status TEXT DEFAULT 'submitted', og_number INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP, verified_at TEXT)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS referral_users (id INTEGER PRIMARY KEY AUTOINCREMENT, wallet_address TEXT NOT NULL UNIQUE, referral_code TEXT NOT NULL UNIQUE, available_balance TEXT DEFAULT '0', total_earned TEXT DEFAULT '0', referred_count INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS referral_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, referrer_wallet TEXT NOT NULL, source_wallet TEXT, source_payment_tx TEXT, chain_id INTEGER, amount_usdg_micros INTEGER, entry_type TEXT, idempotency_key TEXT UNIQUE, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS referral_events (id INTEGER PRIMARY KEY AUTOINCREMENT, referrer_id INTEGER, referred_verification_id INTEGER, commission_amount TEXT, status TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS claims (id INTEGER PRIMARY KEY AUTOINCREMENT, wallet_address TEXT NOT NULL, amount TEXT NOT NULL, chain_id INTEGER, status TEXT DEFAULT 'pending', payout_tx TEXT, admin_note TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT)`)
  ]);
  for (const sql of ["ALTER TABLE verifications ADD COLUMN x_username TEXT","ALTER TABLE verifications ADD COLUMN discord_username TEXT","ALTER TABLE verifications ADD COLUMN quote_link TEXT","ALTER TABLE verifications ADD COLUMN reply_link TEXT","ALTER TABLE verifications ADD COLUMN referral_code TEXT","ALTER TABLE verifications ADD COLUMN payment_tx TEXT","ALTER TABLE verifications ADD COLUMN payment_amount TEXT","ALTER TABLE verifications ADD COLUMN payment_verified INTEGER DEFAULT 0","ALTER TABLE verifications ADD COLUMN network TEXT","ALTER TABLE verifications ADD COLUMN status TEXT","ALTER TABLE verifications ADD COLUMN og_number INTEGER","ALTER TABLE verifications ADD COLUMN created_at TEXT","ALTER TABLE verifications ADD COLUMN verified_at TEXT"]) await runIgnore(env, sql);
  await runIgnore(env, "CREATE UNIQUE INDEX IF NOT EXISTS idx_verifications_wallet ON verifications (wallet_address)");
}
async function rpcCall(rpcUrl, method, params = []) {
  const response = await fetch(rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  if (!response.ok) throw new Error("RPC HTTP " + response.status);
  const result = await response.json();
  if (result.error) throw new Error(result.error.message || "RPC returned an error");
  return result.result;
}
function rpcList(env, chainId) {
  const chain = CONFIG.chains[String(chainId)];
  const urls = [];
  if (chain && env[chain.rpcKey]) urls.push(env[chain.rpcKey]);
  if (String(chainId) === "4663") urls.push("https://rpc.mainnet.chain.robinhood.com", "https://robinhood.drpc.org");
  else urls.push("https://ethereum-rpc.publicnode.com", "https://rpc.ankr.com/eth");
  return [...new Set(urls.filter(Boolean))];
}
async function rpcCallAny(env, chainId, method, params = []) {
  const errors = [];
  for (const url of rpcList(env, chainId)) { try { return await rpcCall(url, method, params); } catch (error) { errors.push(error.message); } }
  throw new Error("RPC request failed: " + errors.join(" | "));
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function verifyOnChain(env, chainId, wallet, txHash) {
  const chain = CONFIG.chains[String(chainId)];
  if (!chain) throw new Error("Unsupported network");
  const actualChainId = await rpcCallAny(env, chainId, "eth_chainId");
  if (BigInt(actualChainId) !== BigInt(chainId)) throw new Error("RPC chain ID mismatch");
  let receipt = null;
  for (let i = 0; i < 6; i++) { receipt = await rpcCallAny(env, chainId, "eth_getTransactionReceipt", [txHash]); if (receipt) break; await sleep(1500); }
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
  if (paidAmount < CONFIG.minPayment) throw new Error("Required USDG transfer to treasury not found");
  return { chainName: chain.name, amountMicros: paidAmount.toString() };
}
async function handleSubmitVerification(request, env, origin) {
  let body; try { body = await request.json(); } catch { return json({ error: "Invalid JSON body" }, 400, origin); }
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
  if (existing) return json({ success: true, id: existing.id, alreadySubmitted: true, paymentVerified: existing.payment_verified === 1, status: existing.status, message: existing.payment_verified === 1 ? "Wallet already verified" : "Submission found. Continue to $0.02 USDG payment." }, 200, origin);
  const inserted = await env.DB.prepare("INSERT INTO verifications (wallet_address, x_username, discord_username, quote_link, reply_link, referral_code, status) VALUES (?, ?, ?, ?, ?, ?, 'submitted')").bind(wallet, xUsername, discordUsername, quoteLink, replyLink, referralCode || null).run();
  return json({ success: true, id: inserted.meta.last_row_id, paymentRequired: true, amountUsd: "0.02", treasury: CONFIG.treasury, message: "Details saved. Pay $0.02 USDG to finish verification." }, 200, origin);
}
async function assignOgIfNeeded(env, verificationId) {
  const paidCount = await env.DB.prepare("SELECT COUNT(*) AS c FROM verifications WHERE COALESCE(payment_verified, 0) = 1 AND og_number IS NOT NULL").first();
  const used = Number(paidCount && paidCount.c || 0);
  if (used >= CONFIG.ogLimit) return null;
  const next = used + 1;
  await env.DB.prepare("UPDATE verifications SET og_number = ? WHERE id = ? AND og_number IS NULL").bind(next, verificationId).run();
  return next;
}
async function handleVerifyPayment(request, env, origin) {
  let body; try { body = await request.json(); } catch { return json({ error: "Invalid JSON body" }, 400, origin); }
  const wallet = normalizeAddress(body.wallet || body.wallet_address);
  const txHash = normalizeTx(body.txHash || body.payment_tx);
  let chainId = Number(body.chainId);
  if (!wallet || !txHash) return json({ error: "Invalid wallet or transaction hash" }, 400, origin);
  try {
    let chainResult = null; let usedChain = chainId;
    const tryIds = [chainId, 4663, 1].filter((id, i, arr) => CONFIG.chains[String(id)] && arr.indexOf(id) === i);
    const errors = [];
    for (const id of tryIds) { try { chainResult = await verifyOnChain(env, id, wallet, txHash); usedChain = id; break; } catch (error) { errors.push(String(id) + ": " + error.message); } }
    if (!chainResult) throw new Error(errors.join(" | "));
    chainId = usedChain;
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
            env.DB.prepare("UPDATE referral_users SET available_balance = CAST(COALESCE(available_balance, '0') AS REAL) + 0.004, total_earned = CAST(COALESCE(total_earned, '0') AS REAL) + 0.004, referred_count = COALESCE(referred_count, 0) + 1 WHERE id = ?").bind(referrer.id),
            env.DB.prepare("INSERT OR IGNORE INTO referral_events (referrer_id, referred_verification_id, commission_amount, status) VALUES (?, ?, '0.004', 'credited')").bind(referrer.id, verification.id)
          ]);
          commissionCredited = true;
        }
      }
    }
    return json({ success: true, paymentVerified: true, network: chainResult.chainName, paidAmountMicros: chainResult.amountMicros, commissionCredited, ogNumber, referralCode: ownCode, referralLink: "https://joinveyrohood.github.io/NFTwhitelist/verify.html?ref=" + ownCode }, 200, origin);
  } catch (error) {
    return json({ error: error.message || "Payment verification failed" }, 400, origin);
  }
}
async function handleStats(env, origin) {
  try {
    const row = await env.DB.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN COALESCE(payment_verified, 0) = 1 THEN 1 ELSE 0 END) AS verified, SUM(CASE WHEN og_number IS NOT NULL THEN 1 ELSE 0 END) AS og FROM verifications").first();
    let leaderboard = [];
    try { const board = await env.DB.prepare("SELECT referral_code, referred_count, total_earned FROM referral_users ORDER BY COALESCE(referred_count, 0) DESC LIMIT 20").all(); leaderboard = board && board.results ? board.results : []; } catch (_error) {}
    return json({ success: true, supply: 10000, ogLimit: CONFIG.ogLimit, joined: Number(row && row.verified || 0), submitted: Number(row && row.total || 0), og: Number(row && row.og || 0), leaderboard }, 200, origin);
  } catch (error) {
    return json({ success: false, error: error.message || "Stats query failed", joined: 0, submitted: 0, og: 0, leaderboard: [] }, 200, origin);
  }
}
async function handleMe(request, env, origin) {
  const wallet = normalizeAddress(new URL(request.url).searchParams.get("wallet"));
  if (!wallet) return json({ error: "Wallet required" }, 400, origin);
  const verification = await env.DB.prepare("SELECT payment_verified, og_number, status FROM verifications WHERE lower(wallet_address) = ? ORDER BY id DESC LIMIT 1").bind(wallet).first();
  const ref = await env.DB.prepare("SELECT referral_code, available_balance, total_earned, referred_count FROM referral_users WHERE lower(wallet_address) = ? LIMIT 1").bind(wallet).first();
  const pending = await env.DB.prepare("SELECT id, amount, status FROM claims WHERE lower(wallet_address) = ? AND status IN ('pending','approved') ORDER BY id DESC LIMIT 1").bind(wallet).first();
  const available = money(ref && ref.available_balance);
  const paymentVerified = !!(verification && verification.payment_verified === 1);
  const ogNumber = verification && verification.og_number ? verification.og_number : null;
  const code = (ref && ref.referral_code) || (paymentVerified ? makeReferralCode(wallet) : null);
  return json({ success: true, wallet, paymentVerified, ogNumber, mintEligible: !!ogNumber, wlPool: paymentVerified && !ogNumber, status: verification ? verification.status : "none", referralCode: code, referralLink: code ? "https://joinveyrohood.github.io/NFTwhitelist/verify.html?ref=" + code : null, availableBalance: available, totalEarned: money(ref && ref.total_earned), referredCount: Number(ref && ref.referred_count || 0), canClaim: paymentVerified && available >= CONFIG.minClaim && !pending, pendingClaim: pending || null, message: !verification ? "This wallet has not submitted yet." : !paymentVerified ? "Details saved. Pay $0.02 USDG to verify." : ogNumber ? ("OG #" + ogNumber + ". This wallet can mint 1 NFT.") : "Verified. In WL / random pool for remaining 9,000." }, 200, origin);
}
async function handleClaim(request, env, origin) {
  let body; try { body = await request.json(); } catch { return json({ error: "Invalid JSON body" }, 400, origin); }
  const wallet = normalizeAddress(body.wallet || body.wallet_address);
  const chainId = Number(body.chainId || 4663);
  if (!wallet) return json({ error: "Connect wallet first" }, 400, origin);
  const user = await env.DB.prepare("SELECT id, available_balance FROM referral_users WHERE lower(wallet_address) = ? LIMIT 1").bind(wallet).first();
  if (!user) return json({ error: "No referral balance yet" }, 400, origin);
  const available = money(user.available_balance);
  if (available < CONFIG.minClaim) return json({ error: "Minimum claim is $2" }, 400, origin);
  const open = await env.DB.prepare("SELECT id FROM claims WHERE lower(wallet_address) = ? AND status IN ('pending','approved') LIMIT 1").bind(wallet).first();
  if (open) return json({ error: "A claim is already pending" }, 409, origin);
  const amount = available.toFixed(2);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO claims (wallet_address, amount, chain_id, status, updated_at) VALUES (?, ?, ?, 'pending', CURRENT_TIMESTAMP)").bind(wallet, amount, chainId),
    env.DB.prepare("UPDATE referral_users SET available_balance = '0' WHERE id = ?").bind(user.id)
  ]);
  return json({ success: true, message: "Claim submitted for $" + amount + ". Full balance is now on hold for admin review." }, 200, origin);
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
async function handleAdminClaims(request, env, origin) {
  if (!adminOk(request, env)) return json({ error: "Unauthorized" }, 401, origin);
  if (request.method === "GET") {
    const rows = await env.DB.prepare("SELECT id, wallet_address, amount, chain_id, status, payout_tx, created_at FROM claims ORDER BY id DESC LIMIT 50").all();
    return json({ success: true, claims: (rows && rows.results) || [] }, 200, origin);
  }
  let body; try { body = await request.json(); } catch { return json({ error: "Invalid JSON body" }, 400, origin); }
  const id = Number(body.id); const action = String(body.action || "");
  if (!id || !action) return json({ error: "id and action required" }, 400, origin);
  const claim = await env.DB.prepare("SELECT * FROM claims WHERE id = ? LIMIT 1").bind(id).first();
  if (!claim) return json({ error: "Claim not found" }, 404, origin);
  if (action === "reject" && claim.status === "pending") {
    await env.DB.batch([
      env.DB.prepare("UPDATE claims SET status = 'rejected', admin_note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(String(body.note || "rejected"), id),
      env.DB.prepare("UPDATE referral_users SET available_balance = CAST(COALESCE(available_balance, '0') AS REAL) + ? WHERE lower(wallet_address) = ?").bind(Number(claim.amount), claim.wallet_address)
    ]);
    return json({ success: true, message: "Claim rejected and balance returned" }, 200, origin);
  }
  if (action === "approve" && claim.status === "pending") {
    await env.DB.prepare("UPDATE claims SET status = 'approved', updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(id).run();
    return json({ success: true, message: "Claim approved. Send payout then mark paid." }, 200, origin);
  }
  if (action === "paid") {
    const tx = normalizeTx(body.payout_tx);
    if (!tx) return json({ error: "payout_tx required" }, 400, origin);
    await env.DB.prepare("UPDATE claims SET status = 'paid', payout_tx = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(tx, id).run();
    return json({ success: true, message: "Marked paid" }, 200, origin);
  }
  return json({ error: "Invalid action" }, 400, origin);
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
    try { await ensureSchema(env); } catch (error) { return json({ error: error.message || "Database unavailable" }, 500, origin); }
    if (url.pathname === "/" || url.pathname === "/api/health") return json({ status: "online", service: "VeyroHood API", version: "0.3.2", fee: "0.02 USDG" }, 200, origin);
    if ((url.pathname === "/verify" || url.pathname === "/api/verify") && request.method === "POST") return handleSubmitVerification(request, env, origin);
    if (url.pathname === "/api/verify-payment" && request.method === "POST") return handleVerifyPayment(request, env, origin);
    if ((url.pathname === "/api/stats" || url.pathname === "/stats") && request.method === "GET") return handleStats(env, origin);
    if (url.pathname === "/api/me" && request.method === "GET") return handleMe(request, env, origin);
    if (url.pathname === "/api/claim" && request.method === "POST") return handleClaim(request, env, origin);
    if (url.pathname === "/api/claims" && request.method === "GET") return handleClaims(request, env, origin);
    if (url.pathname === "/api/admin/claims") return handleAdminClaims(request, env, origin);
    return json({ error: "Not found" }, 404, origin);
  }
};
