import express from 'express';
import path from 'path';
import { config, validateConfig } from './utils/config';
import { logger } from './utils/logger';
import { AlchemyService } from './services/alchemyService';
import { DatabaseService } from './services/databaseService';
import { VercelDatabaseService } from './services/vercelDatabaseService';
import { IDatabaseService } from './types';
import { SalesProcessingService } from './services/salesProcessingService';
import { SchedulerService } from './services/schedulerService';
import { TwitterService } from './services/twitterService';

async function startApplication(): Promise<void> {
  try {
    // Validate configuration
    validateConfig();
    logger.info('Configuration validated successfully');

    // Initialize services
    const alchemyService = new AlchemyService();
    
    // Use Vercel-compatible database in production, SQLite locally
    const databaseService: IDatabaseService = config.nodeEnv === 'production' 
      ? new VercelDatabaseService()
      : new DatabaseService();
    
    const salesProcessingService = new SalesProcessingService(alchemyService, databaseService);
    const schedulerService = new SchedulerService(salesProcessingService);
    const twitterService = new TwitterService();

    // Initialize database
    await databaseService.initialize();
    logger.info('Database initialized successfully');

    // Start scheduler
    schedulerService.start();
    logger.info('Automated scheduler started');

    // Initialize Express app
    const app = express();

    // Middleware
    app.use(express.json());
    app.use(express.static(path.join(__dirname, '../public')));

    // Basic health check endpoint
    app.get('/health', (req, res) => {
      res.json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        environment: config.nodeEnv,
        contracts: config.contracts.length
      });
    });

    // Test API endpoint
    app.get('/api/test-alchemy', async (req, res) => {
      try {
        const isConnected = await alchemyService.testConnection();
        res.json({
          success: isConnected,
          message: isConnected ? 'Alchemy API connection successful' : 'Alchemy API connection failed'
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
          const response = await alchemyService.getNFTSales(
            contractAddress as string,
            undefined,
            'latest',
            parseInt(limit as string) || 10
          );
          res.json({ success: true, data: response });
        } else {
          // Fetch for all contracts
          const sales = await alchemyService.getAllRecentSales(
            undefined,
            parseInt(limit as string) || 10
          );
          res.json({ success: true, data: { nftSales: sales, count: sales.length } });
        }
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
        const result = await salesProcessingService.manualSync();
        res.json(result);
      } catch (error: any) {
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

    // Serve admin dashboard
    app.get('/', (req, res) => {
      res.sendFile(path.join(__dirname, '../public/index.html'));
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
