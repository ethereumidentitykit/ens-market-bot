-- ENS Bids Table Migration
-- Add ens_name column to ens_bids table (or create table if not exists)
-- Run this directly in your PostgreSQL client

-- Check if ens_bids table exists and what columns it has
-- \d ens_bids

-- Option 1: If table exists, just add the column
-- ALTER TABLE ens_bids ADD COLUMN IF NOT EXISTS ens_name VARCHAR(255);

-- Option 2: If you want to recreate the table (no bid data to lose)
DROP TABLE IF EXISTS ens_bids CASCADE;

CREATE TABLE ens_bids (
  id SERIAL PRIMARY KEY,
  bid_id VARCHAR(255) NOT NULL UNIQUE,
  contract_address VARCHAR(42) NOT NULL,
  token_id VARCHAR(255),
  
  -- Bid Details
  maker_address VARCHAR(42) NOT NULL,
  taker_address VARCHAR(42),
  status VARCHAR(50) NOT NULL,
  
  -- Pricing
  price_raw VARCHAR(100) NOT NULL,
  price_decimal DECIMAL(18,8) NOT NULL,
  price_usd DECIMAL(12,2),
  currency_contract VARCHAR(42) NOT NULL,
  currency_symbol VARCHAR(20) NOT NULL,
  
  -- Marketplace
  source_domain VARCHAR(255),
  source_name VARCHAR(100),
  marketplace_fee INTEGER,
  
  -- Timestamps & Duration
  created_at_api TIMESTAMP NOT NULL,
  updated_at_api TIMESTAMP NOT NULL,
  valid_from INTEGER NOT NULL,
  valid_until INTEGER NOT NULL,
  processed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  
  -- ENS Metadata (THE IMPORTANT PART!)
  ens_name VARCHAR(255),
  nft_image TEXT,
  nft_description TEXT,
  
  -- Tweet Tracking
  tweet_id VARCHAR(255),
  posted BOOLEAN DEFAULT FALSE,
  
  -- Audit
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for performance
CREATE INDEX idx_bids_bid_id ON ens_bids(bid_id);
CREATE INDEX idx_bids_status ON ens_bids(status);
CREATE INDEX idx_bids_posted ON ens_bids(posted);
CREATE INDEX idx_bids_contract ON ens_bids(contract_address);
CREATE INDEX idx_bids_created_at ON ens_bids(created_at_api);

-- Verify the table was created correctly
\d ens_bids
