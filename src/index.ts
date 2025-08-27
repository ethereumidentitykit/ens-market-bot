import express from 'express';
import session from 'express-session';
import path from 'path';
import CryptoJS from 'crypto-js';
import axios from 'axios';
import { generateNonce } from 'siwe';
import { config, validateConfig } from './utils/config';
import { logger } from './utils/logger';
import { MONITORED_CONTRACTS } from './config/contracts';
import { MoralisService } from './services/moralisService';
import { AlchemyService } from './services/alchemyService';
import { DatabaseService } from './services/databaseService';
import { IDatabaseService, ENSRegistration } from './types';
import { SalesProcessingService } from './services/salesProcessingService';
import { BidsProcessingService } from './services/bidsProcessingService';
import { MagicEdenService } from './services/magicEdenService';
import { SchedulerService } from './services/schedulerService';
import { TwitterService } from './services/twitterService';
import { NewTweetFormatter } from './services/newTweetFormatter';
import { RateLimitService } from './services/rateLimitService';
import { ENSWorkerService } from './services/ensWorkerService';
import { APIToggleService } from './services/apiToggleService';
import { AutoTweetService } from './services/autoTweetService';
import { WorldTimeService } from './services/worldTimeService';
import { SiweService } from './services/siweService';
import pgSession from 'connect-pg-simple';

// Extend express-session types
declare module 'express-session' {
  interface SessionData {
    nonce?: string;
    siweSessionId?: string;
    address?: string;
  }
}

