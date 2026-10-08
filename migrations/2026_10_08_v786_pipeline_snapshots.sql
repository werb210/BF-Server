-- BF_SERVER_REPORTS15_18_v786 - what the pipeline looked like each day (Pipeline snapshots report). History starts the
-- day this is deployed; the snapshot for today is refreshed hourly.
CREATE TABLE IF NOT EXISTS pipeline_snapshots (
  snapshot_date date NOT NULL,
  stage         text NOT NULL,
  files         integer NOT NULL DEFAULT 0,
  amount        numeric NOT NULL DEFAULT 0,
  taken_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (snapshot_date, stage)
);
