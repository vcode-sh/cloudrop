import type { NextConfig } from "next";

const config: NextConfig = {
  // Otherwise `next dev` writes an untracked AGENTS.md here whenever it detects a coding agent.
  agentRules: false,
};

export default config;
