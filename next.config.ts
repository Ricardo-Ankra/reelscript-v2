import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep Remotion's heavy, native-dependent packages out of the bundle; they run
  // only in server code (the Inngest render function calls @remotion/lambda).
  serverExternalPackages: ['@remotion/lambda', '@remotion/bundler', '@remotion/renderer'],
};

export default nextConfig;
