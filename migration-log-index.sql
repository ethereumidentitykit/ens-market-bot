-- Migration: Add log_index for duplicate detection
-- This allows multiple sales of the same ENS name to be stored
-- Uniqueness is now based on (transaction_hash, log_index) instead of token_id

-- Step 1: Add log_index column if it doesn't exist
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'processed_sales' AND column_name = 'log_index'
  ) THEN
    ALTER TABLE processed_sales ADD COLUMN log_index INTEGER;
    RAISE NOTICE 'Added log_index column';
  ELSE
    RAISE NOTICE 'log_index column already exists';
  END IF;
END $$;

-- Step 2: Remove UNIQUE constraint from token_id (if it exists)
DO $$ 
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'processed_sales_token_id_key'
  ) THEN
    ALTER TABLE processed_sales DROP CONSTRAINT processed_sales_token_id_key;
    RAISE NOTICE 'Removed UNIQUE constraint from token_id';
  ELSE
    RAISE NOTICE 'token_id UNIQUE constraint does not exist';
  END IF;
END $$;

-- Step 3: Add composite UNIQUE constraint on (transaction_hash, log_index)
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'unique_tx_log'
  ) THEN
    ALTER TABLE processed_sales 
    ADD CONSTRAINT unique_tx_log UNIQUE (transaction_hash, log_index);
    RAISE NOTICE 'Added UNIQUE constraint on (transaction_hash, log_index)';
  ELSE
    RAISE NOTICE 'unique_tx_log constraint already exists';
  END IF;
END $$;

-- Step 4: Add index on log_index for faster lookups
CREATE INDEX IF NOT EXISTS idx_log_index ON processed_sales(log_index);

-- Step 5: Verify the migration
SELECT 
  column_name, 
  data_type, 
  is_nullable 
FROM information_schema.columns 
WHERE table_name = 'processed_sales' 
  AND column_name IN ('token_id', 'log_index', 'transaction_hash')
ORDER BY ordinal_position;

-- Show current constraints
SELECT conname, contype 
FROM pg_constraint 
WHERE conrelid = 'processed_sales'::regclass;

-- Migration complete!
-- Existing data will remain intact
-- Future sales of the same ENS name will now be allowed

