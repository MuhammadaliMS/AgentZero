-- Expand entity_type CHECK constraint for PM-oriented entity types.
-- Keeps 'control' for backward compat with existing rows.
-- Adds: feature, customer, metric.

ALTER TABLE entities DROP CONSTRAINT IF EXISTS entities_entity_type_check;
ALTER TABLE entities ADD CONSTRAINT entities_entity_type_check
  CHECK (entity_type IN (
    'person','project','control','feature','decision','team',
    'tool','vendor','framework','document','process','customer','metric'
  ));
