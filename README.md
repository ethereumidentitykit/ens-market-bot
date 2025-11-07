# ENS Market Bot

An automated Twitter bot that monitors and tweets about Ethereum Name Service (ENS) domain sales, registrations, and bids with AI-generated market analysis.

## Features

- **Real-time ENS Monitoring**: Tracks sales, registrations, and bids for ENS domains
- **AI-Powered Insights**: Generates contextual market analysis using OpenAI GPT-5
- **Twitter Integration**: Automatically posts formatted tweets with generated images
- **Web Dashboard**: SIWE-authenticated admin interface for bot management
- **Multi-Source Data**: Aggregates data from Magic Eden, OpenSea, Alchemy, and QuickNode
- **Portfolio Analysis**: Enriches transactions with buyer/seller portfolio data and trading patterns
- **Club Detection**: Identifies membership in ENS clubs (999 Club, 10k Club, etc.)
- **Bidding Intelligence**: Tracks bidding patterns and conviction signals

## Architecture

### Core Services

- **MagicEdenV4Service**: Primary data source for NFT activity (V4 API)
- **OpenAIService**: Generates AI-powered market commentary
- **TwitterService**: Handles tweet posting and formatting
- **AlchemyService**: Provides portfolio and token balance data
- **OpenSeaService**: Fetches ENS holdings and metadata
- **ENSSubgraphService**: ENS subgraph powered by ENSNode for fast name resolution
- **DatabaseService**: PostgreSQL integration for state management
- **QuickNodeSales/RegistrationService**: Webhook handlers for real-time events
- **BidsProcessingService**: Monitors and processes new bids
- **AIReplyService**: Generates contextual replies for transactions

### Data Flow

1. **Webhook Reception**: QuickNode sends real-time ENS transaction events
2. **Event Processing**: Services enrich data with portfolio, history, and metadata
3. **AI Analysis**: OpenAI generates market insights from enriched context
4. **Tweet Generation**: Formatted tweets with images are created
5. **Publishing**: Automated posting to Twitter with rate limiting

## Prerequisites

- Node.js 18+
- PostgreSQL database
- Twitter API credentials (Premium+ for 1200 char replies)
- OpenAI API key (GPT-5-mini)
- QuickNode account with streaminging API
- Alchemy API key
- Ethereum RPC provider

## Installation

```bash
# Clone repository
git clone <repository-url>
cd ens-market-bot

# Install dependencies
npm install

# Copy environment template
cp env.production.example .env

# Configure environment variables (see Configuration section)
nano .env

# Build TypeScript
npm run build

# Start application
npm start
```

## Configuration

Create a `.env` file with the following variables:

```bash
# Database (Required)
POSTGRES_URL=postgresql://user:password@host:5432/database

# Twitter API (Required)
TWITTER_API_KEY=your_twitter_api_key
TWITTER_API_SECRET=your_twitter_api_secret
TWITTER_ACCESS_TOKEN=your_twitter_access_token
TWITTER_ACCESS_TOKEN_SECRET=your_twitter_access_token_secret
TWITTER_CALLBACK_URL=https://your-domain.com/auth/twitter/callback

# OpenAI (Required)
OPENAI_API_KEY=your_openai_api_key

# Magic Eden (Required)
MAGIC_EDEN_API_KEY=your_magic_eden_api_key

# QuickNode Webhooks (Required)
QUICKNODE_SECRET_SALES=your_quicknode_sales_secret
QUICKNODE_SECRET_REGISTRATIONS=your_quicknode_registration_secret

# Alchemy (Required - for portfolio data and price lookups)
ALCHEMY_API_KEY=your_alchemy_api_key

# SIWE Authentication (Required for dashboard)
ADMIN_WHITELIST=0xYourAddress1,0xYourAddress2
SESSION_SECRET=your_secure_random_session_secret
SIWE_DOMAIN=your-domain.com

# In-house ENS Subgraph (Optional - falls back to public endpoint)
ENS_SUBGRAPH_PRIMARY_URL=https://your-subgraph-endpoint.com/subgraph

# Timezone (Recommended)
TZ=UTC
```

