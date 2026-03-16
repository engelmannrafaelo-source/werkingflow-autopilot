/**
 * Async Handler Middleware for Express Routes
 *
 * DEFENSIVE PROGRAMMING: Wraps async route handlers to catch errors and prevent unhandled rejections
 *
 * Usage:
 * ```typescript
 * import { asyncHandler } from './middleware/async-handler';
 *
 * app.get('/api/example', asyncHandler(async (req, res) => {
 *   const data = await someAsyncOperation();
 *   res.json(data);
 * }));
 * ```
 */

import { Request, Response, NextFunction, RequestHandler } from 'express';

type AsyncRequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction
) => Promise<void | any>;

/**
 * Wraps async Express route handlers to catch errors
 *
 * - Catches async errors and forwards to Express error handler
 * - Prevents unhandled promise rejections
 * - Logs errors with request context
 */
export function asyncHandler(fn: AsyncRequestHandler): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch((err) => {
      console.error(`[AsyncHandler] Route error [${req.method} ${req.path}]:`, err);

      // If headers already sent, can't send error response
      if (res.headersSent) {
        return next(err);
      }

      // Defensive: Send error response
      res.status(err.status || 500).json({
        error: err.message || 'Internal server error',
        path: req.path,
        method: req.method,
      });
    });
  };
}

/**
 * Validates required fields in request body
 *
 * Throws 400 if any field is missing
 */
export function requireFields(body: any, fields: string[]): void {
  const missing = fields.filter((f) => body[f] === undefined || body[f] === null);
  if (missing.length > 0) {
    const err: any = new Error(`Missing required fields: ${missing.join(', ')}`);
    err.status = 400;
    throw err;
  }
}

/**
 * Validates required query parameters
 *
 * Throws 400 if any param is missing
 */
export function requireQuery(query: any, params: string[]): void {
  const missing = params.filter((p) => query[p] === undefined || query[p] === null);
  if (missing.length > 0) {
    const err: any = new Error(`Missing required query params: ${missing.join(', ')}`);
    err.status = 400;
    throw err;
  }
}

/**
 * Safe JSON response with validation
 *
 * Prevents sending undefined/null to client
 */
export function safeJsonResponse(res: Response, data: any): void {
  if (data === undefined || data === null) {
    console.warn('[SafeResponse] Attempted to send null/undefined - sending empty object');
    res.json({});
    return;
  }
  res.json(data);
}
