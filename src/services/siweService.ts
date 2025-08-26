import { SiweMessage } from 'siwe';
import crypto from 'crypto';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import { IDatabaseService, SiweSession } from '../types';

export class SiweService {
  constructor(private databaseService: IDatabaseService) {}

  /**
   * Generate a secure random session ID
   */
  private generateSessionId(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Check if an address is whitelisted for admin access
   */
  isWhitelisted(address: string): boolean {
    const normalizedAddress = address.toLowerCase();
    const isAllowed = config.siwe.adminWhitelist.includes(normalizedAddress);
    
    logger.info(`SIWE whitelist check for ${address}: ${isAllowed ? 'ALLOWED' : 'DENIED'}`);
    return isAllowed;
  }

  /**
   * Create a SIWE message for user to sign
   * Uses strict EIP-4361 format - critical for wallet recognition
   */
  createMessage(address: string, nonce: string): SiweMessage {
    return new SiweMessage({
      domain: config.siwe.domain,
      address: address,
      statement: 'Sign in to ENS Market Bot Admin Dashboard',
      uri: `https://${config.siwe.domain}`,
      version: '1',
      chainId: 1, // Ethereum mainnet
      nonce: nonce,
      expirationTime: new Date(Date.now() + 10 * 60 * 1000).toISOString(), // 10 minutes
    });
  }

  /**
   * Verify a signed SIWE message and validate nonce
   * Critical: Uses official SIWE library for proper EIP-4361 verification
   */
  async verifyMessage(message: string, signature: string, expectedNonce: string): Promise<{ success: boolean; address?: string; error?: string }> {
    try {
      const siweMessage = new SiweMessage(message);
      
      // Validate nonce matches expected nonce
      if (siweMessage.nonce !== expectedNonce) {
        return { success: false, error: 'Invalid nonce' };
      }

      const result = await siweMessage.verify({ signature });

      if (!result.success) {
        return { success: false, error: 'Invalid signature' };
      }

      const address = siweMessage.address;

      // Check whitelist
      if (!this.isWhitelisted(address)) {
        logger.warn(`SIWE authentication attempted by non-whitelisted address: ${address}`);
        return { success: false, error: 'Address not authorized for admin access' };
      }

      logger.info(`SIWE authentication successful for whitelisted address: ${address}`);
      return { success: true, address };

    } catch (error: any) {
      logger.error('SIWE verification failed:', error.message);
      return { success: false, error: 'Verification failed' };
    }
  }

  /**
   * Store authenticated session in database and return sessionId
   */
  async createSession(address: string): Promise<string> {
    const sessionId = this.generateSessionId();
    
    const session: Omit<SiweSession, 'id'> = {
      address: address.toLowerCase(),
      sessionId,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() // 24 hours
    };

    await this.databaseService.createAdminSession(session);
    return sessionId;
  }

  /**
   * Validate existing session
   */
  async validateSession(sessionId: string): Promise<boolean> {
    const session = await this.databaseService.getAdminSession(sessionId);
    
    if (!session) {
      return false;
    }

    // Check if session expired
    if (new Date() > new Date(session.expiresAt)) {
      await this.databaseService.deleteAdminSession(sessionId);
      return false;
    }

    return true;
  }

  /**
   * Delete session (logout)
   */
  async deleteSession(sessionId: string): Promise<void> {
    await this.databaseService.deleteAdminSession(sessionId);
  }
}
