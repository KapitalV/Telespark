#!/bin/bash
# ─────────────────────────────────────────────────────────────────────
# Cloudflare WARP setup for Oracle Ubuntu ARM64 VPS
# Creates a local SOCKS5 proxy at 127.0.0.1:40000
# Set PORTAL_PROXY=socks5://127.0.0.1:40000 in /etc/telespark/bot.env
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

echo "=== Step 1: Adding Cloudflare WARP repository ==="
sudo apt-get update -qq
sudo apt-get install -y -qq curl gpg lsb-release

# Add Cloudflare GPG key
curl -fsSL https://pkg.cloudflareclient.com/pubkey.gpg \
  | sudo gpg --yes --dearmor --output /usr/share/keyrings/cloudflare-warp-archive-keyring.gpg

# Add repository
echo "deb [signed-by=/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg] https://pkg.cloudflareclient.com/ $(lsb_release -cs) main" \
  | sudo tee /etc/apt/sources.list.d/cloudflare-client.list > /dev/null

echo "=== Step 2: Installing Cloudflare WARP ==="
sudo apt-get update -qq
sudo apt-get install -y cloudflare-warp

echo "=== Step 3: Starting WARP service ==="
sudo systemctl enable --now warp-svc

# Give the service a moment to initialize
sleep 3

echo "=== Step 4: Registering WARP client ==="
# Accept Cloudflare TOS non-interactively
warp-cli --accept-tos registration new 2>/dev/null || echo "(Already registered)"

echo "=== Step 5: Setting proxy mode (SOCKS5 on port 40000) ==="
warp-cli --accept-tos mode proxy
warp-cli --accept-tos proxy port 40000

echo "=== Step 6: Connecting to Cloudflare network ==="
warp-cli --accept-tos connect

# Wait for connection
sleep 5

echo "=== Step 7: Verifying ==="
echo ""
echo "WARP status:"
warp-cli status
echo ""

echo "Testing SOCKS5 proxy (Cloudflare trace):"
TRACE=$(curl -s --socks5-hostname 127.0.0.1:40000 --connect-timeout 10 \
  https://www.cloudflare.com/cdn-cgi/trace 2>/dev/null || echo "FAILED")
echo "$TRACE" | head -5
echo ""

if echo "$TRACE" | grep -q "warp=on"; then
  echo "✅ WARP proxy is working!"
  echo ""
  echo "Testing scholarship portal through WARP..."
  HTTP_CODE=$(curl -s --socks5-hostname 127.0.0.1:40000 --connect-timeout 20 \
    -o /dev/null -w "%{http_code}" \
    https://scholarship.up.gov.in/ 2>/dev/null || echo "000")
  echo "Scholarship portal HTTP status: $HTTP_CODE"
  if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "302" ]; then
    echo "✅ Scholarship portal is REACHABLE through WARP!"
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  SUCCESS! Add this to /etc/telespark/bot.env:"
    echo ""
    echo "  PORTAL_PROXY=socks5://127.0.0.1:40000"
    echo ""
    echo "  Then restart: sudo systemctl restart telespark"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  else
    echo "⚠️  Portal returned HTTP $HTTP_CODE through WARP."
    echo "   NIC may also block Cloudflare IPs. Try a paid ISP proxy instead."
  fi
else
  echo "❌ WARP proxy is NOT working. Check warp-cli status."
fi
