import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The Claude Agent SDK spawns cli.js as a child process.
  // Turbopack only bundles imported files, so cli.js + wasm assets
  // wouldn't be included in the serverless function. This config
  // forces Next.js to trace these files into the output.
  outputFileTracingIncludes: {
    '/api/agent/chat': [
      './node_modules/@anthropic-ai/claude-agent-sdk/cli.js',
      './node_modules/@anthropic-ai/claude-agent-sdk/*.wasm',
    ],
    '/api/slack/events': [
      './node_modules/@anthropic-ai/claude-agent-sdk/cli.js',
      './node_modules/@anthropic-ai/claude-agent-sdk/*.wasm',
    ],
    '/api/slack/commands': [
      './node_modules/@anthropic-ai/claude-agent-sdk/cli.js',
      './node_modules/@anthropic-ai/claude-agent-sdk/*.wasm',
    ],
    '/api/cron/*': [
      './node_modules/@anthropic-ai/claude-agent-sdk/cli.js',
      './node_modules/@anthropic-ai/claude-agent-sdk/*.wasm',
    ],
    '/api/agent/brief': [
      './node_modules/@anthropic-ai/claude-agent-sdk/cli.js',
      './node_modules/@anthropic-ai/claude-agent-sdk/*.wasm',
    ],
  },
};

export default nextConfig;
