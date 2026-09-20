
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://veyrohood.com",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: CORS_HEADERS,
  });
}

function isValidUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method === "GET" && path === "/") {
      return json({
        success: true,
        name: "VeyroHood API",
        version: "2.0.0",
        message: "Backend online",
      });
    }

    if (request.method === "GET" && path === "/api/health") {
      try {
        await env.DB.prepare("SELECT 1").first();
        return json({ success: true, database: "connected" });
      } catch {
        return json({
          success: false,
          database: "error",
          message: "D1 connection failed",
        }, 500);
      }
    }

    if (request.method === "POST" && path === "/api/verify") {
      let body;

      try {
        body = await request.json();
      } catch {
        return json({ success: false, error: "Invalid JSON body" }, 400);
      }

      const x_username = String(body.x_username || "").trim().replace(/^@/, "");
      const discord_username = String(body.discord_username || "").trim();
      const quote_link = String(body.quote_link || "").trim();
      const reply_link = String(body.reply_link || "").trim();
      const wallet_address = String(body.wallet_address || "").trim();

      if (!x_username || !discord_username || !quote_link || !reply_link || !wallet_address) {
        return json({ success: false, error: "All fields are required" }, 400);
      }

      if (x_username.length > 50 || discord_username.length > 100) {
        return json({ success: false, error: "Username is too long" }, 400);
      }

      if (!isValidUrl(quote_link) || !isValidUrl(reply_link)) {
        return json({ success: false, error: "Quote and reply links must be HTTPS URLs" }, 400);
      }

      if (!/^0x[a-fA-F0-9]{40}$/.test(wallet_address)) {
        return json({ success: false, error: "Invalid EVM wallet address" }, 400);
      }

      try {
        const existing = await env.DB.prepare(
          "SELECT id FROM verifications WHERE lower(wallet_address) = lower(?) LIMIT 1"
        ).bind(wallet_address).first();

        if (existing) {
          return json({
            success: false,
            error: "This wallet has already submitted an application",
          }, 409);
        }

        const result = await env.DB.prepare(`
          INSERT INTO verifications (
            x_username,
            discord_username,
            quote_link,
            reply_link,
            wallet_address,
            status,
            payment_verified,
            missions_verified,
            eligibility_status,
            created_at
          ) VALUES (?, ?, ?, ?, ?, 'pending', 0, 0, 'pending', CURRENT_TIMESTAMP)
        `).bind(
          x_username,
          discord_username,
          quote_link,
          reply_link,
          wallet_address
        ).run();

        return json({
          success: true,
          message: "Application submitted. Payment is not verified.",
          application_id: result.meta?.last_row_id ?? null,
          status: "pending",
          payment_verified: false,
        }, 201);
      } catch (error) {
        return json({
          success: false,
          error: "Database error while saving application",
        }, 500);
      }
    }

    return json({ success: false, error: "Endpoint not found" }, 404);
  },
};
