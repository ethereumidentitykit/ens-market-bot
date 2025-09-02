# QuickNode Sales Migration Plan

## Current State ✅ UNIFIED ARCHITECTURE → 🚀 MOVING TO EVENT-DRIVEN
- **Sales**: Moralis + QuickNode → Database → Scheduler queries unposted → tweets (UNIFIED)
- **Registrations**: Webhook stores to DB → scheduler queries unposted → tweets
- **Bids**: Magic Eden API polling → stores to DB → scheduler queries unposted → tweets

**All three systems now use the same database-first architecture!**

## Next Evolution: Event-Driven Real-Time Processing
**Target Architecture:**
- **Sales**: Moralis/QuickNode → Database → PostgreSQL NOTIFY → Instant Processing ⚡
- **Registrations**: Webhook stores to DB → scheduler queries unposted → tweets (unchanged)
- **Bids**: Magic Eden API polling → stores to DB → scheduler queries unposted → tweets (unchanged)

## Goal
Migrate sales to real-time QuickNode webhooks while keeping existing scheduler and code structure.

## Migration Phases

### Phase 1: QuickNode Webhook Implementation

#### 1.1 Data Processing Pipeline
- **Webhook Endpoint**: Enhance existing `/webhook/salesv2` to handle Seaport events
- **Event Parsing**: Extract sale data from QuickNode orderFulfilled events
  - Parse `offer` array for ENS token details (contract + tokenId)
  - Parse `consideration` array for payment amounts (sum all ETH payments)
  - Extract buyer (`recipient`) and seller (`offerer`) addresses
  - Get transaction hash and block number

#### 1.2 Data Enrichment Steps
- **USD Pricing**: Integrate USD price API for ETH → USD conversion
- **ENS Metadata**: Call OpenSea API for NFT name, image, and description
- **Marketplace Detection**: Map Seaport contract to "seaport" marketplace
- **Price Calculation**: Sum all consideration amounts for total sale price
- **Wei Conversion**: Convert wei amounts to ETH decimal format

#### 1.3 Filtering & Validation
- **Price Filtering**: Apply same 0.05 ETH minimum as current system
- **Contract Filtering**: Only process ENS NameWrapper and OG Registry contracts
- **Duplicate Detection**: Check `isSaleProcessed(tokenId)` before storing
- **Data Validation**: Ensure required fields (tokenId, addresses, price) are present

#### 1.4 Database Storage
- **Schema Compatibility**: Store in existing `processed_sales` table
- **Field Mapping**: Map QuickNode data to existing ProcessedSale interface
- **Status Setting**: Store with `posted: false` for scheduler pickup
- **Error Handling**: Log and skip malformed events

### Phase 2: Scheduler Integration ✅ COMPLETED

#### 2.1 Unified Database-First Processing ✅
- **Step 1**: Moralis stores sales in database (no immediate posting)
- **Step 2**: Scheduler queries `getUnpostedSales()` for all sources (Moralis + QuickNode)
- **Step 3**: AutoTweetService processes unified sales with club filtering
- **Step 4**: Database `posted` field updated after successful Twitter posts
- **Race Protection**: Existing `isProcessingSales` lock prevents concurrent runs
- **Duplicate Prevention**: Fixed critical race condition with proper database updates

#### 2.2 Enhanced Logging
- **Duplicate Detection**: Log when Moralis finds QuickNode-processed sales
- **Performance Metrics**: Track QuickNode vs Moralis timing differences
- **Data Quality**: Log any enrichment failures or missing data
- **Processing Stats**: Monitor both ingestion sources separately

### Phase 3: Validation & Monitoring

#### 3.1 Data Quality Validation
- **Price Accuracy**: Compare QuickNode vs Moralis price calculations
- **Metadata Completeness**: Verify OpenSea API provides adequate NFT data
- **USD Conversion**: Validate USD pricing accuracy against Moralis
- **Missing Sales**: Monitor for any sales missed by QuickNode filtering

#### 3.2 Performance Monitoring
- **Latency Tracking**: Measure webhook processing time vs Moralis polling delay
- **Success Rate**: Track successful vs failed enrichment attempts
- **API Reliability**: Monitor OpenSea API and USD pricing service uptime
- **Duplicate Rate**: Measure how often QuickNode beats Moralis (success metric)

### Phase 4: Gradual Migration

#### 4.1 Moralis Frequency Reduction
- **Step 1**: Reduce Moralis polling from 5min → 10min
- **Step 2**: Further reduce to 15min → 30min
- **Step 3**: Move to 1-hour safety net polling
- **Monitoring**: Ensure no sales are missed during each step

#### 4.2 QuickNode Reliability Testing
- **Webhook Uptime**: Monitor for any QuickNode delivery failures
- **Data Completeness**: Verify all expected sales are captured
- **Error Recovery**: Test system behavior during QuickNode outages
- **Rollback Readiness**: Maintain ability to restore Moralis frequency

### Phase 5: Event-Driven Real-Time Architecture

