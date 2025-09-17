-- Add recommended indexes for large channel sets
CREATE INDEX IF NOT EXISTS idx_channels_name     ON channels(name);
CREATE INDEX IF NOT EXISTS idx_channels_group    ON channels(group_name);
CREATE INDEX IF NOT EXISTS idx_channels_enabled  ON channels(enabled);
CREATE INDEX IF NOT EXISTS idx_channels_tvg_id   ON channels(tvg_id);
