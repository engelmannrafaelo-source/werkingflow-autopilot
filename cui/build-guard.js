/**
 * Build Guard for CUI
 *
 * PREVENTS direct npm run dev/build without proper mode configuration
 * ENFORCES use of build-and-start script
 *
 * Inspired by WerkING Report's 5-layer bypass protection
 */

const ALLOWED_BUILD_MODES = ['development', 'production'];

// Check if running in allowed environment
const isVercel = process.env.VERCEL === '1';
const isRailway = Boolean(process.env.RAILWAY_ENVIRONMENT);
const hasNodeEnv = Boolean(process.env.NODE_ENV);

// Allow CI/CD platforms
if (isVercel || isRailway) {
  console.log('✅ Build guard: CI/CD platform detected, allowing build');
  process.exit(0);
}

// Require NODE_ENV to be set
if (!hasNodeEnv) {
  console.error('');
  console.error('❌ BUILD GUARD: NODE_ENV not set!');
  console.error('');
  console.error('   CUI must be built with proper environment configuration.');
  console.error('');
  console.error('   Use one of:');
  console.error('   • npm run dev:server   (development mode)');
  console.error('   • npm run build:prod   (production mode)');
  console.error('');
  console.error('   DO NOT use:');
  console.error('   • npm run dev          ❌');
  console.error('   • npm run build        ❌');
  console.error('   • npx vite build       ❌');
  console.error('');
  process.exit(1);
}

// Validate NODE_ENV value
if (!ALLOWED_BUILD_MODES.includes(process.env.NODE_ENV)) {
  console.error('');
  console.error(`❌ BUILD GUARD: Invalid NODE_ENV="${process.env.NODE_ENV}"`);
  console.error('');
  console.error(`   Allowed values: ${ALLOWED_BUILD_MODES.join(', ')}`);
  console.error('');
  process.exit(1);
}

console.log(`✅ Build guard passed: NODE_ENV=${process.env.NODE_ENV}`);
