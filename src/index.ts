import express from 'express';
import path from 'path';
import CryptoJS from 'crypto-js';
import axios from 'axios';
import { config, validateConfig } from './utils/config';
import { logger } from './utils/logger';
import { MONITORED_CONTRACTS } from './config/contracts';
import { MoralisService } from './services/moralisService';
import { DatabaseService } from './services/databaseService';
import { VercelDatabaseService } from './services/vercelDatabaseService';
import { IDatabaseService, ENSRegistration } from './types';
import { SalesProcessingService } from './services/salesProcessingService';
import { SchedulerService } from './services/schedulerService';
import { TwitterService } from './services/twitterService';
import { TweetFormatter } from './services/tweetFormatter';
import { NewTweetFormatter } from './services/newTweetFormatter';
import { RateLimitService } from './services/rateLimitService';
import { EthIdentityService } from './services/ethIdentityService';
import { APIToggleService } from './services/apiToggleService';
import { AutoTweetService } from './services/autoTweetService';
import { WorldTimeService } from './services/worldTimeService';

async function startApplication(): Promise<void> {
  try {
    // Validate configuration
    validateConfig();
    logger.info('Configuration validated successfully');

    // Initialize services
    const moralisService = new MoralisService();
    
    // Use PostgreSQL if DATABASE_URL is provided, otherwise SQLite
    const databaseService: IDatabaseService = process.env.DATABASE_URL?.startsWith('postgresql://') 
      ? new VercelDatabaseService()  // Works for any PostgreSQL, not just Vercel
      : new DatabaseService();       // SQLite for local development
    
    const salesProcessingService = new SalesProcessingService(moralisService, databaseService);
    const twitterService = new TwitterService();
    const tweetFormatter = new TweetFormatter();
    const newTweetFormatter = new NewTweetFormatter(databaseService);
    const rateLimitService = new RateLimitService(databaseService);
    const ethIdentityService = new EthIdentityService();
    const worldTimeService = new WorldTimeService();
    const autoTweetService = new AutoTweetService(newTweetFormatter, twitterService, rateLimitService, databaseService, worldTimeService);
    const schedulerService = new SchedulerService(salesProcessingService, autoTweetService, databaseService);

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
        const limit = parseInt(req.query.limit as string) || 10;
        const unpostedSales = await salesProcessingService.getSalesForPosting(limit);
        res.json({
          success: true,
          data: unpostedSales,
          count: unpostedSales.length
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

    app.post('/api/scheduler/start', (req, res) => {
      try {
        schedulerService.start();
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

    app.post('/api/scheduler/stop', (req, res) => {
      try {
        schedulerService.stop();
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

    app.post('/api/scheduler/force-stop', (req, res) => {
      try {
        schedulerService.forceStop();
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

    // Auto-post settings endpoints
    app.get('/api/admin/autopost-settings', async (req, res) => {
      try {
        // Load settings from database
        const minEthDefault = await databaseService.getSystemState('autopost_min_eth_default') || '0.1';
        const minEth10kClub = await databaseService.getSystemState('autopost_min_eth_10k') || '0.5';
        const minEth999Club = await databaseService.getSystemState('autopost_min_eth_999') || '0.3';
        const maxAgeHours = await databaseService.getSystemState('autopost_max_age_hours') || '1';
        
        res.json({
          success: true,
          settings: {
            minEthDefault: parseFloat(minEthDefault),
            minEth10kClub: parseFloat(minEth10kClub),
            minEth999Club: parseFloat(minEth999Club),
            maxAgeHours: parseInt(maxAgeHours)
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
        const { minEthDefault, minEth10kClub, minEth999Club, maxAgeHours } = req.body;
        
        // Validate inputs
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
        
        if (typeof maxAgeHours !== 'number' || maxAgeHours < 1 || maxAgeHours > 24) {
          return res.status(400).json({
            success: false,
            error: 'maxAgeHours must be between 1 and 24'
          });
        }
        
        // Save to database
        await databaseService.setSystemState('autopost_min_eth_default', minEthDefault.toString());
        await databaseService.setSystemState('autopost_min_eth_10k', minEth10kClub.toString());
        await databaseService.setSystemState('autopost_min_eth_999', minEth999Club.toString());
        await databaseService.setSystemState('autopost_max_age_hours', maxAgeHours.toString());
        
        logger.info('Auto-post settings updated:', { minEthDefault, minEth10kClub, minEth999Club, maxAgeHours });
        
        res.json({
          success: true,
          message: 'Auto-post settings saved successfully',
          settings: { minEthDefault, minEth10kClub, minEth999Club, maxAgeHours }
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

        // Get the latest unposted sale
        const unpostedSales = await databaseService.getUnpostedSales(1);
        if (unpostedSales.length === 0) {
          return res.status(404).json({
            success: false,
            error: 'No unposted sales available to tweet'
          });
        }

        const sale = unpostedSales[0];

        // Format the tweet with name resolution
        const formattedTweet = await tweetFormatter.formatSaleWithNames(sale);
        
        if (!formattedTweet.isValid) {
          return res.status(400).json({
            success: false,
            error: 'Unable to format tweet properly',
            details: formattedTweet
          });
        }

        // Post to Twitter
        const tweetResult = await twitterService.postTweet(formattedTweet.content);
        
        if (tweetResult.success && tweetResult.tweetId) {
          // Record successful post in rate limiter
          await rateLimitService.recordTweetPost(tweetResult.tweetId, formattedTweet.content, sale.id);
          
          // Mark sale as posted in database
          await databaseService.markAsPosted(sale.id!, tweetResult.tweetId);
          
          // Get updated rate limit status
          const rateLimitStatus = await rateLimitService.canPostTweet();
          
          res.json({
            success: true,
            data: {
              tweetId: tweetResult.tweetId,
              tweetContent: formattedTweet.content,
              characterCount: formattedTweet.characterCount,
              saleId: sale.id,
              rateLimitStatus
            }
          });
        } else {
          // Record failed post
          await rateLimitService.recordFailedTweetPost(
            formattedTweet.content, 
            tweetResult.error || 'Unknown error',
            sale.id
          );
          
          res.status(500).json({
            success: false,
            error: 'Failed to post tweet',
            twitterError: tweetResult.error,
            tweetContent: formattedTweet.content
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
        const unpostedSales = await databaseService.getUnpostedSales(100);
        const sale = unpostedSales.find(s => s.id === saleId);
        
        if (!sale) {
          return res.status(404).json({
            success: false,
            error: 'Sale not found'
          });
        }

        // Generate tweet previews with name resolution
        const previews = await tweetFormatter.previewFormatsWithNames(sale);
        
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
        const unpostedSales = await databaseService.getUnpostedSales(100);
        const sale = unpostedSales.find(s => s.id === saleId);
        
        if (!sale) {
          return res.status(404).json({
            success: false,
            error: 'Sale not found'
          });
        }

        if (sale.posted) {
          return res.status(400).json({
            success: false,
            error: 'Sale has already been posted to Twitter'
          });
        }

        // Check rate limit first
        await rateLimitService.validateTweetPost();

        // Format the tweet with name resolution
        const formattedTweet = await tweetFormatter.formatSaleWithNames(sale);
        
        if (!formattedTweet.isValid) {
          return res.status(400).json({
            success: false,
            error: 'Unable to format tweet properly',
            details: formattedTweet
          });
        }

        // Post to Twitter
        const tweetResult = await twitterService.postTweet(formattedTweet.content);
        
        if (tweetResult.success && tweetResult.tweetId) {
          // Record successful post in rate limiter
          await rateLimitService.recordTweetPost(tweetResult.tweetId, formattedTweet.content, saleId);
          
          // Mark as posted in database
          await databaseService.markAsPosted(saleId, tweetResult.tweetId);
          
          // Get updated rate limit status
          const rateLimitStatus = await rateLimitService.canPostTweet();
          
          res.json({
            success: true,
            data: {
              tweetId: tweetResult.tweetId,
              tweetContent: formattedTweet.content,
              characterCount: formattedTweet.characterCount,
              saleId: saleId,
              rateLimitStatus
            }
          });
        } else {
          // Record failed post
          await rateLimitService.recordFailedTweetPost(
            formattedTweet.content, 
            tweetResult.error || 'Unknown error',
            saleId
          );
          
          res.status(500).json({
            success: false,
            error: 'Failed to post tweet',
            twitterError: tweetResult.error,
            tweetContent: formattedTweet.content
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
        const unpostedSales = await databaseService.getUnpostedSales(100);
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
        const unpostedSales = await databaseService.getUnpostedSales(100);
        const sale = unpostedSales.find(s => s.id === saleId);
        
        if (!sale) {
          return res.status(404).json({
            success: false,
            error: 'Sale not found'
          });
        }

        if (sale.posted) {
          return res.status(400).json({
            success: false,
            error: 'Sale has already been posted to Twitter'
          });
        }

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

    app.post('/api/image/generate-custom', async (req, res) => {
      const { ImageController } = await import('./controllers/imageController');
      await ImageController.generateCustomImage(req, res);
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

    // Helper functions for decoding ENS registration data
    function extractEnsNameFromData(data: string): string {
      try {
        // Remove 0x prefix
        const cleanData = data.slice(2);
        
        // The name is at offset 0x60 (96 bytes from start)
        // First get the length of the string (next 32 bytes after offset)
        const lengthHex = cleanData.slice(192, 256); // 96*2 to get to offset, then next 32 bytes
        const length = parseInt(lengthHex, 16);
        
        // Then get the actual string data
        const nameHex = cleanData.slice(256, 256 + (length * 2));
        const nameBuffer = Buffer.from(nameHex, 'hex');
        return nameBuffer.toString('utf8');
      } catch (error) {
        logger.error('Error extracting ENS name from data:', error);
        return 'unknown';
      }
    }

    function extractCostFromData(data: string): string {
      try {
        // Remove 0x prefix
        const cleanData = data.slice(2);
        
        // Cost is in the second 32-byte slot (bytes 32-64)
        const costHex = cleanData.slice(64, 128);
        const costBigInt = BigInt('0x' + costHex);
        return costBigInt.toString();
      } catch (error) {
        logger.error('Error extracting cost from data:', error);
        return '0';
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
              
              // Extract ENS data from webhook
              const ensName = extractEnsNameFromData(log.data);
              const tokenId = log.topic1; // This is the keccak256 hash of the ENS name
              const ownerAddress = log.topic2?.replace('0x000000000000000000000000', '0x'); // Remove leading zeros padding
              const cost = extractCostFromData(log.data);
              
              logger.info('📝 Extracted ENS registration data:', {
                ensName,
                tokenId,
                ownerAddress,
                cost: cost ? `${cost} wei` : 'unknown',
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
                logger.warn('⚠️ Failed to fetch ENS metadata for', ensName);
              }
              
              // Convert cost from wei to ETH
              const costInWei = BigInt(cost);
              const costInEth = (Number(costInWei) / 1e18).toFixed(6);
              
              // Get current ETH price in USD for cost calculation
              let costUsd: string | undefined;
              try {
                const ethPriceUsd = await moralisService.getETHPriceUSD();
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
                logger.info(`⚠️ ENS registration ${ensName} already processed, skipping...`);
                return;
              }

              // Prepare registration data
              const registrationData: Omit<ENSRegistration, 'id'> = {
                transactionHash: eventData.transactionHash,
                contractAddress: eventData.contractAddress,
                tokenId,
                ensName,
                fullName: ensMetadata?.name || `${ensName}.eth`,
                ownerAddress,
                costWei: cost,
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
      
      // Stop scheduler first
      schedulerService.stop();
      
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
