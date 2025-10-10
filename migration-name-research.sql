-- Migration: Create name_research table and migrate data
-- This separates ENS name research into a reusable cache

-- Step 1: Create the new name_research table
CREATE TABLE IF NOT EXISTS name_research (
  id SERIAL PRIMARY KEY,
  ens_name VARCHAR(255) NOT NULL UNIQUE,
  research_text TEXT NOT NULL,
  researched_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  source VARCHAR(50) DEFAULT 'web_search',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Step 2: Create index for fast lookups
CREATE INDEX IF NOT EXISTS idx_name_research_ens_name ON name_research(ens_name);
CREATE INDEX IF NOT EXISTS idx_name_research_researched_at ON name_research(researched_at);

-- Step 3: Migrate existing research data from ai_replies
-- Extract unique ENS names and their most recent research
INSERT INTO name_research (ens_name, research_text, researched_at, source)
SELECT DISTINCT ON (ens_name)
  COALESCE(s.nft_name, r.ens_name) as ens_name,
  ar.name_research,
  ar.created_at as researched_at,
  'migrated' as source
FROM ai_replies ar
LEFT JOIN processed_sales s ON ar.sale_id = s.id
LEFT JOIN ens_registrations r ON ar.registration_id = r.id
WHERE ar.name_research IS NOT NULL 
  AND ar.name_research != ''
  AND (s.nft_name IS NOT NULL OR r.ens_name IS NOT NULL)
ORDER BY ens_name, ar.created_at DESC
ON CONFLICT (ens_name) DO NOTHING;

-- Step 4: Add name_research_id column to ai_replies
ALTER TABLE ai_replies ADD COLUMN IF NOT EXISTS name_research_id INTEGER REFERENCES name_research(id);

-- Step 5: Populate name_research_id for existing records
UPDATE ai_replies ar
SET name_research_id = nr.id
FROM name_research nr
LEFT JOIN processed_sales s ON ar.sale_id = s.id
LEFT JOIN ens_registrations r ON ar.registration_id = r.id
WHERE nr.ens_name = COALESCE(s.nft_name, r.ens_name)
  AND ar.name_research_id IS NULL;

-- Step 6: Verify migration
SELECT 
  'name_research' as table_name,
  COUNT(*) as total_records,
  COUNT(DISTINCT ens_name) as unique_names
FROM name_research
UNION ALL
SELECT 
  'ai_replies (linked)' as table_name,
  COUNT(*) as total_records,
  COUNT(DISTINCT name_research_id) as unique_research_ids
FROM ai_replies
WHERE name_research_id IS NOT NULL;

-- Step 7: Show sample data
SELECT 
  nr.ens_name,
  nr.researched_at,
  nr.source,
  COUNT(ar.id) as reply_count
FROM name_research nr
LEFT JOIN ai_replies ar ON ar.name_research_id = nr.id
GROUP BY nr.id, nr.ens_name, nr.researched_at, nr.source
ORDER BY reply_count DESC
LIMIT 5;

-- Migration complete!
-- Note: We're NOT dropping the name_research column from ai_replies yet
-- This allows for safe rollback and verification before final cleanup

