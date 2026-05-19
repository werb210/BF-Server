DO $$
BEGIN
  IF to_regclass('public.leads') IS NOT NULL THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_leads_user_id ON public.leads ("userId")';
  END IF;

  IF to_regclass('public.lenders') IS NOT NULL THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_lenders_id ON public.lenders (id)';
  END IF;
END
$$;
