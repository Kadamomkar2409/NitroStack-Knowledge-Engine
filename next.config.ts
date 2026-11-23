import type { NextConfig } from 'next';

const config: NextConfig = {
  poweredByHeader: false,
  serverExternalPackages: ['mongodb', 'pdf-parse'],
  async rewrites() {
    const backendUrl = process.env.BACKEND_URL?.trim();
    if (!backendUrl) return [];

    const backend = new URL(backendUrl);
    if (!['http:', 'https:'].includes(backend.protocol) || backend.username || backend.password ||
        backend.pathname !== '/' || backend.search || backend.hash) {
      throw new Error('BACKEND_URL must be an HTTP(S) origin.');
    }
    return {
      beforeFiles: [{ source: '/api/:path*', destination: `${backend.origin}/api/:path*` }],
    };
  },
};
export default config;
