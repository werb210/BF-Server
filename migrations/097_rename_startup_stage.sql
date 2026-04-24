-- Rename STARTUP pipeline stage to canonical "Additional Steps Required"
-- STARTUP was incorrectly used as a pipeline stage; startup product type
-- is tracked via the startup_flag boolean column.
UPDATE applications
  SET pipeline_state  = 'Additional Steps Required',
      current_stage   = 'Additional Steps Required',
      updated_at      = now()
WHERE pipeline_state = 'STARTUP'
   OR pipeline_state = 'Startup';
