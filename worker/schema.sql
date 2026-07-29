CREATE TABLE IF NOT EXISTS daily_scores (
  day_index INTEGER NOT NULL,
  player_id TEXT NOT NULL,
  name TEXT NOT NULL,
  time_seconds INTEGER NOT NULL,
  steps INTEGER NOT NULL,
  hints INTEGER NOT NULL,
  submitted_at INTEGER NOT NULL,
  PRIMARY KEY (day_index, player_id)
);

CREATE INDEX IF NOT EXISTS idx_daily_scores_day ON daily_scores(day_index);
