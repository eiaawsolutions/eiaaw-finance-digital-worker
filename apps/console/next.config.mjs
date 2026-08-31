/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // No stack traces, no source maps, no version headers in production — the
  // pentest-readiness baseline starts with not volunteering information.
  productionBrowserSourceMaps: false,
  // The repository is linted once, by the root ESLint config, which also
  // carries the D1-D8 architectural rules. Letting `next build` run a second,
  // narrower pass means the container build can fail on rules CI never ran.
  eslint: { ignoreDuringBuilds: true },
  env: {
    NEXT_PUBLIC_API_URL: process.env.PUBLIC_API_URL ?? 'http://localhost:3000',
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default nextConfig;