async function startApplication(): Promise<void> {
  try {
    // Validate configuration
    validateConfig();
    logger.info('Configuration validated successfully');

    // Initialize services
    const moralisService = new MoralisService();
    const alchemyService = new AlchemyService();
    
    // Initialize PostgreSQL database service
    const databaseService: IDatabaseService = new DatabaseService();
    
    const salesProcessingService = new SalesProcessingService(moralisService, databaseService);
    const magicEdenService = new MagicEdenService();
    const bidsProcessingService = new BidsProcessingService(magicEdenService, databaseService, alchemyService);
    const twitterService = new TwitterService();
    const newTweetFormatter = new NewTweetFormatter(databaseService, alchemyService);
    const rateLimitService = new RateLimitService(databaseService);
    const ethIdentityService = new ENSWorkerService();
    const worldTimeService = new WorldTimeService();
    const siweService = new SiweService(databaseService);
    const autoTweetService = new AutoTweetService(newTweetFormatter, twitterService, rateLimitService, databaseService, worldTimeService);
    const schedulerService = new SchedulerService(salesProcessingService, bidsProcessingService, autoTweetService, databaseService);

    // Initialize database
    await databaseService.initialize();
    logger.info('Database initialized successfully');

    // Initialize scheduler state from database (don't auto-start)
    await schedulerService.initializeFromDatabase();
    logger.info('Scheduler initialized (use dashboard to start if needed)');

    // Initialize Express app
    const app = express();

    // Make services available to controllers
    app.locals.databaseService = databaseService;
    app.locals.ethIdentityService = ethIdentityService;

    // Middleware
    app.use(express.json());
    app.use(express.static(path.join(__dirname, '../public')));
    
    // Session configuration for SIWE authentication using PostgreSQL
    const PgSession = pgSession(session);
    const pgSessionStore = new PgSession({
      pool: databaseService.pgPool, // Reuse our existing connection pool
      tableName: 'session', // Standard express-session table
      createTableIfMissing: true
    });

    app.use(session({
      store: pgSessionStore,
      secret: config.siwe.sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: { 
        secure: config.nodeEnv === 'production',
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
      },
      name: 'ens-bot-session'
    }));

    // Basic health check endpoint
    app.get('/health', (req, res) => {
      res.json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        environment: config.nodeEnv,
        contracts: config.contracts.length,
        contractAddresses: config.contracts
      });
    });

    // SIWE Authentication Routes

    // Generate nonce for SIWE message
    app.get('/api/siwe/nonce', (req, res) => {
      try {
        const nonce = generateNonce();
        req.session.nonce = nonce;
        res.json({ nonce });
        logger.info(`Generated SIWE nonce: ${nonce}`);
      } catch (error: any) {
        logger.error('Error generating SIWE nonce:', error.message);
        res.status(500).json({ error: 'Failed to generate nonce' });
      }
    });

    // Verify SIWE signature and create session
    app.post('/api/siwe/verify', async (req, res) => {
      try {
        const { message, signature } = req.body;
        const nonce = req.session.nonce;

        if (!message || !signature) {
          return res.status(400).json({ error: 'Message and signature required' });
        }

        if (!nonce) {
          return res.status(400).json({ error: 'Nonce not found. Please generate a new nonce.' });
        }

        // Verify SIWE signature
        const result = await siweService.verifyMessage(message, signature, nonce);
        
        if (!result.success || !result.address) {
          return res.status(401).json({ error: result.error || 'Invalid signature' });
        }

        // Check whitelist
        if (!siweService.isWhitelisted(result.address)) {
          logger.warn(`SIWE login attempt by non-whitelisted address: ${result.address}`);
          return res.status(403).json({ error: 'Address not authorized for admin access' });
        }

        // Create session
        const sessionId = await siweService.createSession(result.address);
        req.session.siweSessionId = sessionId;
        req.session.address = result.address;
        
        // Clear nonce
        delete req.session.nonce;
        
        res.json({ 
          success: true, 
          address: result.address,
          message: 'Successfully authenticated'
        });

        logger.info(`✅ SIWE authentication successful for ${result.address}`);
      } catch (error: any) {
        logger.error('Error verifying SIWE signature:', error.message);
        res.status(500).json({ error: 'Authentication failed' });
      }
    });

    // Get current session info
    app.get('/api/siwe/me', async (req, res) => {
      try {
        const sessionId = req.session.siweSessionId;
        
        if (!sessionId) {
          return res.status(401).json({ error: 'Not authenticated' });
        }

        const isValid = await siweService.validateSession(sessionId);
        if (!isValid) {
          // Clear invalid session
          req.session.destroy((err) => {
            if (err) logger.error('Error destroying session:', err);
          });
          return res.status(401).json({ error: 'Session expired' });
        }

        res.json({ 
          authenticated: true,
          address: req.session.address,
          sessionId: sessionId
        });
      } catch (error: any) {
        logger.error('Error checking SIWE session:', error.message);
        res.status(500).json({ error: 'Session check failed' });
      }
    });

    // Logout endpoint
    app.post('/api/siwe/logout', async (req, res) => {
      try {
        const sessionId = req.session.siweSessionId;
        
        if (sessionId) {
          await siweService.deleteSession(sessionId);
          logger.info(`🚪 SIWE session ${sessionId} logged out`);
        }
        
        req.session.destroy((err) => {
          if (err) {
            logger.error('Error destroying session:', err);
            return res.status(500).json({ error: 'Logout failed' });
          }
          
          res.json({ success: true, message: 'Logged out successfully' });
        });
      } catch (error: any) {
        logger.error('Error during SIWE logout:', error.message);
        res.status(500).json({ error: 'Logout failed' });
      }
    });

    // Get contract configuration
    app.get('/api/contracts', (req, res) => {
      res.json({ 
        success: true,
        contracts: MONITORED_CONTRACTS
      });
    });

    // Test API endpoint
    app.get('/api/test-moralis', async (req, res) => {
      try {
        const isConnected = await moralisService.testConnection();
        res.json({
          success: isConnected,
          message: isConnected ? 'Moralis API connection successful' : 'Moralis API connection failed'
        });
      } catch (error: any) {
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    // Test Alchemy ETH price endpoint
    app.get('/api/test-alchemy-price', async (req, res) => {
      try {
        const startTime = Date.now();
        const ethPrice = await alchemyService.getETHPriceUSD();
        const fetchTime = Date.now() - startTime;
        
        res.json({
          success: true,
          message: 'Alchemy ETH price fetched successfully',
          data: {
            ethPriceUsd: ethPrice,
            fetchTimeMs: fetchTime,
            timestamp: new Date().toISOString()
          }
        });
      } catch (error: any) {
        res.status(500).json({
          success: false,
          message: 'Error fetching ETH price from Alchemy',
          error: error.message
        });
      }
    });

    // Manual fetch endpoint for testing
    app.get('/api/fetch-sales', async (req, res) => {
      try {
        const { contractAddress, limit } = req.query;
        
        if (contractAddress) {
          // Fetch for specific contract
          const response = await moralisService.getNFTTrades(
            contractAddress as string,
            parseInt(limit as string) || 300
          );
          res.json({ success: true, data: response });
        } else {
          // Fetch for all contracts
          const sales = await moralisService.getAllRecentTrades(
            parseInt(limit as string) || 300
          );
          res.json({ success: true, data: { trades: sales, count: sales.length } });
        }
      } catch (error: any) {
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    // Debug endpoint to check Moralis configuration
    app.get('/api/debug/moralis', async (req, res) => {
      try {
        const hasApiKey = !!config.moralis?.apiKey;
        const apiKeyLength = config.moralis?.apiKey?.length || 0;
        const baseUrl = config.moralis?.baseUrl;
        
        // Try a simple API call
        let apiTestResult = null;
        try {
          // Use first contract from our configuration for testing
          const testContract = MONITORED_CONTRACTS[0].address;
          const testResult = await moralisService.getNFTTrades(testContract, 1);
          apiTestResult = {
            success: true,
            resultCount: testResult?.trades?.length || 0,
            hasResult: !!testResult?.trades
          };
        } catch (error: any) {
          apiTestResult = {
            success: false,
            error: error.message
          };
        }
        
        res.json({
          success: true,
          debug: {
            hasApiKey,
            apiKeyLength,
            baseUrl,
            environment: config.nodeEnv,
            apiTestResult
          }
        });
      } catch (error: any) {
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    // Processing endpoints
    app.get('/api/process-sales', async (req, res) => {
      try {
        const results = await salesProcessingService.processNewSales();
        res.json({
          success: true,
          data: results
        });
      } catch (error: any) {
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    // Historical data population endpoint
    app.post('/api/populate-historical', async (req, res) => {
      try {
        const { targetBlock, contractAddress, resumeCursor } = req.body;
        
        // Default to 23100000 for testing
        const target = targetBlock || 23100000;
        
        logger.info(`API: Starting historical population to block ${target}`);
        
        // Get historical trades from Moralis
        const fetchResults = await moralisService.populateHistoricalData(
          target,
          contractAddress,
          resumeCursor
        );
        
        // Now process the trades through our existing logic
        let processedSales = 0;
        let filteredSales = 0;
        let duplicateSales = 0;
        let errorCount = 0;
        
        if (fetchResults.trades && fetchResults.trades.length > 0) {
          logger.info(`Processing ${fetchResults.trades.length} fetched trades through sales processing logic...`);
          
          for (const trade of fetchResults.trades) {
            try {
              // Check if already processed (duplicate detection)
              const isAlreadyProcessed = await databaseService.isSaleProcessed(trade.tokenId);
              
              if (isAlreadyProcessed) {
                duplicateSales++;
                logger.debug(`Skipping duplicate sale: ${trade.transactionHash}`);
                continue;
              }

              // Apply filters using SalesProcessingService logic
              if (!salesProcessingService.shouldProcessSalePublic(trade)) {
                filteredSales++;
                const totalPriceEth = parseFloat(salesProcessingService.calculateTotalPricePublic(trade));
                logger.debug(`Filtering out sale below 0.1 ETH: ${totalPriceEth} ETH (tx: ${trade.transactionHash})`);
                continue;
              }

              // Convert and store the sale using SalesProcessingService logic
              const processedSale = await salesProcessingService.convertToProcessedSalePublic(trade);
              await databaseService.insertSale(processedSale);
              
              processedSales++;
              const totalPriceEth = parseFloat(salesProcessingService.calculateTotalPricePublic(trade));
              logger.debug(`Processed historical sale: ${trade.transactionHash} for ${totalPriceEth} ETH`);

            } catch (error: any) {
              errorCount++;
              logger.error(`Failed to process historical sale ${trade.transactionHash}:`, error.message);
            }
          }
        }
        
        const finalResults = {
          ...fetchResults,
          actualProcessed: processedSales,
          actualFiltered: filteredSales,
          actualDuplicates: duplicateSales,
          actualErrors: errorCount
        };
        
        logger.info(`Historical population complete: ${processedSales} processed, ${filteredSales} filtered, ${duplicateSales} duplicates, ${errorCount} errors`);
        
        res.json({
          success: true,
          data: finalResults
        });
      } catch (error: any) {
        logger.error('Historical population failed:', error.message);
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    app.get('/api/stats', async (req, res) => {
      try {
        const stats = await salesProcessingService.getProcessingStats();
        res.json({
          success: true,
          data: stats
        });
      } catch (error: any) {
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    app.get('/api/unposted-sales', async (req, res) => {
      try {
        const limit = parseInt(req.query.limit as string) || 500; // Increased for testing
        const recentSales = await databaseService.getRecentSales(limit); // Changed to get ALL sales
        res.json({
          success: true,
          data: recentSales,
          count: recentSales.length
        });
      } catch (error: any) {
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    app.get('/api/unposted-registrations', async (req, res) => {
      try {
        const limit = parseInt(req.query.limit as string) || 500; // Increased for testing
        const recentRegistrations = await databaseService.getRecentRegistrations(limit); // Changed to get ALL registrations
        res.json({
          success: true,
          data: recentRegistrations,
          count: recentRegistrations.length
        });
      } catch (error: any) {
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    // Scheduler endpoints
    app.get('/api/scheduler/status', (req, res) => {
      try {
        const status = schedulerService.getStatus();
        res.json({
          success: true,
          data: status
        });
      } catch (error: any) {
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    app.post('/api/scheduler/start', async (req, res) => {
      try {
        await schedulerService.start();
        res.json({
          success: true,
          message: 'Scheduler started'
        });
      } catch (error: any) {
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    app.post('/api/scheduler/stop', async (req, res) => {
      try {
        await schedulerService.stop();
        res.json({
          success: true,
          message: 'Scheduler stopped'
        });
      } catch (error: any) {
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    app.post('/api/scheduler/force-stop', async (req, res) => {
      try {
        await schedulerService.forceStop();
        res.json({
          success: true,
          message: 'Scheduler force stopped - all activity halted'
        });
      } catch (error: any) {
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    app.post('/api/scheduler/reset-errors', (req, res) => {
      try {
        schedulerService.resetErrorCounter();
        res.json({
          success: true,
          message: 'Error counter reset'
        });
      } catch (error: any) {
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });



    // Initialize API Toggle Service with database
    const apiToggleService = APIToggleService.getInstance();
    await apiToggleService.initialize(databaseService);

    // Admin API Toggle endpoints
    app.post('/api/admin/toggle-twitter', async (req, res) => {
      try {
        const { enabled } = req.body;
        if (typeof enabled !== 'boolean') {
          return res.status(400).json({
            success: false,
            error: 'enabled must be a boolean'
          });
        }

        await apiToggleService.setTwitterEnabled(enabled);
        
        logger.info(`Twitter API ${enabled ? 'enabled' : 'disabled'} via admin toggle`);
        
        const state = apiToggleService.getState();
        res.json({
          success: true,
          twitterEnabled: state.twitterEnabled,
          autoPostingEnabled: state.autoPostingEnabled
        });
      } catch (error: any) {
        logger.error('Toggle Twitter API error:', error);
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    app.post('/api/admin/toggle-moralis', async (req, res) => {
      try {
        const { enabled } = req.body;
        if (typeof enabled !== 'boolean') {
          return res.status(400).json({
            success: false,
            error: 'enabled must be a boolean'
          });
        }

        await apiToggleService.setMoralisEnabled(enabled);
        logger.info(`Moralis API ${enabled ? 'enabled' : 'disabled'} via admin toggle`);
        
        const state = apiToggleService.getState();
        res.json({
          success: true,
          moralisEnabled: state.moralisEnabled
        });
      } catch (error: any) {
        logger.error('Toggle Moralis API error:', error);
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    app.post('/api/admin/toggle-magic-eden', async (req, res) => {
      try {
        const { enabled } = req.body;
        if (typeof enabled !== 'boolean') {
          return res.status(400).json({
            success: false,
            error: 'enabled must be a boolean'
          });
        }

        await apiToggleService.setMagicEdenEnabled(enabled);
        logger.info(`Magic Eden API ${enabled ? 'enabled' : 'disabled'} via admin toggle`);
        
        const state = apiToggleService.getState();
        res.json({
          success: true,
          magicEdenEnabled: state.magicEdenEnabled
        });
      } catch (error: any) {
        logger.error('Toggle Magic Eden API error:', error);
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    app.post('/api/admin/toggle-auto-posting', async (req, res) => {
      try {
        const { enabled } = req.body;
        if (typeof enabled !== 'boolean') {
          return res.status(400).json({
            success: false,
            error: 'enabled must be a boolean'
          });
        }

        await apiToggleService.setAutoPostingEnabled(enabled);
        logger.info(`Auto-posting ${enabled ? 'enabled' : 'disabled'} via admin toggle`);
        
        const state = apiToggleService.getState();
        res.json({
          success: true,
          autoPostingEnabled: state.autoPostingEnabled
        });
      } catch (error: any) {
        logger.error('Toggle auto-posting error:', error);
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    app.get('/api/admin/toggle-status', (req, res) => {
      const state = apiToggleService.getState();
      res.json({
        success: true,
        ...state
      });
    });

    // Price Tier API endpoints
    app.get('/api/price-tiers', async (req, res) => {
      try {
        // Get all tiers for all transaction types
        const allTiers = await databaseService.getPriceTiers();
        
        // Group by transaction type
        const tiersByType = {
          sales: allTiers.filter(t => t.transactionType === 'sales'),
          registrations: allTiers.filter(t => t.transactionType === 'registrations'),
          bids: allTiers.filter(t => t.transactionType === 'bids')
        };
        
        res.json({ success: true, tiers: tiersByType });
      } catch (error) {
        logger.error('Failed to get price tiers:', error);
        res.status(500).json({ success: false, error: 'Failed to get price tiers' });
      }
    });
    
    app.post('/api/price-tiers/update', async (req, res) => {
      try {
        const { type, tiers } = req.body;
        
        if (!type || !tiers || !Array.isArray(tiers)) {
          return res.status(400).json({ success: false, error: 'Invalid tier data' });
        }
        
        // Update each tier for the specified transaction type
        for (const tier of tiers) {
          await databaseService.updatePriceTier(type, tier.level, tier.min, tier.max);
        }
        
        res.json({ success: true, message: `${type} price tiers updated successfully` });
      } catch (error) {
        logger.error('Failed to update price tiers:', error);
        res.status(500).json({ success: false, error: 'Failed to update price tiers' });
      }
    });
    
    // Auto-post settings endpoints - transaction-specific
    app.get('/api/admin/autopost-settings', async (req, res) => {
      try {
        // Load transaction-specific settings from database
        const salesSettings = {
          enabled: (await databaseService.getSystemState('autopost_sales_enabled') || 'true') === 'true',
          minEthDefault: parseFloat(await databaseService.getSystemState('autopost_sales_min_eth_default') || '0.1'),
          minEth10kClub: parseFloat(await databaseService.getSystemState('autopost_sales_min_eth_10k') || '0.5'),
          minEth999Club: parseFloat(await databaseService.getSystemState('autopost_sales_min_eth_999') || '0.3'),
          maxAgeHours: parseInt(await databaseService.getSystemState('autopost_sales_max_age_hours') || '1')
        };

        const registrationsSettings = {
          enabled: (await databaseService.getSystemState('autopost_registrations_enabled') || 'true') === 'true',
          minEthDefault: parseFloat(await databaseService.getSystemState('autopost_registrations_min_eth_default') || '0.05'),
          minEth10kClub: parseFloat(await databaseService.getSystemState('autopost_registrations_min_eth_10k') || '0.2'),
          minEth999Club: parseFloat(await databaseService.getSystemState('autopost_registrations_min_eth_999') || '0.1'),
          maxAgeHours: parseInt(await databaseService.getSystemState('autopost_registrations_max_age_hours') || '2')
        };

        const bidsSettings = {
          enabled: (await databaseService.getSystemState('autopost_bids_enabled') || 'true') === 'true',
          minEthDefault: parseFloat(await databaseService.getSystemState('autopost_bids_min_eth_default') || '0.2'),
          minEth10kClub: parseFloat(await databaseService.getSystemState('autopost_bids_min_eth_10k') || '1.0'),
          minEth999Club: parseFloat(await databaseService.getSystemState('autopost_bids_min_eth_999') || '0.5'),
          maxAgeHours: parseInt(await databaseService.getSystemState('autopost_bids_max_age_hours') || '24')
        };
        
        res.json({
          success: true,
          settings: {
            sales: salesSettings,
            registrations: registrationsSettings,
            bids: bidsSettings
          }
        });
      } catch (error: any) {
        logger.error('Failed to load auto-post settings:', error.message);
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    app.post('/api/admin/autopost-settings', async (req, res) => {
      try {
        const { transactionType, settings } = req.body;
        
        // Validate transaction type
        if (!['sales', 'registrations', 'bids'].includes(transactionType)) {
          return res.status(400).json({
            success: false,
            error: 'transactionType must be one of: sales, registrations, bids'
          });
        }

        const { enabled, minEthDefault, minEth10kClub, minEth999Club, maxAgeHours } = settings;
        
        // Validate inputs
        if (typeof enabled !== 'boolean') {
          return res.status(400).json({
            success: false,
            error: 'enabled must be a boolean'
          });
        }

        if (typeof minEthDefault !== 'number' || minEthDefault < 0) {
          return res.status(400).json({
            success: false,
            error: 'minEthDefault must be a positive number'
          });
        }
        
        if (typeof minEth10kClub !== 'number' || minEth10kClub < 0) {
          return res.status(400).json({
            success: false,
            error: 'minEth10kClub must be a positive number'
          });
        }
        
        if (typeof minEth999Club !== 'number' || minEth999Club < 0) {
          return res.status(400).json({
            success: false,
            error: 'minEth999Club must be a positive number'
          });
        }
        
        if (typeof maxAgeHours !== 'number' || maxAgeHours < 1 || maxAgeHours > 168) {
          return res.status(400).json({
            success: false,
            error: 'maxAgeHours must be between 1 and 168 (1 week)'
          });
        }
        
        // Save transaction-specific settings to database
        const prefix = `autopost_${transactionType}`;
        await databaseService.setSystemState(`${prefix}_enabled`, enabled.toString());
        await databaseService.setSystemState(`${prefix}_min_eth_default`, minEthDefault.toString());
        await databaseService.setSystemState(`${prefix}_min_eth_10k`, minEth10kClub.toString());
        await databaseService.setSystemState(`${prefix}_min_eth_999`, minEth999Club.toString());
        await databaseService.setSystemState(`${prefix}_max_age_hours`, maxAgeHours.toString());
        
        logger.info(`Auto-post ${transactionType} settings updated:`, { enabled, minEthDefault, minEth10kClub, minEth999Club, maxAgeHours });
        
        res.json({
          success: true,
          message: `Auto-post ${transactionType} settings saved successfully`,
          transactionType,
          settings: { enabled, minEthDefault, minEth10kClub, minEth999Club, maxAgeHours }
        });
      } catch (error: any) {
        logger.error('Failed to save auto-post settings:', error.message);
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    // Twitter API endpoints
    app.get('/api/twitter/test', async (req, res) => {
      try {
        const configValidation = twitterService.validateConfig();
        if (!configValidation.valid) {
          return res.status(400).json({
            success: false,
            error: 'Twitter API configuration incomplete',
            missingFields: configValidation.missingFields
          });
        }

        const result = await twitterService.testConnection();
        res.json({
          success: result.success,
          data: result.user,
          error: result.error
        });
      } catch (error: any) {
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    app.post('/api/twitter/test-post', async (req, res) => {
      try {
        const configValidation = twitterService.validateConfig();
        if (!configValidation.valid) {
          return res.status(400).json({
            success: false,
            error: 'Twitter API configuration incomplete',
            missingFields: configValidation.missingFields
          });
        }

        const testMessage = `🤖 NFT Sales Bot Test Tweet - ${new Date().toISOString()}`;
        const result = await twitterService.postTweet(testMessage);
        
        res.json({
          success: result.success,
          tweetId: result.tweetId,
          error: result.error,
          message: testMessage
        });
      } catch (error: any) {
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    app.get('/api/twitter/config-status', (req, res) => {
      try {
        const configValidation = twitterService.validateConfig();
        res.json({
          success: true,
          data: {
            configured: configValidation.valid,
            missingFields: configValidation.missingFields,
            hasApiKey: !!config.twitter.apiKey,
            hasApiSecret: !!config.twitter.apiSecret,
            hasAccessToken: !!config.twitter.accessToken,
            hasAccessTokenSecret: !!config.twitter.accessTokenSecret
          }
        });
      } catch (error: any) {
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    app.get('/api/twitter/rate-limit-status', async (req, res) => {
      try {
        const rateLimitInfo = await rateLimitService.getDetailedRateLimitInfo();
        res.json({
          success: true,
          data: rateLimitInfo
        });
      } catch (error: any) {
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    app.post('/api/twitter/send-test-tweet', async (req, res) => {
      try {
        const configValidation = twitterService.validateConfig();
        if (!configValidation.valid) {
          return res.status(400).json({
            success: false,
            error: 'Twitter API configuration incomplete',
            missingFields: configValidation.missingFields
          });
        }

        // Check rate limit first
        await rateLimitService.validateTweetPost();

        // Get the latest sale
        const unpostedSales = await databaseService.getRecentSales(1);
        if (unpostedSales.length === 0) {
          return res.status(404).json({
            success: false,
            error: 'No unposted sales available to tweet'
          });
        }

        const sale = unpostedSales[0];

        // Format the tweet with name resolution
        const formattedTweet = await newTweetFormatter.generateTweet(sale);
        
        if (!formattedTweet.isValid) {
          return res.status(400).json({
            success: false,
            error: 'Unable to format tweet properly',
            details: formattedTweet
          });
        }

        // Post to Twitter
        const tweetResult = await twitterService.postTweet(formattedTweet.text);
        
        if (tweetResult.success && tweetResult.tweetId) {
          // Record successful post in rate limiter
          await rateLimitService.recordTweetPost(tweetResult.tweetId, formattedTweet.text, sale.id);
          
          // Mark sale as posted in database
          await databaseService.markAsPosted(sale.id!, tweetResult.tweetId);
          
          // Get updated rate limit status
          const rateLimitStatus = await rateLimitService.canPostTweet();
          
          res.json({
            success: true,
            data: {
              tweetId: tweetResult.tweetId,
              tweetContent: formattedTweet.text,
              characterCount: formattedTweet.characterCount,
              saleId: sale.id,
              rateLimitStatus
            }
          });
        } else {
          // Record failed post
          await rateLimitService.recordFailedTweetPost(
            formattedTweet.text, 
            tweetResult.error || 'Unknown error',
            sale.id
          );
          
          res.status(500).json({
            success: false,
            error: 'Failed to post tweet',
            twitterError: tweetResult.error,
            tweetContent: formattedTweet.text
          });
        }
      } catch (error: any) {
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    app.get('/api/twitter/preview-tweet/:saleId', async (req, res) => {
      try {
        const saleId = parseInt(req.params.saleId);
        if (isNaN(saleId)) {
          return res.status(400).json({
            success: false,
            error: 'Invalid sale ID'
          });
        }

        // Get the sale from database
        const unpostedSales = await databaseService.getRecentSales(500);
        const sale = unpostedSales.find(s => s.id === saleId);
        
        if (!sale) {
          return res.status(404).json({
            success: false,
            error: 'Sale not found'
          });
        }

        // Generate tweet previews with name resolution
        const previews = await newTweetFormatter.previewTweet(sale);
        
        res.json({
          success: true,
          data: {
            sale: {
              id: sale.id,
              transactionHash: sale.transactionHash,
              contractAddress: sale.contractAddress,
              tokenId: sale.tokenId,
              priceEth: sale.priceEth,
              priceUsd: sale.priceUsd,
              marketplace: sale.marketplace
            },
            previews
          }
        });
      } catch (error: any) {
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    app.post('/api/twitter/post-sale/:saleId', async (req, res) => {
      try {
        const configValidation = twitterService.validateConfig();
        if (!configValidation.valid) {
          return res.status(400).json({
            success: false,
            error: 'Twitter API configuration incomplete',
            missingFields: configValidation.missingFields
          });
        }

        const saleId = parseInt(req.params.saleId);
        if (isNaN(saleId)) {
          return res.status(400).json({
            success: false,
            error: 'Invalid sale ID'
          });
        }

        // Get the sale from database
        const unpostedSales = await databaseService.getRecentSales(500);
        const sale = unpostedSales.find(s => s.id === saleId);
        
        if (!sale) {
          return res.status(404).json({
            success: false,
            error: 'Sale not found'
          });
        }

        // Comment out for testing - allow reposting already posted sales
        // if (sale.posted) {
        //   return res.status(400).json({
        //     success: false,
        //     error: 'Sale has already been posted to Twitter'
        //   });
        // }

        // Check rate limit first
        await rateLimitService.validateTweetPost();

        // Format the tweet with name resolution
        const formattedTweet = await newTweetFormatter.generateTweet(sale);
        
        if (!formattedTweet.isValid) {
          return res.status(400).json({
            success: false,
            error: 'Unable to format tweet properly',
            details: formattedTweet
          });
        }

        // Post to Twitter
        const tweetResult = await twitterService.postTweet(formattedTweet.text);
        
        if (tweetResult.success && tweetResult.tweetId) {
          // Record successful post in rate limiter
          await rateLimitService.recordTweetPost(tweetResult.tweetId, formattedTweet.text, saleId);
          
          // Mark as posted in database
          await databaseService.markAsPosted(saleId, tweetResult.tweetId);
          
          // Get updated rate limit status
          const rateLimitStatus = await rateLimitService.canPostTweet();
          
          res.json({
            success: true,
            data: {
              tweetId: tweetResult.tweetId,
              tweetContent: formattedTweet.text,
              characterCount: formattedTweet.characterCount,
              saleId: saleId,
              rateLimitStatus
            }
          });
        } else {
          // Record failed post
          await rateLimitService.recordFailedTweetPost(
            formattedTweet.text, 
            tweetResult.error || 'Unknown error',
            saleId
          );
          
          res.status(500).json({
            success: false,
            error: 'Failed to post tweet',
            twitterError: tweetResult.error,
            tweetContent: formattedTweet.text
          });
        }
      } catch (error: any) {
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    // New Tweet Generation API endpoints
    app.get('/api/tweet/generate/:saleId', async (req, res) => {
      try {
        const saleId = parseInt(req.params.saleId);
        if (isNaN(saleId)) {
          return res.status(400).json({
            success: false,
            error: 'Invalid sale ID'
          });
        }

        // Get the sale from database
        const unpostedSales = await databaseService.getRecentSales(500);
        const sale = unpostedSales.find(s => s.id === saleId);
        
        if (!sale) {
          return res.status(404).json({
            success: false,
            error: 'Sale not found'
          });
        }

        // Generate new format tweet with preview
        const preview = await newTweetFormatter.previewTweet(sale);
        
        res.json({
          success: true,
          data: {
            sale: {
              id: sale.id,
              transactionHash: sale.transactionHash,
              nftName: sale.nftName,
              priceEth: sale.priceEth,
              priceUsd: sale.priceUsd,
              buyerAddress: sale.buyerAddress,
              sellerAddress: sale.sellerAddress
            },
            tweet: preview.tweet,
            validation: preview.validation,
            breakdown: preview.breakdown,
            imageUrl: preview.tweet.imageUrl,
            hasImage: !!preview.tweet.imageBuffer
          }
        });
      } catch (error: any) {
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    app.post('/api/tweet/send/:saleId', async (req, res) => {
      try {
        const configValidation = twitterService.validateConfig();
        if (!configValidation.valid) {
          return res.status(400).json({
            success: false,
            error: 'Twitter API configuration incomplete',
            missingFields: configValidation.missingFields
          });
        }

        const saleId = parseInt(req.params.saleId);
        if (isNaN(saleId)) {
          return res.status(400).json({
            success: false,
            error: 'Invalid sale ID'
          });
        }

        // Get the sale from database
        const unpostedSales = await databaseService.getRecentSales(500);
        const sale = unpostedSales.find(s => s.id === saleId);
        
        if (!sale) {
          return res.status(404).json({
            success: false,
            error: 'Sale not found'
          });
        }

        // Comment out for testing - allow reposting already posted sales
        // if (sale.posted) {
        //   return res.status(400).json({
        //     success: false,
        //     error: 'Sale has already been posted to Twitter'
        //   });
        // }

        // Check rate limit first
        await rateLimitService.validateTweetPost();

        // Generate new format tweet
        const generatedTweet = await newTweetFormatter.generateTweet(sale);
        
        if (!generatedTweet.isValid) {
          return res.status(400).json({
            success: false,
            error: 'Unable to generate valid tweet',
            details: generatedTweet
          });
        }

        // Post to Twitter with image
        const tweetResult = await twitterService.postTweet(generatedTweet.text, generatedTweet.imageBuffer);
        
        if (tweetResult.success && tweetResult.tweetId) {
          // Record successful post in rate limiter
          await rateLimitService.recordTweetPost(tweetResult.tweetId, generatedTweet.text, saleId);
          
          // Mark as posted in database
          await databaseService.markAsPosted(saleId, tweetResult.tweetId);
          
          // Get updated rate limit status
          const rateLimitStatus = await rateLimitService.canPostTweet();
          
          res.json({
            success: true,
            data: {
              tweetId: tweetResult.tweetId,
              tweetContent: generatedTweet.text,
              characterCount: generatedTweet.characterCount,
              saleId: saleId,
              rateLimitStatus,
              hasImage: !!generatedTweet.imageBuffer
            }
          });
        } else {
          // Record failed post
          await rateLimitService.recordFailedTweetPost(
            generatedTweet.text, 
            tweetResult.error || 'Unknown error',
            saleId
          );
          
          res.status(500).json({
            success: false,
            error: 'Failed to post tweet',
            twitterError: tweetResult.error,
            tweetContent: generatedTweet.text
          });
        }
      } catch (error: any) {
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    // Registration Tweet Generation API endpoints
    app.get('/api/registration/tweet/generate/:registrationId', async (req, res) => {
      try {
        const registrationId = parseInt(req.params.registrationId);
        if (isNaN(registrationId)) {
          return res.status(400).json({
            success: false,
            error: 'Invalid registration ID'
          });
        }

        // Get the registration from database
        const unpostedRegistrations = await databaseService.getRecentRegistrations(500);
        const registration = unpostedRegistrations.find(r => r.id === registrationId);
        
        if (!registration) {
          return res.status(404).json({
            success: false,
            error: 'Registration not found'
          });
        }

        // Generate registration tweet with preview
        const preview = await newTweetFormatter.previewRegistrationTweet(registration);
        
        res.json({
          success: true,
          data: {
            registration: {
              id: registration.id,
              transactionHash: registration.transactionHash,
              ensName: registration.ensName,
              fullName: registration.fullName,
              costEth: registration.costEth,
              costUsd: registration.costUsd,
              ownerAddress: registration.ownerAddress
            },
            tweet: preview.tweet,
            validation: preview.validation,
            breakdown: preview.breakdown,
            imageUrl: preview.tweet.imageUrl,
            hasImage: !!preview.tweet.imageBuffer
          }
        });
      } catch (error: any) {
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    app.post('/api/registration/tweet/send/:registrationId', async (req, res) => {
      try {
        const configValidation = twitterService.validateConfig();
        if (!configValidation.valid) {
          return res.status(400).json({
            success: false,
            error: 'Twitter API configuration incomplete',
            missingFields: configValidation.missingFields
          });
        }

        const registrationId = parseInt(req.params.registrationId);
        if (isNaN(registrationId)) {
          return res.status(400).json({
            success: false,
            error: 'Invalid registration ID'
          });
        }

        // Get the registration from database
        const unpostedRegistrations = await databaseService.getRecentRegistrations(500);
        const registration = unpostedRegistrations.find(r => r.id === registrationId);
        
        if (!registration) {
          return res.status(404).json({
            success: false,
            error: 'Registration not found'
          });
        }

        // Comment out for testing - allow reposting already posted registrations
        // if (registration.posted) {
        //   return res.status(400).json({
        //     success: false,
        //     error: 'Registration has already been posted to Twitter'
        //   });
        // }

        // Check rate limit first
        await rateLimitService.validateTweetPost();

        // Generate registration tweet
        const generatedTweet = await newTweetFormatter.generateRegistrationTweet(registration);
        
        if (!generatedTweet.isValid) {
          return res.status(400).json({
            success: false,
            error: 'Unable to generate valid registration tweet',
            details: generatedTweet
          });
        }

        // Post to Twitter with image
        const tweetResult = await twitterService.postTweet(generatedTweet.text, generatedTweet.imageBuffer);
        
        if (tweetResult.success && tweetResult.tweetId) {
          // Record successful post in rate limiter
          await rateLimitService.recordTweetPost(tweetResult.tweetId, generatedTweet.text);
          
          // Mark registration as posted in database
          await databaseService.markRegistrationAsPosted(registrationId, tweetResult.tweetId);
          
          // Get updated rate limit status
          const rateLimitStatus = await rateLimitService.canPostTweet();
          
          res.json({
            success: true,
            data: {
              tweetId: tweetResult.tweetId,
              tweetContent: generatedTweet.text,
              characterCount: generatedTweet.characterCount,
              registrationId: registrationId,
              rateLimitStatus,
              hasImage: !!generatedTweet.imageBuffer
            }
          });
        } else {
          // Record failed post
          await rateLimitService.recordFailedTweetPost(
            generatedTweet.text, 
            tweetResult.error || 'Unknown error'
          );
          
          res.status(500).json({
            success: false,
            error: 'Failed to post registration tweet',
            twitterError: tweetResult.error,
            tweetContent: generatedTweet.text
          });
        }
      } catch (error: any) {
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    // Bid Tweet Generation API endpoints
    app.get('/api/bid/tweet/generate/:bidId', async (req, res) => {
      try {
        const bidId = parseInt(req.params.bidId);
        if (isNaN(bidId)) {
          return res.status(400).json({
            success: false,
            error: 'Invalid bid ID'
          });
        }

        // Get the bid from database
        const unpostedBids = await databaseService.getRecentBids(500);
        const bid = unpostedBids.find(b => b.id === bidId);
        
        if (!bid) {
          return res.status(404).json({
            success: false,
            error: 'Bid not found or already posted'
          });
        }

        // Generate preview without posting
        const preview = await newTweetFormatter.previewBidTweet(bid);
        
        res.json({
          success: true,
          data: {
            tweet: preview.tweet,
            breakdown: preview.breakdown,
            imageUrl: preview.tweet.imageUrl,
            hasImage: !!preview.tweet.imageBuffer
          }
        });
      } catch (error: any) {
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    app.post('/api/bid/tweet/send/:bidId', async (req, res) => {
      try {
        const bidId = parseInt(req.params.bidId);
        if (isNaN(bidId)) {
          return res.status(400).json({
            success: false,
            error: 'Invalid bid ID'
          });
        }

        // Get the bid from database
        const unpostedBids = await databaseService.getRecentBids(500);
        const bid = unpostedBids.find(b => b.id === bidId);
        
        if (!bid) {
          return res.status(404).json({
            success: false,
            error: 'Bid not found or already posted'
          });
        }

        // Check rate limit first
        await rateLimitService.validateTweetPost();

        // Generate bid tweet
        const generatedTweet = await newTweetFormatter.generateBidTweet(bid);
        
        if (!generatedTweet.isValid) {
          return res.status(400).json({
            success: false,
            error: 'Unable to generate valid bid tweet',
            details: generatedTweet
          });
        }

        // Post to Twitter with image
        const tweetResult = await twitterService.postTweet(generatedTweet.text, generatedTweet.imageBuffer);
        
        if (tweetResult.success && tweetResult.tweetId) {
          // Record successful post in rate limiter
          await rateLimitService.recordTweetPost(tweetResult.tweetId, generatedTweet.text);
          
          // Mark bid as posted in database
          await databaseService.markBidAsPosted(bidId, tweetResult.tweetId);
          
          res.json({
            success: true,
            tweetId: tweetResult.tweetId,
            message: `Bid tweet posted successfully: ${tweetResult.tweetId}`
          });
        } else {
          res.status(500).json({
            success: false,
            error: tweetResult.error || 'Failed to post bid tweet'
          });
        }
      } catch (error: any) {
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    app.get('/api/unposted-bids', async (req, res) => {
      try {
        const limit = parseInt(req.query.limit as string) || 500; // Increased for testing
        const recentBids = await databaseService.getRecentBids(limit); // Changed to get ALL bids
        res.json({
          success: true,
          data: recentBids,
          count: recentBids.length
        });
      } catch (error: any) {
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    // Twitter History API endpoint
    app.get('/api/twitter/history', async (req, res) => {
      try {
        const hoursBack = parseInt(req.query.hours as string) || 24;
        const tweetHistory = await databaseService.getRecentTweetPosts(hoursBack);
        
        res.json({
          success: true,
          data: {
            tweets: tweetHistory,
            count: tweetHistory.length,
            hoursBack: hoursBack
          }
        });
      } catch (error: any) {
        logger.error('Failed to fetch tweet history:', error.message);
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    // Image Generation API endpoints
    app.post('/api/image/generate-test', async (req, res) => {
      const { ImageController } = await import('./controllers/imageController');
      await ImageController.generateTestImage(req, res);
    });

    app.post('/api/image/generate-custom-sale', async (req, res) => {
      const { ImageController } = await import('./controllers/imageController');
      await ImageController.generateCustomImage(req, res);
    });

    app.post('/api/image/generate-custom-registration', async (req, res) => {
      try {
        const { mockData } = req.body;
        
        if (!mockData) {
          res.status(400).json({
            success: false,
            error: 'Mock data is required'
          });
          return;
        }
        
        // Get database service from app.locals
        const { databaseService } = req.app.locals;
        
        logger.info('Generating custom registration image with provided data');
        
        // Convert ImageData to RealImageData format for registration
        const realImageData = {
          priceEth: mockData.priceEth,
          priceUsd: mockData.priceUsd,
          ensName: mockData.ensName,
          nftImageUrl: mockData.nftImageUrl || '',
          buyerEns: mockData.buyerEns || 'New Owner',
          buyerAvatar: mockData.buyerAvatar || '',
          sellerEns: 'ENS DAO',
          sellerAvatar: '',
          transactionHash: '0x0000',
          saleId: 0,
          tokenId: ''
        };
        
        const startTime = Date.now();
        const { PuppeteerImageService } = await import('./services/puppeteerImageService');
        const imageBuffer = await PuppeteerImageService.generateRegistrationImage(realImageData, databaseService);
        const endTime = Date.now();
        
        // Save image with timestamp
        const filename = `custom-registration-${Date.now()}.png`;
        const savedPath = await PuppeteerImageService.saveImageToFile(imageBuffer, filename, databaseService);
        
        // Create URL for the generated image
        const imageUrl = savedPath.startsWith('/api/images/') ? savedPath : `/generated-images/${filename}`;
        
        logger.info(`Custom registration image generated successfully: ${filename} (${endTime - startTime}ms)`);
        
        res.json({
          success: true,
          imageUrl,
          mockData,
          generationTime: endTime - startTime,
          dimensions: '1000x545px',
          filename
        });
        
      } catch (error) {
        logger.error('Failed to generate custom registration image:', error);
        res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error occurred'
        });
      }
    });

    app.post('/api/image/generate-custom-bid', async (req, res) => {
      try {
        const { mockData } = req.body;
        
        if (!mockData) {
          res.status(400).json({
            success: false,
            error: 'Mock data is required'
          });
          return;
        }
        
        // Get database service from app.locals
        const { databaseService } = req.app.locals;
        
        logger.info('Generating custom bid image with provided data');
        
        // Use ImageData format directly for bids
        const startTime = Date.now();
        const { PuppeteerImageService } = await import('./services/puppeteerImageService');
        const imageBuffer = await PuppeteerImageService.generateBidImage(mockData, databaseService);
        const endTime = Date.now();
        
        // Save image with timestamp
        const filename = `custom-bid-${Date.now()}.png`;
        const savedPath = await PuppeteerImageService.saveImageToFile(imageBuffer, filename, databaseService);
        
        // Create URL for the generated image
        const imageUrl = savedPath.startsWith('/api/images/') ? savedPath : `/generated-images/${filename}`;
        
        logger.info(`Custom bid image generated successfully: ${filename} (${endTime - startTime}ms)`);
        
        res.json({
          success: true,
          imageUrl,
          mockData,
          generationTime: endTime - startTime,
          dimensions: '1000x545px',
          filename
        });
        
      } catch (error) {
        logger.error('Failed to generate custom bid image:', error);
        res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error occurred'
        });
      }
    });

    // Serve generated images
    app.use('/generated-images', express.static(path.join(__dirname, '../data')));

    app.get('/api/database/sales', async (req, res) => {
      try {
        const page = parseInt(req.query.page as string) || 1;
        const limit = parseInt(req.query.limit as string) || 50;
        const offset = (page - 1) * limit;
        const search = req.query.search as string || '';
        const sortBy = req.query.sortBy as string || 'blockNumber';
        const sortOrder = req.query.sortOrder as string || 'desc';

        // Get total count first
        const stats = await databaseService.getStats();
        
        // Get all sales for proper pagination and filtering
        const allSales = await databaseService.getRecentSales(stats.totalSales);
        
        // Apply search filter if provided
        let filteredSales = allSales;
        if (search) {
          const searchLower = search.toLowerCase();
          filteredSales = allSales.filter(sale => 
            sale.transactionHash.toLowerCase().includes(searchLower) ||
            sale.contractAddress.toLowerCase().includes(searchLower) ||
            sale.marketplace.toLowerCase().includes(searchLower) ||
            sale.buyerAddress.toLowerCase().includes(searchLower) ||
            sale.sellerAddress.toLowerCase().includes(searchLower) ||
            sale.tokenId.includes(search) ||
            sale.priceEth.includes(search)
          );
        }

        // Apply sorting
        filteredSales.sort((a, b) => {
          let aVal: any = a[sortBy as keyof typeof a];
          let bVal: any = b[sortBy as keyof typeof b];
          
          // Handle numeric fields
          if (sortBy === 'blockNumber' || sortBy === 'id') {
            aVal = Number(aVal);
            bVal = Number(bVal);
          } else if (sortBy === 'priceEth') {
            aVal = parseFloat(aVal);
            bVal = parseFloat(bVal);
          }
          
          if (sortOrder === 'asc') {
            return aVal > bVal ? 1 : -1;
          } else {
            return aVal < bVal ? 1 : -1;
          }
        });

        // Apply pagination
        const paginatedSales = filteredSales.slice(offset, offset + limit);
        const totalFiltered = filteredSales.length;

        res.json({
          success: true,
          data: {
            sales: paginatedSales,
            pagination: {
              page,
              limit,
              total: totalFiltered,
              totalPages: Math.ceil(totalFiltered / limit),
              hasNext: page * limit < totalFiltered,
              hasPrev: page > 1
            },
            stats: {
              totalSales: stats.totalSales,
              postedSales: stats.postedSales,
              unpostedSales: stats.unpostedSales,
              filteredResults: totalFiltered,
              searchTerm: search
            }
          }
        });
      } catch (error: any) {
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    app.get('/api/database/registrations', async (req, res) => {
      try {
        const page = parseInt(req.query.page as string) || 1;
        const limit = parseInt(req.query.limit as string) || 25;
        const offset = (page - 1) * limit;
        const search = req.query.search as string || '';
        const sortBy = req.query.sortBy as string || 'blockNumber';
        const sortOrder = req.query.sortOrder as string || 'desc';

        // Get all registrations for proper pagination and filtering
        const allRegistrations = await databaseService.getRecentRegistrations(1000);
        
        // Apply search filter if provided
        let filteredRegistrations = allRegistrations;
        if (search) {
          const searchLower = search.toLowerCase();
          filteredRegistrations = allRegistrations.filter(registration => 
            registration.ensName.toLowerCase().includes(searchLower) ||
            registration.fullName.toLowerCase().includes(searchLower) ||
            registration.transactionHash.toLowerCase().includes(searchLower) ||
            registration.ownerAddress.toLowerCase().includes(searchLower) ||
            registration.tokenId.includes(search) ||
            registration.costEth?.includes(search)
          );
        }

        // Apply sorting
        filteredRegistrations.sort((a, b) => {
          let aVal: any = a[sortBy as keyof typeof a];
          let bVal: any = b[sortBy as keyof typeof b];
          
          // Handle numeric fields
          if (sortBy === 'blockNumber' || sortBy === 'id') {
            aVal = Number(aVal);
            bVal = Number(bVal);
          } else if (sortBy === 'costEth') {
            aVal = parseFloat(aVal || '0');
            bVal = parseFloat(bVal || '0');
          }
          
          if (sortOrder === 'asc') {
            return aVal > bVal ? 1 : -1;
          } else {
            return aVal < bVal ? 1 : -1;
          }
        });

        // Apply pagination
        const paginatedRegistrations = filteredRegistrations.slice(offset, offset + limit);
        const totalFiltered = filteredRegistrations.length;
        
        // Calculate stats
        const totalRegistrations = allRegistrations.length;
        const pendingTweets = allRegistrations.filter(r => !r.posted).length;
        const totalValue = allRegistrations.reduce((sum, r) => sum + parseFloat(r.costEth || '0'), 0);

        res.json({
          success: true,
          data: {
            registrations: paginatedRegistrations,
            pagination: {
              page,
              limit,
              total: totalFiltered,
              totalPages: Math.ceil(totalFiltered / limit),
              hasNext: page * limit < totalFiltered,
              hasPrev: page > 1
            },
            stats: {
              totalRegistrations: totalRegistrations,
              pendingTweets: pendingTweets,
              totalValue: totalValue.toFixed(4),
              filteredResults: totalFiltered,
              searchTerm: search
            }
          }
        });
      } catch (error: any) {
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    app.get('/api/admin/bids', async (req, res) => {
      try {
        const page = parseInt(req.query.page as string) || 1;
        const limit = parseInt(req.query.limit as string) || 10;
        const offset = (page - 1) * limit;
        const search = req.query.search as string || '';
        const sortBy = req.query.sortBy as string || 'createdAtApi';
        const sortOrder = req.query.sortOrder as string || 'desc';
        const marketplaceFilter = req.query.marketplace as string || '';
        const statusFilter = req.query.status as string || '';

        // Get all bids for proper filtering and pagination
        const allBids = await databaseService.getRecentBids(1000);
        
        // Apply search filter if provided
        let filteredBids = allBids;
        if (search) {
          const searchLower = search.toLowerCase();
          filteredBids = allBids.filter(bid => 
            (bid.ensName && bid.ensName.toLowerCase().includes(searchLower)) ||
            bid.bidId.toLowerCase().includes(searchLower) ||
            bid.makerAddress.toLowerCase().includes(searchLower) ||
            (bid.sourceName && bid.sourceName.toLowerCase().includes(searchLower)) ||
            (bid.sourceDomain && bid.sourceDomain.toLowerCase().includes(searchLower)) ||
            (bid.tokenId && bid.tokenId.includes(search))
          );
        }

        // Apply marketplace filter if provided
        if (marketplaceFilter) {
          filteredBids = filteredBids.filter(bid => 
            bid.sourceDomain && bid.sourceDomain.toLowerCase().includes(marketplaceFilter.toLowerCase())
          );
        }

        // Apply status filter if provided (check if bid is expired)
        if (statusFilter) {
          const now = Math.floor(Date.now() / 1000);
          filteredBids = filteredBids.filter(bid => {
            const isExpired = bid.validUntil < now;
            if (statusFilter === 'active') {
              return !isExpired;
            } else if (statusFilter === 'expired') {
              return isExpired;
            }
            return true; // 'all' case
          });
        }

        // Apply sorting
        filteredBids.sort((a, b) => {
          let aVal: any = a[sortBy as keyof typeof a];
          let bVal: any = b[sortBy as keyof typeof b];
          
          // Handle numeric fields
          if (sortBy === 'priceDecimal') {
            aVal = parseFloat(aVal || '0');
            bVal = parseFloat(bVal || '0');
          } else if (sortBy === 'validUntil' || sortBy === 'validFrom' || sortBy === 'id') {
            aVal = Number(aVal);
            bVal = Number(bVal);
          } else if (sortBy === 'createdAtApi' || sortBy === 'updatedAtApi') {
            aVal = new Date(aVal).getTime();
            bVal = new Date(bVal).getTime();
          }
          
          if (sortOrder === 'asc') {
            return aVal > bVal ? 1 : -1;
          } else {
            return aVal < bVal ? 1 : -1;
          }
        });

        // Apply pagination
        const paginatedBids = filteredBids.slice(offset, offset + limit);
        const totalFiltered = filteredBids.length;
        
        res.json({
          success: true,
          bids: paginatedBids,
          total: totalFiltered,
          totalPages: Math.ceil(totalFiltered / limit),
          currentPage: page,
          hasNext: page * limit < totalFiltered,
          hasPrev: page > 1,
          stats: {
            totalBids: allBids.length,
            filteredBids: totalFiltered,
            activeBids: allBids.filter(bid => bid.validUntil > Math.floor(Date.now() / 1000)).length,
            expiredBids: allBids.filter(bid => bid.validUntil <= Math.floor(Date.now() / 1000)).length,
            searchTerm: search,
            marketplaceFilter,
            statusFilter
          }
        });
      } catch (error: any) {
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    app.post('/api/database/reset', async (req, res) => {
      try {
        logger.warn('Database reset requested - this will delete ALL data!');
        
        await databaseService.resetDatabase();
        
        res.json({
          success: true,
          message: 'Database reset completed successfully. All sales and tweets deleted, lastProcessedBlock cleared.'
        });
      } catch (error: any) {
        logger.error('Database reset failed:', error.message);
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    app.post('/api/database/migrate-schema', async (req, res) => {
      try {
        logger.warn('Database schema migration requested - this will DROP and RECREATE tables!');
        
        await databaseService.migrateSchema();
        
        res.json({
          success: true,
          message: 'Database schema migration completed successfully. Tables recreated with new schema.'
        });
      } catch (error: any) {
        logger.error('Database schema migration failed:', error.message);
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    app.post('/api/database/clear-sales', async (req, res) => {
      try {
        logger.warn('Sales table clear requested - this will delete all sales data!');
        
        await databaseService.clearSalesTable();
        
        res.json({
          success: true,
          message: 'Sales table cleared successfully. All sales data deleted, ready for fresh data.'
        });
      } catch (error: any) {
        logger.error('Sales table clear failed:', error.message);
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    // Reset processing to start from recent blocks
    app.post('/api/processing/reset-to-recent', async (req, res) => {
      try {
        logger.warn('Resetting processing to start from recent blocks...');
        
        // Clear the last processed block so we start fresh from recent sales
        await databaseService.setSystemState('last_processed_block', '');
        
        // Trigger immediate processing of recent sales (without fromBlock constraint)
        const stats = await salesProcessingService.processNewSales();
        
        res.json({ 
          success: true, 
          message: 'Processing reset to recent blocks completed successfully. Now fetching recent sales.',
          stats: stats
        });
      } catch (error: any) {
        logger.error('Failed to reset processing to recent blocks:', error.message);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Serve generated images from database
    app.get('/api/images/:filename', async (req, res) => {
      try {
        const { filename } = req.params;
        const imageData = await databaseService.getGeneratedImage(filename);
        
        if (!imageData) {
          return res.status(404).json({
            success: false,
            error: 'Image not found'
          });
        }
        
        res.setHeader('Content-Type', imageData.contentType);
        res.setHeader('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour
        res.send(imageData.buffer);
      } catch (error: any) {
        logger.error('Error serving generated image:', error.message);
        res.status(500).json({
          success: false,
          error: 'Failed to retrieve image'
        });
      }
    });

    // Serve admin dashboard
    app.get('/', (req, res) => {
      res.sendFile(path.join(__dirname, '../public/index.html'));
    });

    // ENS Metadata interface
    interface ENSMetadata {
      name: string;
      description: string;
      image: string;
      image_url: string;
      attributes: any[];
    }

    // Fetch ENS metadata from official ENS metadata API
    async function fetchENSMetadata(contractAddress: string, tokenId: string): Promise<ENSMetadata | null> {
      try {
        const url = `https://metadata.ens.domains/mainnet/${contractAddress}/${tokenId}`;
        logger.debug(`Fetching ENS metadata from: ${url}`);
        
        const response = await axios.get<ENSMetadata>(url, {
          timeout: 5000, // 5 second timeout
        });
        
        logger.debug(`Successfully fetched ENS metadata: ${response.data.name}`);
        return response.data;
        
      } catch (error: any) {
        logger.warn(`Failed to fetch ENS metadata for ${contractAddress}/${tokenId}:`, error.message);
        return null;
      }
    }

    // Contract format detection
    interface ContractFormat {
      type: 'legacy' | 'enhanced' | 'referral';
      description: string;
    }

    const CONTRACT_FORMATS: Record<string, ContractFormat> = {
      '0x283af0b28c62c092c9727f1ee09c02ca627eb7f5': {
        type: 'legacy',
        description: 'ENS ETH Registrar Controller (Legacy)'
      },
      '0x253553366da8546fc250f225fe3d25d0c782303b': {
        type: 'enhanced',
        description: 'ENS ETH Registrar Controller (v2)'
      },
      '0x59e16fccd424cc24e280be16e11bcd56fb0ce547': {
        type: 'referral',
        description: 'ENS ETH Registrar Controller (v3)'
      }
    };

    function getContractFormat(contractAddress: string): ContractFormat {
      const format = CONTRACT_FORMATS[contractAddress.toLowerCase()];
      return format || { type: 'legacy', description: 'Unknown (defaulting to legacy)' };
    }

    // Multi-format data extraction interface
    interface ExtractedRegistrationData {
      ensName: string;
      cost: string;
      contractFormat: 'legacy' | 'enhanced' | 'referral';
      baseCost?: string;
      premium?: string;
    }

    // Helper functions for decoding ENS registration data
    function extractRegistrationData(data: string, contractAddress: string): ExtractedRegistrationData {
      const format = getContractFormat(contractAddress);
      logger.info(`Processing ${format.description} format for contract: ${contractAddress}`);
      
      switch (format.type) {
        case 'legacy':
          return extractLegacyFormatData(data);
        case 'enhanced':
          return extractEnhancedFormatData(data);
        case 'referral':
          return extractReferralFormatData(data);
        default:
          logger.warn(`Unknown contract format, defaulting to legacy for: ${contractAddress}`);
          return extractLegacyFormatData(data);
      }
    }

    function extractLegacyFormatData(data: string): ExtractedRegistrationData {
      try {
        const cleanData = data.slice(2); // Remove 0x prefix
        
        // Legacy format: [offset][cost][expires][stringLength][stringData]
        const costHex = cleanData.slice(64, 128); // Position 2
        const cost = BigInt('0x' + costHex).toString();
        
        // Extract ENS name with proper offset handling
        const nameOffset = parseInt(cleanData.slice(0, 64), 16) * 2;
        const nameLength = parseInt(cleanData.slice(nameOffset, nameOffset + 64), 16);
        const nameHex = cleanData.slice(nameOffset + 64, nameOffset + 64 + nameLength * 2);
        const nameBuffer = Buffer.from(nameHex, 'hex');
        const ensName = nameBuffer.toString('utf8').replace(/\0/g, ''); // Remove null bytes
        
        return {
          ensName,
          cost,
          contractFormat: 'legacy'
        };
      } catch (error) {
        logger.error('Error extracting legacy format data:', error);
        return {
          ensName: 'unknown',
          cost: '0',
          contractFormat: 'legacy'
        };
      }
    }

    function extractEnhancedFormatData(data: string): ExtractedRegistrationData {
      try {
        const cleanData = data.slice(2); // Remove 0x prefix
        
        // Enhanced format: [offset][baseCost][premium][expires][stringLength][stringData]
        const baseCostHex = cleanData.slice(64, 128);   // Position 2
        const premiumHex = cleanData.slice(128, 192);   // Position 3
        
        const baseCost = BigInt('0x' + baseCostHex);
        const premium = BigInt('0x' + premiumHex);
        const totalCost = baseCost + premium;
        
        // Extract ENS name with proper offset handling
        const nameOffset = parseInt(cleanData.slice(0, 64), 16) * 2;
        const nameLength = parseInt(cleanData.slice(nameOffset, nameOffset + 64), 16);
        const nameHex = cleanData.slice(nameOffset + 64, nameOffset + 64 + nameLength * 2);
        const nameBuffer = Buffer.from(nameHex, 'hex');
        const ensName = nameBuffer.toString('utf8').replace(/\0/g, ''); // Remove null bytes
        
        return {
          ensName,
          cost: totalCost.toString(),
          contractFormat: 'enhanced',
          baseCost: baseCost.toString(),
          premium: premium.toString()
        };
      } catch (error) {
        logger.error('Error extracting enhanced format data:', error);
        return {
          ensName: 'unknown',
          cost: '0',
          contractFormat: 'enhanced'
        };
      }
    }

    function extractReferralFormatData(data: string): ExtractedRegistrationData {
      try {
        const cleanData = data.slice(2); // Remove 0x prefix
        
        // Referral format: [offset][baseCost][premium][expires][referrer][stringLength][stringData]
        const baseCostHex = cleanData.slice(64, 128);   // Position 2
        const premiumHex = cleanData.slice(128, 192);   // Position 3
        // Note: expires at position 4, referrer at position 5
        
        const baseCost = BigInt('0x' + baseCostHex);
        const premium = BigInt('0x' + premiumHex);
        const totalCost = baseCost + premium;
        
        // Extract ENS name with proper offset handling
        const nameOffset = parseInt(cleanData.slice(0, 64), 16) * 2;
        const nameLength = parseInt(cleanData.slice(nameOffset, nameOffset + 64), 16);
        const nameHex = cleanData.slice(nameOffset + 64, nameOffset + 64 + nameLength * 2);
        const nameBuffer = Buffer.from(nameHex, 'hex');
        const ensName = nameBuffer.toString('utf8').replace(/\0/g, ''); // Remove null bytes
        
        return {
          ensName,
          cost: totalCost.toString(),
          contractFormat: 'referral',
          baseCost: baseCost.toString(),
          premium: premium.toString()
        };
      } catch (error) {
        logger.error('Error extracting referral format data:', error);
        return {
          ensName: 'unknown',
          cost: '0',
          contractFormat: 'referral'
        };
      }
    }

    // ENS Registration Webhook from Moralis Streams
    app.post('/webhook/ens-registrations', async (req, res) => {
      try {
        logger.info('🎉 ENS Registration webhook received');
        
        // Handle the webhook data - sometimes it comes as an array with JSON string
        let webhookData = req.body;
        
        // If it's an array with a string, parse the first element
        if (Array.isArray(webhookData) && typeof webhookData[0] === 'string') {
          webhookData = JSON.parse(webhookData[0]);
        }
        
        logger.info('Webhook data:', JSON.stringify(webhookData, null, 2));
        
        // Check if this is a test webhook (empty data)
        if (!webhookData.logs || webhookData.logs.length === 0) {
          if (!webhookData.block?.number || webhookData.block.number === '') {
            logger.info('✅ Test webhook received successfully - no actual events to process');
            return res.status(200).json({ 
              success: true, 
              message: 'Test webhook received',
              type: 'test'
            });
          }
          logger.warn('No logs found in webhook data');
          return res.status(200).json({ 
            success: true, 
            message: 'Webhook received but no logs to process',
            type: 'no_logs'
          });
        }
        
        // Process each log (should be NameRegistered events)
        for (const log of webhookData.logs) {
          try {
            // Extract event data from the decoded abi
            const eventData = {
              transactionHash: log.transactionHash,
              blockNumber: webhookData.block?.number || 'unknown',
              blockTimestamp: webhookData.block?.timestamp || Date.now(),
              contractAddress: log.address
            };
            
            // Check if we have decoded event data
            if (webhookData.logs[0] && webhookData.abi && webhookData.abi[0]) {
              logger.info('🔍 Processing NameRegistered event...');
              
              // The event name and cost should be in the decoded data
              // For now, let's log everything we receive to understand the structure
              logger.info('Event details:', {
                transactionHash: eventData.transactionHash,
                blockNumber: eventData.blockNumber,
                blockTimestamp: eventData.blockTimestamp,
                contractAddress: eventData.contractAddress,
                topic0: log.topic0,
                topic1: log.topic1,
                topic2: log.topic2,
                data: log.data
              });
              
              // Extract ENS data from webhook using multi-format detection
              const extractedData = extractRegistrationData(log.data, eventData.contractAddress);
              const tokenId = log.topic1; // This is the keccak256 hash of the ENS name
              const ownerAddress = log.topic2?.replace('0x000000000000000000000000', '0x'); // Remove leading zeros padding
              
              logger.info('📝 Extracted ENS registration data:', {
                ensName: extractedData.ensName,
                tokenId,
                ownerAddress,
                cost: `${extractedData.cost} wei`,
                contractFormat: extractedData.contractFormat,
                baseCost: extractedData.baseCost ? `${extractedData.baseCost} wei` : undefined,
                premium: extractedData.premium ? `${extractedData.premium} wei` : undefined,
                transactionHash: eventData.transactionHash
              });

              // Fetch ENS metadata (image, description, etc.)
              // Note: Use ENS Base Registrar contract address for metadata API, not the Controller contract
              const ensBaseRegistrarAddress = '0x57f1887a8bf19b14fc0df6fd9b2acc9af147ea85';
              const ensMetadata = await fetchENSMetadata(ensBaseRegistrarAddress, tokenId);
              if (ensMetadata) {
                logger.info('🖼️ ENS metadata fetched:', {
                  name: ensMetadata.name,
                  image: ensMetadata.image,
                  description: ensMetadata.description
                });
              } else {
                logger.warn('⚠️ Failed to fetch ENS metadata for', extractedData.ensName);
              }
              
              // Convert cost from wei to ETH
              const costInWei = BigInt(extractedData.cost);
              const costInEth = (Number(costInWei) / 1e18).toFixed(6);
              
              // Get current ETH price in USD for cost calculation
              let costUsd: string | undefined;
              try {
                const ethPriceUsd = await alchemyService.getETHPriceUSD();
                if (ethPriceUsd) {
                  const costInUsd = parseFloat(costInEth) * ethPriceUsd;
                  costUsd = costInUsd.toFixed(2);
                  logger.info(`💰 ETH price: $${ethPriceUsd}, Registration cost: ${costInEth} ETH ($${costUsd})`);
                }
              } catch (error: any) {
                logger.warn('Failed to fetch ETH price for USD conversion:', error.message);
              }
              
              // Check if this registration is already processed
              const isProcessed = await databaseService.isRegistrationProcessed(tokenId);
              if (isProcessed) {
                logger.info(`⚠️ ENS registration ${extractedData.ensName} already processed, skipping...`);
                return;
              }

              // Prepare registration data
              const registrationData: Omit<ENSRegistration, 'id'> = {
                transactionHash: eventData.transactionHash,
                contractAddress: eventData.contractAddress,
                tokenId,
                ensName: extractedData.ensName,
                fullName: ensMetadata?.name || `${extractedData.ensName}.eth`,
                ownerAddress,
                costWei: extractedData.cost,
                costEth: costInEth,
                costUsd: costUsd,
                blockNumber: parseInt(eventData.blockNumber),
                blockTimestamp: new Date(parseInt(eventData.blockTimestamp) * 1000).toISOString(),
                processedAt: new Date().toISOString(),
                image: ensMetadata?.image,
                description: ensMetadata?.description,
                posted: false,
                expiresAt: undefined, // TODO: Calculate expiration if needed
              };

              // Store registration in database
              const registrationId = await databaseService.insertRegistration(registrationData);
              logger.info(`💾 ENS registration stored in database with ID: ${registrationId}`);

              // TODO: Format and send tweet
              
              logger.info('✅ ENS registration event processed successfully');
            }
            
          } catch (eventError: any) {
            logger.error('Error processing event:', eventError.message);
          }
        }
        
        // Respond to Moralis that we received the webhook
        res.status(200).json({ 
          success: true,
          message: 'Webhook received and processed',
          eventsProcessed: webhookData.logs.length,
          timestamp: new Date().toISOString()
        });
        
      } catch (error: any) {
        logger.error('Error processing ENS registration webhook:', error.message);
        res.status(500).json({ 
          error: 'Webhook processing failed',
          message: error.message
        });
      }
    });

    // API info endpoint
    app.get('/api', (req, res) => {
      res.json({
        message: 'NFT Sales Twitter Bot - API',
        version: '1.0.0',
        status: 'ready',
        endpoints: {
          health: '/health',
          testAlchemy: '/api/test-alchemy',
          fetchSales: '/api/fetch-sales?limit=10&contractAddress=optional',
          processSales: '/api/process-sales',
          stats: '/api/stats',
          unpostedSales: '/api/unposted-sales?limit=10'
        }
      });
    });

    // Start server
    const server = app.listen(config.port, () => {
      logger.info(`Server running on port ${config.port}`);
      logger.info(`Environment: ${config.nodeEnv}`);
      logger.info(`Monitoring contracts: ${config.contracts.join(', ')}`);
    });

    // Graceful shutdown handling
    const shutdown = async (): Promise<void> => {
      logger.info('Shutting down gracefully...');
      
      // Gracefully stop scheduler without persisting state (allows resume after restart)
      await schedulerService.gracefulShutdown();
      
      // Stop world time service
      worldTimeService.stop();
      
      server.close(() => {
        logger.info('HTTP server closed');
      });

      await databaseService.close();
      process.exit(0);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

  } catch (error) {
    logger.error('Failed to start application:', error);
    process.exit(1);
  }
}

// Start the application
startApplication();
