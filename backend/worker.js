export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    };

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    // Health check
    if (url.pathname === "/") {
      return jsonResponse({
        success: true,
        project: "VeyroHood",
        service: "Verification Backend",
        status: "online"
      }, corsHeaders);
    }

    // API status
    if (url.pathname === "/api/status") {
      return jsonResponse({
        success: true,
        verification: "not_configured",
        payment: "not_configured",
        referrals: "not_configured"
      }, corsHeaders);
    }

    // Create verification session
    if (url.pathname === "/api/verification/start" && request.method === "POST") {
      try {
        const body = await request.json();

        const wallet = String(body.wallet || "").trim();

        if (!wallet) {
          return jsonResponse({
            success: false,
            error: "Wallet address is required."
          }, corsHeaders, 400);
        }

        if (!/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
          return jsonResponse({
            success: false,
            error: "Invalid EVM wallet address."
          }, corsHeaders, 400);
        }

        // Temporary response.
        // Real nonce/session storage will be added next.
        return jsonResponse({
          success: true,
          message: "Verification session started.",
          wallet: wallet,
          next: "signature_required"
        }, corsHeaders);
      } catch (error) {
        return jsonResponse({
          success: false,
          error: "Invalid request."
        }, corsHeaders, 400);
      }
    }

    return jsonResponse({
      success: false,
      error: "Endpoint not found."
    }, corsHeaders, 404);
  }
};


function jsonResponse(data, corsHeaders, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders
    }
  });
}
