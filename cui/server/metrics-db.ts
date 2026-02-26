/**
 * Bridge Metrics DB Client
 * Reads metrics data directly from Dev-Server PostgreSQL (Port 54322)
 * Bypasses Bridge API for faster, more reliable access
 */
import pg from 'pg';

const { Pool } = pg;

// Connection pool to Dev-Server PostgreSQL
const pool = new Pool({
  host: 'localhost', // CUI runs on Dev-Server
  port: 54322, // werkingflow-local Supabase
  user: 'postgres',
  password: 'postgres',
  database: 'postgres',
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// Test connection on startup
pool.connect()
  .then((client) => {
    console.log('✅ Metrics DB connected (Port 54322)');
    client.release();
  })
  .catch((err) => {
    console.error('❌ Metrics DB connection failed:', err.message);
  });

// Helper: Format SQL date
const sqlDate = (daysAgo: number = 0): string => {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return date.toISOString().split('T')[0];
};

/**
 * Get realtime stats (last 24 hours from raw requests table)
 */
export async function getRealtimeStats(hours: number = 24) {
  try {
    const result = await pool.query(
      `
      SELECT
        COUNT(*) as total_requests,
        COALESCE(SUM(total_tokens), 0)::BIGINT as total_tokens,
        COALESCE(SUM(cost_usd), 0)::DECIMAL as total_cost_usd,
        COALESCE(AVG(response_time_ms)::INT, 0) as avg_response_time_ms,
        COALESCE(SUM(CASE WHEN success THEN 1 ELSE 0 END)::DECIMAL / NULLIF(COUNT(*), 0) * 100, 100) as success_rate,
        COUNT(DISTINCT session_id) as active_sessions,
        NOW() as timestamp
      FROM bridge_metrics.requests
      WHERE timestamp >= NOW() - interval '${hours} hours'
      `
    );
    return result.rows[0];
  } catch (err: any) {
    console.error('Metrics DB error (realtime):', err.message);
    return {
      total_requests: 0,
      total_tokens: 0,
      total_cost_usd: 0,
      avg_response_time_ms: 0,
      success_rate: 100,
      active_sessions: 0,
      timestamp: new Date().toISOString(),
    };
  }
}

/**
 * Get cost breakdown by model (last N days)
 */
export async function getCostBreakdown(days: number = 30) {
  try {
    const result = await pool.query(
      `
      SELECT
        model,
        SUM(requests)::INT as requests,
        SUM(tokens)::BIGINT as tokens,
        SUM(cost_usd)::DECIMAL as cost_usd,
        AVG(avg_response_time_ms)::INT as avg_response_time_ms,
        AVG(success_rate)::DECIMAL as avg_success_rate
      FROM bridge_metrics.model_daily_stats
      WHERE date >= CURRENT_DATE - interval '${days} days'
      GROUP BY model
      ORDER BY cost_usd DESC
      `
    );
    return result.rows;
  } catch (err: any) {
    console.error('Metrics DB error (cost):', err.message);
    return [];
  }
}

/**
 * Get usage by endpoint (last N days)
 */
export async function getEndpointUsage(days: number = 7) {
  try {
    const result = await pool.query(
      `
      SELECT
        endpoint,
        SUM(requests)::INT as requests,
        AVG(avg_response_time_ms)::INT as avg_response_time_ms,
        AVG(success_rate)::DECIMAL as avg_success_rate
      FROM bridge_metrics.endpoint_daily_stats
      WHERE date >= CURRENT_DATE - interval '${days} days'
      GROUP BY endpoint
      ORDER BY requests DESC
      LIMIT 20
      `
    );
    return result.rows;
  } catch (err: any) {
    console.error('Metrics DB error (usage):', err.message);
    return [];
  }
}

/**
 * Get daily aggregated stats (last N days)
 */
export async function getDailyStats(days: number = 30) {
  try {
    const result = await pool.query(
      `
      SELECT
        date,
        total_requests,
        total_tokens,
        total_cost_usd,
        avg_response_time_ms,
        success_rate,
        unique_users,
        unique_apps
      FROM bridge_metrics.daily_stats
      WHERE date >= CURRENT_DATE - interval '${days} days'
      ORDER BY date DESC
      `
    );
    return result.rows;
  } catch (err: any) {
    console.error('Metrics DB error (daily):', err.message);
    return [];
  }
}

/**
 * Get activity feed (recent requests)
 */
export async function getActivityFeed(limit: number = 50) {
  try {
    const result = await pool.query(
      `
      SELECT
        timestamp,
        endpoint,
        model,
        total_tokens,
        cost_usd,
        response_time_ms,
        success,
        error_type,
        worker_instance
      FROM bridge_metrics.requests
      ORDER BY timestamp DESC
      LIMIT ${limit}
      `
    );
    return result.rows;
  } catch (err: any) {
    console.error('Metrics DB error (activity):', err.message);
    return [];
  }
}

/**
 * Manually trigger daily stats refresh (called by cronjob or admin)
 */
export async function refreshDailyStats(targetDate?: string) {
  try {
    const date = targetDate || sqlDate(0);
    await pool.query('SELECT bridge_metrics.refresh_daily_stats($1::DATE)', [date]);
    return { success: true, date };
  } catch (err: any) {
    console.error('Metrics DB error (refresh):', err.message);
    return { success: false, error: err.message };
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Closing metrics DB pool...');
  await pool.end();
});
