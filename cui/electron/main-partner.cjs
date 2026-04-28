// Entry point for partner-server desktop builds.
// Forces --partner mode so the app always points at partner.werking.tools.
if (!process.argv.includes('--partner')) process.argv.push('--partner');
require('./main.cjs');
