ALTER TABLE stock_balances ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE stocktake_lines ADD COLUMN system_version INTEGER NOT NULL DEFAULT 0;
CREATE TRIGGER stock_balance_version AFTER UPDATE OF qty ON stock_balances
BEGIN
  UPDATE stock_balances SET version=OLD.version+1
  WHERE batch_id=NEW.batch_id AND location_id=NEW.location_id;
END;
