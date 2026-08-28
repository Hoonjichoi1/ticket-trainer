-- D-21: bot claim formula changes from linear (botIntensity, seats/sec) to
-- an exponential-approach depletion curve (botCurveK, 1/sec) — renamed
-- rather than reinterpreted in place since the unit/scale is unrelated.
-- Existing values are stale under the new formula regardless (they'll be
-- overwritten by the D-21 re-tuning pass right after this migration).
ALTER TABLE "SimulationConfig" RENAME COLUMN "botIntensity" TO "botCurveK";
