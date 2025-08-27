import { Request, Response, NextFunction } from 'express';
import { SiweService } from '../services/siweService';
import { logger } from '../utils/logger';

/**
 * Middleware to require SIWE authentication for protected routes
 * This ensures only whitelisted addresses can access admin endpoints
 */
export function createAuthMiddleware(siweService: SiweService) {
  return async function requireAuth(req: Request, res: Response, next: NextFunction) {
    try {
      // Check if session exists
      const sessionId = req.session?.siweSessionId;
      const address = req.session?.address;

      if (!sessionId || !address) {
        logger.warn(`Unauthorized access attempt to ${req.path} - no session`);
        return res.status(401).json({ 
          error: 'Authentication required',
          message: 'Please sign in with your wallet to access this resource'
        });
      }

      // Validate session with database
      const isValid = await siweService.validateSession(sessionId);
      
      if (!isValid) {
        logger.warn(`Invalid session attempted access to ${req.path} - session: ${sessionId}`);
        
        // Clear invalid session
        req.session.destroy((err) => {
          if (err) {
            logger.error('Error destroying invalid session:', err);
          }
        });
        
        return res.status(401).json({ 
          error: 'Session expired',
          message: 'Your session has expired. Please sign in again.'
        });
      }

      // Double-check whitelist (defense in depth)
      if (!siweService.isWhitelisted(address)) {
        logger.warn(`Non-whitelisted address ${address} attempted access to ${req.path} with valid session`);
        
        // This shouldn't happen if authentication worked properly, but check anyway
        req.session.destroy((err) => {
          if (err) {
            logger.error('Error destroying non-whitelisted session:', err);
          }
        });
        
        return res.status(403).json({ 
          error: 'Access denied',
          message: 'Your address is not authorized to access admin functions'
        });
      }

      // Authentication successful - only log sensitive operations for audit trail
      // Comment out or use debug level for routine access logging
      // logger.debug(`Authenticated access to ${req.path} by ${address}`);
      
      // Add user info to request for downstream use
      (req as any).user = { address, sessionId };
      
      next();
    } catch (error: any) {
      logger.error(`Authentication middleware error on ${req.path}:`, error.message);
      return res.status(500).json({ 
        error: 'Authentication error',
        message: 'An error occurred during authentication'
      });
    }
  };
}

/**
 * Middleware to optionally check authentication but not require it
 * Useful for endpoints that have different behavior for authenticated users
 */
export function createOptionalAuthMiddleware(siweService: SiweService) {
  return async function optionalAuth(req: Request, res: Response, next: NextFunction) {
    try {
      const sessionId = req.session?.siweSessionId;
      const address = req.session?.address;

      if (sessionId && address) {
        const isValid = await siweService.validateSession(sessionId);
        
        if (isValid && siweService.isWhitelisted(address)) {
          (req as any).user = { address, sessionId };
          // Only log in debug mode to reduce noise
          // logger.debug(`Optional auth: ${address} authenticated for ${req.path}`);
        } else {
          // Clear invalid session but don't block request
          if (!isValid) {
            req.session.destroy((err) => {
              if (err) {
                logger.error('Error destroying invalid session in optional auth:', err);
              }
            });
          }
        }
      }
      
      next();
    } catch (error: any) {
      // Log error but don't block request
      logger.error(`Optional auth middleware error on ${req.path}:`, error.message);
      next();
    }
  };
}

/**
 * Rate limiting middleware specifically for authentication endpoints
 * Allows 1 attempt every 5 seconds, with a max of 180 attempts per 15 minutes
 */
export function createAuthRateLimiter() {
  const attempts = new Map<string, { lastAttempt: number; count: number; windowStart: number }>();
  const MIN_TIME_BETWEEN_ATTEMPTS = 5 * 1000; // 5 seconds between attempts
  const WINDOW_MS = 15 * 60 * 1000; // 15 minute window
  const MAX_ATTEMPTS_PER_WINDOW = 180; // 180 attempts per 15 minutes (allows for 1 every 5 seconds)
  
  return function authRateLimit(req: Request, res: Response, next: NextFunction) {
    const identifier = req.ip || req.connection.remoteAddress || 'unknown';
    const now = Date.now();
    
    const record = attempts.get(identifier);
    
    if (!record) {
      // First attempt from this IP
      attempts.set(identifier, { 
        lastAttempt: now, 
        count: 1, 
        windowStart: now 
      });
      return next();
    }
    
    // Check if the window has expired (15 minutes)
    if (now - record.windowStart > WINDOW_MS) {
      // Reset the window
      attempts.set(identifier, { 
        lastAttempt: now, 
        count: 1, 
        windowStart: now 
      });
      return next();
    }
    
    // Check if enough time has passed since last successful attempt (5 seconds)
    const timeSinceLastSuccess = now - record.lastAttempt;
    if (timeSinceLastSuccess < MIN_TIME_BETWEEN_ATTEMPTS) {
      const secondsToWait = Math.ceil((MIN_TIME_BETWEEN_ATTEMPTS - timeSinceLastSuccess) / 1000);
      logger.warn(`Rate limit: ${identifier} attempted auth too quickly (${timeSinceLastSuccess}ms since last successful attempt)`);
      return res.status(429).json({ 
        error: 'Too many attempts',
        message: `Please wait ${secondsToWait} more seconds before trying again`
      });
    }
    
    // Check if they've exceeded the max attempts in the current window
    if (record.count >= MAX_ATTEMPTS_PER_WINDOW) {
      const minutesLeft = Math.ceil((WINDOW_MS - (now - record.windowStart)) / 60000);
      logger.warn(`Rate limit: ${identifier} exceeded max attempts in window (${record.count} attempts)`);
      return res.status(429).json({ 
        error: 'Too many attempts',
        message: `You've exceeded the maximum attempts. Please wait ${minutesLeft} minutes`
      });
    }
    
    // Update the record
    record.lastAttempt = now;
    record.count++;
    next();
  };
}
