// Route Playwright browsers through a SOCKS/HTTP proxy when the scholarship
// portal is unreachable from the host network (e.g. NIC blocks cloud-provider
// IP ranges).  Set PORTAL_PROXY in the environment to a proxy URL such as
// "socks5://127.0.0.1:1080" or "http://127.0.0.1:8080".
//
// Only Playwright browser traffic is affected.  Telegram API calls, DNS
// resolution and other Node.js HTTP requests bypass the proxy entirely.

import {chromium} from 'playwright';

const PORTAL_PROXY = (process.env.PORTAL_PROXY || '').trim();

/**
 * Returns a `launch` function suitable for the portal constructors' `launch`
 * option.  When PORTAL_PROXY is set, each launched browser routes all traffic
 * through the configured proxy.  When unset, the function delegates directly
 * to `chromium.launch` with no proxy.
 */
export function portalLauncher() {
  const portalProxy = (process.env.PORTAL_PROXY || '').trim();
  const isLinux = process.platform === 'linux';
  return options => {
    const defaultArgs = isLinux ? ['--no-sandbox', '--disable-setuid-sandbox'] : [];
    const args = Array.from(new Set([...(options?.args || []), ...defaultArgs]));
    const launchOptions = {...options, args};
    if (portalProxy) {
      launchOptions.proxy = {server: portalProxy};
    }
    return chromium.launch(launchOptions);
  };
}
