/**
 * Build URL to a dev-port app from the user's browser.
 *
 * On partner.werking.tools we route through the wildcard subdomain proxy
 * (`<port>.partner.werking.tools`) so apps run unmodified on their port —
 * Next.js absolute asset paths (`/_next/...`) just work, no path rewrite,
 * no basePath. Auth is gated by nginx auth_request → /internal/auth-port.
 *
 * On dev/localhost (no wildcard cert) we fall back to the path-proxy
 * (`/app-proxy/<port>/`). Path-proxy is fragile for Next.js — if the
 * landing page doesn't depend on chunked assets it works, otherwise the
 * webpack public path issue bites. That's the *exact* reason the partner
 * subdomain proxy exists.
 */
export function devPortUrl(port: number, path: string = '/'): string {
  if (typeof window === 'undefined') return `/app-proxy/${port}${path}`;
  const host = window.location.hostname;
  if (host === 'partner.werking.tools' || host.endsWith('.partner.werking.tools')) {
    return `https://${port}.partner.werking.tools${path}`;
  }
  return `/app-proxy/${port}${path}`;
}