#### 5.1 Database Event System Implementation
- **PostgreSQL Triggers**: Auto-create database triggers on app startup for new sale notifications
- **Database Event Listener**: New service to listen for PostgreSQL NOTIFY events on new sales
- **Smart Queuing System**: Queue all notifications immediately, process sequentially with rate limiting
- **Batch Handling**: Handle multiple simultaneous sales (e.g., 3-10 from Moralis scheduler) efficiently
- **Zero Database Migration**: No schema changes required, fully backward compatible setup
- **Auto-Setup**: Trigger creation handled automatically on application startup

#### 5.2 Scheduler Architecture Split
- **Modified Sales Scheduler**: Simplified to only fetch from Moralis REST API and store in database
- **Removed Batch Processing**: Scheduler no longer handles tweet posting - only data ingestion
- **Event-Driven Posting**: All tweet posting move to database event listener for instant processing
- **Unified Processing Path**: Single AutoTweetService handles all sales regardless of source
- **Maintained Safety**: 5-minute Moralis fetch continues as reliable background data source

#### 5.3 Real-Time Processing Benefits
- **QuickNode Sales**: Instant posting within 1-2 seconds of webhook receipt
- **Moralis Sales**: Instant posting when 5-minute scheduler stores new sales in database
- **Batch Processing**: Multiple sales (3-10 from Moralis) queued and processed immediately without waiting
- **Sequential Rate Limiting**: Maintains existing 20-second delays between tweets while processing continuously
- **No Lost Sales**: Queue system ensures all notifications are captured and processed in order
- **Single Code Path**: All sales processed through same AutoTweetService with consistent filtering
- **Robust Connection Management**: Auto-reconnecting database listener with health checks
- **Graceful Degradation**: If listener fails, sales remain in database for manual processing

## Implementation Tasks

### Code Changes Required
- [x] **OpenSea API Service** - Created with rate limiting (1 req/sec) and error handling
- [x] **ENS Metadata Service** - Centralized service replacing scattered implementations
- [x] **Duplicate Detection** - Enhanced logging to track QuickNode vs Moralis timing
- [x] **Posted Status Check** - Added check in AutoTweetService to prevent double-posting
- [x] **QuickNode Sales Service** - Complete Seaport event processing with enrichment pipeline
- [x] **Enhanced Webhook Endpoint** - `/webhook/salesv2` now processes and stores enriched sales
- [x] **USD Pricing Integration** - Using existing Alchemy service with 30min caching + $4000 fallback
- [x] **Data Transformation** - QuickNode → ProcessedSale format with OpenSea + ENS metadata
- [x] **Validation Logic** - Only stores sales with successful metadata enrichment
- [x] **Enhanced Logging** - Detailed enrichment flow visibility with fallback warnings
- [x] **Timestamp Consistency** - Matches existing sales processing behavior for block timestamps
- [x] **Removed Description Field** - No longer ingesting NFT descriptions (name + image only)
- [x] **Unified Scheduler Architecture** - Updated scheduler to use database-first approach for all sales
- [x] **Critical Race Condition Fix** - Added missing database `posted` field update to prevent duplicate tweets
- [x] **Club Filtering Enhancement** - Added detailed logging for 10k/999 club detection and filtering
- [x] **Stable Club IDs** - Implemented robust club identification system independent of name changes
- [x] **Consistent Club Detection** - Updated BidsProcessingService to use centralized ClubService
- [ ] **Database Event System** - PostgreSQL NOTIFY/LISTEN triggers for instant sale processing
- [ ] **Database Event Listener Service** - New service with smart queuing to handle real-time sale notifications
- [ ] **Smart Queue Implementation** - Queue system to handle multiple simultaneous sales with proper rate limiting
- [ ] **Scheduler Simplification** - Remove tweet processing from scheduler, keep only Moralis data fetch
- [ ] **Event-Driven AutoTweetService Integration** - Connect listener queue to existing tweet processing logic
- [ ] **Auto-Setup Database Triggers** - Automatic trigger creation on application startup
- [ ] update admin dashboard sales area (db section) to be more like bids section - with avatar, isposted etc

### Infrastructure Requirements
- [x] **OpenSea API Integration** - Service created with 1 req/sec rate limiting
- [x] **USD Pricing Integration** - Using existing Alchemy service for ETH/USD conversion
- [ ] Enhanced monitoring and alerting for webhook failures

## Key Benefits
- **True Real-Time Processing**: QuickNode sales posted within 1-2 seconds (vs 5-minute delay)
- **Instant Moralis Processing**: Even Moralis sales get instant posting when scheduler fetches them
- **Efficient Batch Handling**: Multiple sales (3-10 from Moralis) processed immediately without scheduler delays
- **Smart Queue System**: No lost notifications, proper rate limiting, sequential processing
- **Database-Driven Reliability**: PostgreSQL NOTIFY/LISTEN provides atomic, reliable event system
- **Zero Database Migration**: Auto-setup triggers with no schema changes required
- **Simplified Architecture**: Single processing path for all sales, reduced complexity
- **Proven Technology**: PostgreSQL triggers are battle-tested and highly reliable

## Risk Mitigation
- **Parallel Operation**: No data loss during transition
- **Existing Safeguards**: Race condition protection and duplicate detection
- **Gradual Rollout**: Step-by-step migration with validation at each phase
- **Rollback Plan**: Can restore Moralis polling at any point
- **Monitoring**: Comprehensive logging and alerting for early issue detection
