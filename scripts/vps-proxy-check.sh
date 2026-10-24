#!/bin/bash
# Quick diagnostic: check if WARP proxy + scholarship portal are working
echo "=== WARP Status ==="
warp-cli --accept-tos status 2>/dev/null || echo "WARP not installed"
echo ""

echo "=== Direct connection (no proxy) ==="
echo -n "scholarship.up.gov.in direct: "
curl -s --connect-timeout 10 -o /dev/null -w "HTTP %{http_code} (%{time_total}s)\n" \
  https://scholarship.up.gov.in/ 2>/dev/null || echo "TIMEOUT"

echo -n "Google direct: "
curl -s --connect-timeout 10 -o /dev/null -w "HTTP %{http_code} (%{time_total}s)\n" \
  https://www.google.com/ 2>/dev/null || echo "TIMEOUT"
echo ""

echo "=== Through WARP proxy (127.0.0.1:40000) ==="
echo -n "WARP active: "
TRACE=$(curl -s --socks5-hostname 127.0.0.1:40000 --connect-timeout 10 \
  https://www.cloudflare.com/cdn-cgi/trace 2>/dev/null)
echo "$TRACE" | grep -o "warp=.*" || echo "NOT CONNECTED"

echo -n "Exit IP: "
curl -s --socks5-hostname 127.0.0.1:40000 --connect-timeout 10 \
  https://api.ipify.org 2>/dev/null || echo "FAILED"
echo ""

echo -n "scholarship.up.gov.in via WARP: "
curl -s --socks5-hostname 127.0.0.1:40000 --connect-timeout 20 \
  -o /dev/null -w "HTTP %{http_code} (%{time_total}s)\n" \
  https://scholarship.up.gov.in/ 2>/dev/null || echo "TIMEOUT"
echo ""

echo "=== Bot env check ==="
if grep -q "PORTAL_PROXY" /etc/telespark/bot.env 2>/dev/null; then
  grep "PORTAL_PROXY" /etc/telespark/bot.env | sed 's/=.*:.*@/=***:***@/'
else
  echo "PORTAL_PROXY not set in /etc/telespark/bot.env"
fi

echo ""
echo "=== Bot service ==="
systemctl is-active telespark 2>/dev/null || echo "telespark not running"
