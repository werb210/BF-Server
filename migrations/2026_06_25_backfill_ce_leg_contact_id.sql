-- Capital&Equipment equipment legs were inserted without contact_id, so the CMP
-- /applications/by-phone switcher (INNER JOIN contacts ON c.id = a.contact_id)
-- dropped them — the client could never select or sign the equipment leg.
-- Backfill contact_id from the parent (capital) application. Idempotent and
-- FK-safe: only touches NULL legs whose parent has a valid contact_id.
UPDATE applications child
   SET contact_id = parent.contact_id,
       updated_at = now()
  FROM applications parent
 WHERE child.parent_application_id = parent.id
   AND child.source = 'capital_and_equipment_leg'
   AND child.contact_id IS NULL
   AND parent.contact_id IS NOT NULL;