## Database Setup

The bot requires PostgreSQL with the following tables (auto-created on first run):

- `sales`: ENS sales transactions
- `registrations`: ENS registrations
- `bids`: ENS bid events
- `rate_limits`: Twitter API rate limiting state
- `scheduler_state`: Cron job state management
- `api_toggle`: Feature flag control
- `sessions`: Web dashboard sessions

## Usage

### Starting the Bot

```bash
# Production
npm run build && npm start

# Development with auto-reload
npm run dev
```

### Web Dashboard

Access the admin dashboard at `http://localhost:3000` (or your deployed URL):

1. Connect wallet (MetaMask)
2. Sign SIWE message
3. Manage bot settings:
   - Enable/disable automated tweeting
   - Configure scheduler
   - Monitor recent transactions
   - View API health status

### API Endpoints

- `POST /quicknode-sales`: QuickNode sales webhook
- `POST /quicknode-registrations`: QuickNode registrations webhook
- `GET /health`: System health check
- `GET /api/sales`: Recent sales (authenticated)
- `GET /api/bids`: Recent bids (authenticated)
- `GET /api/activity/:address`: User activity lookup

## Development

```bash
# Lint code
npm run lint

# Format code
npm run format

# Build TypeScript
npm run build

# Run in development mode
npm run dev
```

## Key Features in Detail

### AI-Generated Market Analysis

The bot uses a sophisticated AI pipeline to generate insights:

1. **Name Research**: Web search for context about the ENS name
2. **Data Enrichment**: Fetch buyer/seller portfolio, trading history, holdings
3. **Pattern Detection**: Identify collecting patterns, bidding behavior, market signals
4. **Context Building**: Assemble ~200k token LLM context with all relevant data
5. **Generation**: OpenAI GPT-5-mini generates 800-1000 character analysis

### Bid Activity Tracking

- Monitors bids across ENS Registry and Name Wrapper contracts
- Detects bidding patterns (spray and pray, targeted collecting, etc.)
- Analyzes wallet commitment and conviction signals
- Limits bid history to last 500 per user to prevent token overflow

### Portfolio Intelligence

- Fetches multi-chain portfolio data via Alchemy
- Tracks total portfolio value, major holdings, and cross-chain presence
- Handles portfolio timing correctly (pre-bid vs post-purchase)
- Uses portfolio context for wash trading detection and conviction signals


## Rate Limiting

The bot implements intelligent rate limiting:

- Twitter API: Respects Twitter's rate limits with exponential backoff
- External APIs: Rate-limited to prevent quota exhaustion
- Webhook processing: Queue-based with throttling

## Monitoring

The bot includes comprehensive logging:

- Transaction processing events
- API call success/failure
- Tweet posting status
- AI generation metrics
- Portfolio fetch timing
- Error tracking with context

## Security

- **SIWE Authentication**: Sign-In with Ethereum for dashboard access
- **Webhook Verification**: HMAC signature validation for QuickNode webhooks
- **Admin Whitelist**: Address-based access control
- **Rate Limiting**: Request throttling on all endpoints
- **Environment Secrets**: All credentials stored in environment variables
- **Helmet.js**: HTTP security headers
- **CORS Protection**: Configurable origin restrictions

## Contributing

Contributions are welcome! Please ensure:

- Code follows existing style (ESLint + Prettier)
- TypeScript types are properly defined
- Environment variables are documented
- Error handling is comprehensive

## License

MIT License - see [LICENSE](LICENSE) file for details

## Support

For issues, questions, or feature requests, please open a GitHub issue.

## Acknowledgments

- Built with TypeScript, Express, and OpenAI
- Uses Magic Eden, OpenSea, Alchemy, and QuickNode APIs
- ENS infrastructure by ENS Labs
- Web3 libraries by viem and ethers

