const CONFIG = {
  treasury: "0xf6F80827cBAf83798c7763FCd915C0068F2bE60C",
  minPayment: 300000n, // 0.30 USDG, 6 decimals
  commission: 60000n, // 20% of 0.30 USDG
  corsOrigin: "https://veyrohood.com",
  chains: {
    "1": {
      name: "Ethereum",
      token: "0xe343167631d89B6Ffc58B88d6b7fB0228795491D",
      rpcKey: "ETHEREUM_RPC",
    },
    "4663": {
      name: "Robinhood",
      token: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
      rpcKey: "ROBINHOOD_RPC",
    },
  },
};

const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": CONFIG.corsOrigin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Vary": "Origin",
    },
  });
}

function normalizeAddress(value) {
  return typeof value === "string" &&
    /^0x[a-fA-F0-9]{40}$/.test(value)
    ? value.toLowerCase()
    : null;
}

function normalizeTx(value) {
  return typeof value === "string" &&
    /^0x[a-fA-F0-9]{64}$/.test(value)
    ? value.toLowerCase()
    : null;
}

function topicAddress(topic) {
  if (!topic || !/^0x[a-fA-F0-9]{64}$/.test(topic)) return null;
  return ("0x" + topic.slice(-40)).toLowerCase();
}

async function rpcCall(rpcUrl, method, params = []) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    }),
  });

  if (!response.ok) throw new Error("RPC request failed");
  const result = await response.json();
  if (result.error || result.result === undefined) {
    throw new Error("RPC returned an error");
  }
  return result.result;
}

async function verifyOnChain(env, chainId, wallet, txHash) {
  const chain = CONFIG.chains[String(chainId)];
  if (!chain) throw new Error("Unsupported network");

  const rpcUrl = env[chain.rpcKey];
  if (!rpcUrl) throw new Error("RPC is not configured");

  const actualChainId = await rpcCall(rpcUrl, "eth_chainId");
  if (BigInt(actualChainId) !== BigInt(chainId)) {
    throw new Error("RPC chain ID mismatch");
  }

  const receipt = await rpcCall(
    rpcUrl,
    "eth_getTransactionReceipt",
    [txHash]
  );

  if (!receipt) throw new Error("Transaction not found yet");
  if (receipt.status !== "0x1") {
    throw new Error("Transaction failed on-chain");
  }

  const tx = await rpcCall(rpcUrl, "eth_getTransactionByHash", [txHash]);
  if (!tx || normalizeAddress(tx.from) !== wallet) {
    throw new Error("Transaction sender does not match wallet");
  }

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

  if (paidAmount < CONFIG.minPayment) {
    throw new Error("Required USDG transfer to treasury not found");
  }

  return {
    chainName: chain.name,
    amountMicros: paidAmount.toString(),
  };
}

async function handleVerifyPayment(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const wallet = normalizeAddress(body.wallet);
  const txHash = normalizeTx(body.txHash);
  const chainId = Number(body.chainId);

  if (!wallet || !txHash || !CONFIG.chains[String(chainId)]) {
    return json({ error: "Invalid wallet, transaction hash, or network" }, 400);
  }

  try {
    // Verify real transaction before changing database records.
    const chainResult = await verifyOnChain(env, chainId, wallet, txHash);

    // Transaction hash must not already belong to another submission.
    const used = await env.DB.prepare(
      `SELECT id FROM verifications
       WHERE lower(payment_tx) = ? AND lower(wallet_address) != ?
       LIMIT 1`
    ).bind(txHash, wallet).first();

    if (used) {
      return json({ error: "Transaction already used" }, 409);
    }

    const verification = await env.DB.prepare(
      `SELECT id, wallet_address, referral_code, payment_verified
       FROM verifications
       WHERE lower(wallet_address) = ?
       ORDER BY id DESC LIMIT 1`
    ).bind(wallet).first();

    if (!verification) {
      return json({ error: "Whitelist submission not found for wallet" }, 404);
    }

    if (verification.payment_verified === 1) {
      if ((await env.DB.prepare(
        `SELECT id FROM verifications
         WHERE id = ? AND lower(payment_tx) = ?`
      ).bind(verification.id, txHash).first())) {
        return json({ success: true, message: "Payment already verified" });
      }
      return json({ error: "Wallet already has a verified payment" }, 409);
    }

    const update = await env.DB.prepare(
      `UPDATE verifications
       SET payment_tx = ?, payment_amount = ?, payment_verified = 1,
           network = ?, status = 'pending', verified_at = CURRENT_TIMESTAMP
       WHERE id = ? AND COALESCE(payment_verified, 0) = 0`
    ).bind(
      txHash,
      chainResult.amountMicros,
      chainResult.chainName,
      verification.id
    ).run();

    if (!update.meta.changes) {
      return json({ error: "Payment record changed; please retry" }, 409);
    }

    // Credit referral commission only when the submitted code resolves
    // to a different, registered referrer.
    let commissionCredited = false;
    const referralCode = verification.referral_code;

    if (referralCode && chainResult.amountMicros) {
      const referrer = await env.DB.prepare(
        `SELECT id, wallet_address FROM referral_users
         WHERE referral_code = ? LIMIT 1`
      ).bind(referralCode).first();

      if (
        referrer &&
        normalizeAddress(referrer.wallet_address) !== wallet
      ) {
        const idempotencyKey = `commission:${chainId}:${txHash}`;

        const ledgerInsert = await env.DB.prepare(
          `INSERT OR IGNORE INTO referral_ledger
           (referrer_wallet, source_wallet, source_payment_tx, chain_id,
            amount_usdg_micros, entry_type, idempotency_key)
           VALUES (?, ?, ?, ?, ?, 'commission', ?)`
        ).bind(
          normalizeAddress(referrer.wallet_address),
          wallet,
          txHash,
          chainId,
          Number(CONFIG.commission),
          idempotencyKey
        ).run();

        if (ledgerInsert.meta.changes === 1) {
          await env.DB.batch([
            env.DB.prepare(
              `UPDATE referral_users
               SET available_balance =
                     CAST(COALESCE(available_balance, '0') AS REAL) + 0.06,
                   total_earned =
                     CAST(COALESCE(total_earned, '0') AS REAL) + 0.06,
                   referred_count = COALESCE(referred_count, 0) + 1
               WHERE id = ?`
            ).bind(referrer.id),

            env.DB.prepare(
              `INSERT OR IGNORE INTO referral_events
               (referrer_id, referred_verification_id, commission_amount, status)
               VALUES (?, ?, '0.06', 'credited')`
            ).bind(referrer.id, verification.id),
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
    });
  } catch (error) {
    return json({ error: error.message || "Payment verification failed" }, 400);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": CONFIG.corsOrigin,
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Vary": "Origin",
        },
      });
    }

    if (url.pathname === "/" || url.pathname === "/api/health") {
      return json({
        status: "online",
        service: "VeyroHood API",
        version: "0.1.0",
      });
    }

    if (url.pathname === "/api/verify-payment" && request.method === "POST") {
      return handleVerifyPayment(request, env);
    }

    return json({ error: "Not found" }, 404);
  },
};