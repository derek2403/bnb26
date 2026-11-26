// Build-time guard (duplicated in scripts/check-env.mjs, which runs as `prebuild`): no secret may ever be
// exposed to the browser through a NEXT_PUBLIC_ variable. Any NEXT_PUBLIC_*KEY* name fails the build.
const leaked = Object.keys(process.env).filter((k) => /^NEXT_PUBLIC_.*KEY/i.test(k));
if (leaked.length > 0) {
  throw new Error(
    `Refusing to build: ${leaked.join(", ")} would expose a secret to the browser. Use a server-only name instead.`,
  );
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  eslint: { ignoreDuringBuilds: true },
  webpack: (config) => {
    // Optional peer deps pulled in by WalletConnect / MetaMask SDK that are never used in the browser bundle.
    config.externals.push("pino-pretty", "lokijs", "encoding");
    config.resolve.fallback = { ...(config.resolve.fallback || {}), "@react-native-async-storage/async-storage": false };
    // Optional peers of @coinbase/cdp-sdk (x402 payments), reached via wagmi's baseAccount connector. Unused here.
    config.resolve.alias = {
      ...(config.resolve.alias || {}),
      "@x402/core": false,
      "@x402/evm": false,
      "@x402/svm": false,
      "@x402/extensions": false,
    };
    return config;
  },
};

export default nextConfig;
