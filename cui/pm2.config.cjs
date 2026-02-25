module.exports = {
  apps: [
    {
      name: 'cui-local',
      script: '/opt/homebrew/bin/cui-server',
      args: '--port 4004 --skip-auth-token',
      filter_env: ['CLAUDECODE', 'CLAUDE_CODE_', 'CLAUDE_AGENT_'],
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
