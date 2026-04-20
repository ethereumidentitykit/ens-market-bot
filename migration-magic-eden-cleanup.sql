-- Migration: Clean up orphaned Magic Eden references after migration to Grails
--
-- After removing the MagicEdenV4Service, these system_state rows are no longer
-- read or written by the application. Safe to delete.
--
-- Run manually against your database after deploying the Grails-only build.

-- 1. Remove the orphaned API toggle that was previously read by APIToggleService
DELETE FROM system_state WHERE key = 'api_toggle_magic_eden';

-- 2. Remove the orphaned bid timestamp cursor (Grails uses last_grails_offer_timestamp instead)
DELETE FROM system_state WHERE key = 'last_processed_bid_timestamp';

-- Verify cleanup
SELECT key FROM system_state
WHERE key IN ('api_toggle_magic_eden', 'last_processed_bid_timestamp');
-- Should return zero rows.
