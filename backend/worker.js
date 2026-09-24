const CONFIG = {
  treasury: "0xf6F80827cBAf83798c7763FCd915C0068F2bE60C",
  minPayment: 300000n,
  commission: 60000n,
  ogLimit: 1000,
  allowedOrigins: [
    "https://veyrohood.com",
    "https://www.veyrohood.com",
    "https://joinveyrohood.github.io",
    "https://joinveyrohood.github.io/NFTwhitelist"
  ],
  chains: {
    "1": { name: "Ethereum", token: "0xe343167631d89B6Ffc58B88d6b7fB0228795491D", rpcKey: "ETHEREUM_RPC" },
    "4663": { name: "Robinhood", token: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", rpcKey: "ROBINHOOD_RPC" }
  }
};

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

function corsHeaders(origin) {
  const allowed = CONFIG.allowedOrigins.includes(origin) ? origin : CONFIG.allowedOrigins[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Vary": "Origin"
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) }
  });
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
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      verified_at TEXT
    )`),
    env.DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_verifications_wallet ON verifications (wallet_address)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS referral_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_address TEXT NOT NULL UNIQUE,
      referral_code TEXT NOT NULL UNIQUE,
      available_balance TEXT DEFAULT '0',
      total_earned TEXT DEFAULT '0',
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
    )`)
  ]);
}

async function rpcCall(rpcUrl, method, params = []) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  if (!response.ok) throw new Error("RPC request failed");
  const result = await response.json();
  if (result.error || result.result === undefined) throw new Error("RPC returned an error");
  return result.result;
}

async function verifyOnChain(env, chainId, wallet, txHash) {
  const chain = CONFIG.chains[String(chainId)];
  if (!chain) throw new Error("Unsupported network");
  const rpcUrl = env[chain.rpcKey];
  if (!rpcUrl) throw new Error("RPC is not configured");
  const actualChainId = await rpcCall(rpcUrl, "eth_chainId");
  if (BigInt(actualChainId) !== BigInt(chainId)) throw new Error("RPC chain ID mismatch");
  const receipt = await rpcCall(rpcUrl, "eth_getTransactionReceipt", [txHash]);
  if (!receipt) throw new Error("Transaction not found yet");
  if (receipt.status !== "0x1") throw new Error("Transaction failed on-chain");
  const tx = await rpcCall(rpcUrl, "eth_getTransactionByHash", [txHash]);
  if (!tx || normalizeAddress(tx.from) !== wallet) throw new Error("Transaction sender does not match wallet");
  let paidAmount = 0n;
  for (const log of receipt.logs || []) {
    if (normalizeAddress(log.address) !== chain.token.toLowerCase()) continue;
    if (!log.topics || log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
    const from = topicAddress(log.topics[1]);
    const to = topicAddress(log.topics[2]);
    if (from !== wallet || to !== CONFIG.treasury.toLowerCase()) continue;
    if (!/^0x[0-9a-fA-F]+$/.test(log.data || "")) continue;
    paidAmount += BigInt(log.data);
  }
  if (paidAmount < CONFIG.minPayment) throw new Error("Required USDG transfer to treasury not found");
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
  return json({
    success: true,
    id: inserted.meta.last_row_id,
    paymentRequired: true,
    amountUsd: "0.30",
    treasury: CONFIG.treasury,
    message: "Details saved. Pay $0.30 USDG to finish verification."
  }, 200, origin);
}

async function assignOgIfNeeded(env, verificationId) {
  const paidCount = await env.DB.prepare("SELECT COUNT(*) AS c FROM verifications WHERE payment_verified = 1 AND og_number IS NOT NULL").first();
  const used = Number(paidCount && paidCount.c || 0);
  if (used >= CONFIG.ogLimit) return null;
  const next = used + 1;
  await env.DB.prepare("UPDATE verifications SET og_number = ? WHERE id = ? AND og_number IS NULL").bind(next, verificationId).run();
  return next;
}

async function handleVerifyPayment(request, env, origin) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON body" }, 400, origin); }
  const wallet = normalizeAddress(body.wallet || body.wallet_address);
  const txHash = normalizeTx(body.txHash || body.payment_tx);
  const chainId = Number(body.chainId);
  if (!wallet || !txHash || !CONFIG.chains[String(chainId)]) {
    return json({ error: "Invalid wallet, transaction hash, or network" }, 400, origin);
  }
  try {
    const chainResult = await verifyOnChain(env, chainId, wallet, txHash);
    const used = await env.DB.prepare("SELECT id FROM verifications WHERE lower(payment_tx) = ? AND lower(wallet_address) != ? LIMIT 1").bind(txHash, wallet).first();
    if (used) return json({ error: "Transaction already used" }, 409, origin);
    let verification = await env.DB.prepare("SELECT id, wallet_address, referral_code, payment_verified, og_number FROM verifications WHERE lower(wallet_address) = ? ORDER BY id DESC LIMIT 1").bind(wallet).first();
    if (!verification) {
      const created = await env.DB.prepare("INSERT INTO verifications (wallet_address, status) VALUES (?, 'submitted')").bind(wallet).run();
      verification = { id: created.meta.last_row_id, wallet_address: wallet, referral_code: null, payment_verified: 0, og_number: null };
    }
    if (verification.payment_verified === 1) {
      return json({ success: true, message: "Payment already verified", ogNumber: verification.og_number }, 200, origin);
    }
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
      referralCode: ownCode,
      referralLink: "https://veyrohood.com/verify.html?ref=" + ownCode
    }, 200, origin);
  } catch (error) {
    return json({ error: error.message || "Payment verification failed" }, 400, origin);
  }
}

async function handleStats(env, origin) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN payment_verified = 1 THEN 1 ELSE 0 END) AS verified, SUM(CASE WHEN og_number IS NOT NULL THEN 1 ELSE 0 END) AS og FROM verifications").first();
  const board = await env.DB.prepare("SELECT referral_code, referred_count, total_earned FROM referral_users ORDER BY referred_count DESC, CAST(total_earned AS REAL) DESC LIMIT 10").all();
  return json({
    success: true,
    supply: 10000,
    ogLimit: CONFIG.ogLimit,
    joined: Number(row && row.verified || 0),
    submitted: Number(row && row.total || 0),
    og: Number(row && row.og || 0),
    leaderboard: board.results || []
  }, 200, origin);
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
      return json({ status: "online", service: "VeyroHood API", version: "0.2.0", fee: "0.30 USDG" }, 200, origin);
    }
    if ((url.pathname === "/verify" || url.pathname === "/api/verify") && request.method === "POST") {
      return handleSubmitVerification(request, env, origin);
    }
    if (url.pathname === "/api/verify-payment" && request.method === "POST") {
      return handleVerifyPayment(request, env, origin);
    }
    if ((url.pathname === "/api/stats" || url.pathname === "/stats") && request.method === "GET") {
      return handleStats(env, origin);
    }
    return json({ error: "Not found" }, 404, origin);
  }
};
