export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // =========================
    // CORS
    // =========================
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    };

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    // =========================
    // HEALTH CHECK
    // =========================
    if (request.method === "GET" && url.pathname === "/") {
      return jsonResponse(
        {
          success: true,
          project: "VeyroHood",
          service: "Verification Backend",
          status: "online"
        },
        corsHeaders
      );
    }

    // =========================
    // API STATUS
    // =========================
    if (request.method === "GET" && url.pathname === "/api/status") {
      return jsonResponse(
        {
          success: true,
          verification: "ready",
          database: "connected",
          payment: "not_configured",
          referrals: "not_configured"
        },
        corsHeaders
      );
    }

    // =========================
    // VERIFY SUBMISSION
    // =========================
    if (
      request.method === "POST" &&
      url.pathname === "/verify"
    ) {
      try {
        const data = await request.json();

        const x_username = String(
          data.x_username || ""
        ).trim();

        const discord_username = String(
          data.discord_username || ""
        ).trim();

        const quote_link = String(
          data.quote_link || ""
        ).trim();

        const reply_link = String(
          data.reply_link || ""
        ).trim();

        const wallet_address = String(
          data.wallet_address || ""
        ).trim();

        const payment_tx =
          data.payment_tx
            ? String(data.payment_tx).trim()
            : null;

        const payment_amount =
          data.payment_amount
            ? String(data.payment_amount).trim()
            : null;

        // =========================
        // REQUIRED FIELD CHECK
        // =========================
        if (
          !x_username ||
          !discord_username ||
          !quote_link ||
          !reply_link ||
          !wallet_address
        ) {
          return jsonResponse(
            {
              success: false,
              error: "Missing required fields."
            },
            corsHeaders,
            400
          );
        }

        // =========================
        // WALLET VALIDATION
        // =========================
        if (
          !/^0x[a-fA-F0-9]{40}$/.test(
            wallet_address
          )
        ) {
          return jsonResponse(
            {
              success: false,
              error: "Invalid EVM wallet address."
            },
            corsHeaders,
            400
          );
        }

        // =========================
        // URL VALIDATION
        // =========================
        if (
          !isValidUrl(quote_link) ||
          !isValidUrl(reply_link)
        ) {
          return jsonResponse(
            {
              success: false,
              error: "Invalid quote or reply link."
            },
            corsHeaders,
            400
          );
        }

        // =========================
        // CHECK DUPLICATE WALLET
        // =========================
        const existing =
          await env.DB.prepare(
            `
            SELECT id, status
            FROM verifications
            WHERE LOWER(wallet_address) = LOWER(?)
            LIMIT 1
            `
          )
            .bind(wallet_address)
            .first();

        if (existing) {
          return jsonResponse(
            {
              success: false,
              error:
                "This wallet has already submitted a verification request.",
              id: existing.id,
              status: existing.status
            },
            corsHeaders,
            409
          );
        }

        // =========================
        // SAVE TO D1
        // =========================
        const result =
          await env.DB.prepare(
            `
            INSERT INTO verifications
            (
              x_username,
              discord_username,
              quote_link,
              reply_link,
              wallet_address,
              payment_tx,
              payment_amount,
              status
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
            `
          )
            .bind(
              x_username,
              discord_username,
              quote_link,
              reply_link,
              wallet_address,
              payment_tx,
              payment_amount
            )
            .run();

        // =========================
        // SUCCESS
        // =========================
        return jsonResponse(
          {
            success: true,
            message:
              "Verification submitted successfully.",
            id: result.meta.last_row_id,
            status: "pending"
          },
          corsHeaders
        );

      } catch (error) {
        console.error(
          "Verification error:",
          error
        );

        return jsonResponse(
          {
            success: false,
            error:
              "Server error while submitting verification."
          },
          corsHeaders,
          500
        );
      }
    }

    // =========================
    // NOT FOUND
    // =========================
    return jsonResponse(
      {
        success: false,
        error: "Endpoint not found."
      },
      corsHeaders,
      404
    );
  }
};


// =========================
// URL VALIDATOR
// =========================

function isValidUrl(value) {
  try {
    const url = new URL(value);

    return (
      url.protocol === "https:" ||
      url.protocol === "http:"
    );
  } catch {
    return false;
  }
}


// =========================
// JSON RESPONSE
// =========================

function jsonResponse(
  data,
  corsHeaders,
  status = 200
) {
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders
      }
    }
  );
}