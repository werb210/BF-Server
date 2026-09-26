--
-- PostgreSQL database dump
--

\restrict mfb79LKYOaXMmNE33eAWKbL6MSTGeGLlK9CbHparUFmhUzxq83mJoiwCHEhqIXW

-- Dumped from database version 17.11
-- Dumped by pg_dump version 17.11

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

-- *not* creating schema, since initdb creates it


--
-- Name: vector; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;


--
-- Name: call_direction_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.call_direction_enum AS ENUM (
    'outbound',
    'inbound'
);


--
-- Name: call_status_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.call_status_enum AS ENUM (
    'initiated',
    'ringing',
    'connected',
    'ended',
    'failed',
    'completed',
    'cancelled',
    'in_progress',
    'no_answer',
    'busy',
    'canceled'
);


--
-- Name: lender_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.lender_status AS ENUM (
    'ACTIVE',
    'INACTIVE'
);


--
-- Name: bf_forename(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bf_forename(p text) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public', 'pg_catalog'
    AS $$ SELECT (string_to_array(btrim(regexp_replace(regexp_replace(lower(coalesce(p,'')), '[^a-z ]', ' ', 'g'), ' +', ' ', 'g')), ' '))[1]; $$;


--
-- Name: bf_norm_name(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bf_norm_name(p text) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public', 'pg_catalog'
    AS $$ SELECT btrim(regexp_replace(regexp_replace(lower(coalesce(p,'')), '[^a-z ]', ' ', 'g'), ' +', ' ', 'g')); $$;


--
-- Name: bf_readiness_over_ask(text, numeric); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bf_readiness_over_ask(p_annual_revenue_range text, p_requested numeric) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT CASE
    WHEN p_requested IS NULL OR p_requested <= 0 THEN false
    ELSE p_requested >= bf_readiness_revenue_basis(p_annual_revenue_range)
  END;
$$;


--
-- Name: bf_readiness_revenue_basis(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bf_readiness_revenue_basis(p_annual_revenue_range text) RETURNS numeric
    LANGUAGE sql IMMUTABLE
    AS $_$
  SELECT CASE
    WHEN lower(coalesce(p_annual_revenue_range,'')) LIKE '%over $3,000,000%' THEN 3000000
    WHEN lower(coalesce(p_annual_revenue_range,'')) LIKE '%$1,000,001 to $3,000,000%' THEN 3000000
    WHEN lower(coalesce(p_annual_revenue_range,'')) LIKE '%$500,001 to $1,000,000%' THEN 1000000
    WHEN lower(coalesce(p_annual_revenue_range,'')) LIKE '%$150,001 to $500,000%' THEN 500000
    WHEN lower(coalesce(p_annual_revenue_range,'')) LIKE '%zero to $150,000%' THEN 150000
    ELSE 150000
  END::numeric;
$_$;


--
-- Name: bf_readiness_score(text, text, text, text, numeric); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bf_readiness_score(p_years text, p_annual_revenue_range text, p_fixed_assets text, p_ar text, p_requested numeric) RETURNS integer
    LANGUAGE sql IMMUTABLE
    AS $_$
  WITH s AS (
    SELECT
      CASE
        WHEN lower(coalesce(p_years,'')) LIKE '%over 3%' OR lower(coalesce(p_years,'')) LIKE '%5+%' OR lower(coalesce(p_years,'')) LIKE '%3-5%' THEN 25
        WHEN lower(coalesce(p_years,'')) LIKE '%1 to 3%' OR lower(coalesce(p_years,'')) LIKE '%2-3%' THEN 15
        WHEN lower(coalesce(p_years,'')) LIKE '%under 1%' OR lower(coalesce(p_years,'')) LIKE '%<1%' THEN 5
        ELSE 0
      END AS yrs,
      CASE
        WHEN lower(coalesce(p_annual_revenue_range,'')) LIKE '%over $3,000,000%' OR lower(coalesce(p_annual_revenue_range,'')) LIKE '%5m+%' THEN 30
        WHEN lower(coalesce(p_annual_revenue_range,'')) LIKE '%$1,000,001 to $3,000,000%' OR lower(coalesce(p_annual_revenue_range,'')) LIKE '%1m-5m%' THEN 24
        WHEN lower(coalesce(p_annual_revenue_range,'')) LIKE '%$500,001 to $1,000,000%' OR lower(coalesce(p_annual_revenue_range,'')) LIKE '%500k-1m%' THEN 18
        WHEN lower(coalesce(p_annual_revenue_range,'')) LIKE '%$150,001 to $500,000%' OR lower(coalesce(p_annual_revenue_range,'')) LIKE '%100k-500k%' THEN 10
        WHEN lower(coalesce(p_annual_revenue_range,'')) LIKE '%zero to $150,000%' OR lower(coalesce(p_annual_revenue_range,'')) LIKE '%<100k%' THEN 4
        ELSE 0
      END AS rev,
      CASE
        WHEN lower(coalesce(p_fixed_assets,'')) LIKE '%over $500,000%' OR lower(coalesce(p_fixed_assets,'')) LIKE '%1m+%' THEN 20
        WHEN lower(coalesce(p_fixed_assets,'')) LIKE '%$250,001 to $500,000%' OR lower(coalesce(p_fixed_assets,'')) LIKE '%500k%' THEN 14
        WHEN lower(coalesce(p_fixed_assets,'')) LIKE '%$100,001 to $250,000%' OR lower(coalesce(p_fixed_assets,'')) LIKE '%100k%' THEN 8
        WHEN lower(coalesce(p_fixed_assets,'')) LIKE '%$1 to $50,000%' OR lower(coalesce(p_fixed_assets,'')) LIKE '%$50,001 to $100,000%' OR lower(coalesce(p_fixed_assets,'')) LIKE '%<100k%' THEN 3
        ELSE 0
      END AS coll,
      CASE
        WHEN lower(coalesce(p_ar,'')) LIKE '%over $3,000,000%' OR lower(coalesce(p_ar,'')) LIKE '%$1,000,000 to $3,000,000%' OR lower(coalesce(p_ar,'')) LIKE '%500k+%' THEN 15
        WHEN lower(coalesce(p_ar,'')) LIKE '%$250,000 to $500,000%' OR lower(coalesce(p_ar,'')) LIKE '%$100,000 to $250,000%' OR lower(coalesce(p_ar,'')) LIKE '%100k-500k%' THEN 10
        WHEN lower(coalesce(p_ar,'')) LIKE '%zero to $100,000%' OR lower(coalesce(p_ar,'')) LIKE '%<100k%' THEN 4
        ELSE 0
      END AS ar,
      CASE
        WHEN p_requested IS NULL OR p_requested <= 0 THEN 5
        WHEN p_requested / bf_readiness_revenue_basis(p_annual_revenue_range) < 0.1 THEN 10
        WHEN p_requested / bf_readiness_revenue_basis(p_annual_revenue_range) < 0.3 THEN 8
        WHEN p_requested / bf_readiness_revenue_basis(p_annual_revenue_range) < 0.6 THEN 4
        WHEN p_requested / bf_readiness_revenue_basis(p_annual_revenue_range) < 1.0 THEN 1
        ELSE 0
      END AS req
  )
  SELECT GREATEST(0, LEAST(100, s.yrs + s.rev + s.coll + s.ar + s.req)) FROM s;
$_$;


--
-- Name: bf_readiness_tier(integer, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bf_readiness_tier(p_score integer, p_over_ask boolean) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT CASE
    WHEN p_score >= 50 AND coalesce(p_over_ask, false) THEN 'yellow'  -- capped
    WHEN p_score >= 50 THEN 'green'
    WHEN p_score >= 30 THEN 'yellow'
    ELSE 'red'
  END;
$$;


--
-- Name: bf_same_person_name(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bf_same_person_name(a text, b text) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE na text; nb text; sa text; sb text; fa text; fb text;
BEGIN
  na := bf_norm_name(a); nb := bf_norm_name(b);
  IF na = '' OR nb = '' THEN RETURN false; END IF;
  IF na = nb THEN RETURN true; END IF;
  sa := bf_surname(a); sb := bf_surname(b);
  IF sa IS DISTINCT FROM sb OR length(coalesce(sa,'')) < 2 THEN RETURN false; END IF;
  fa := bf_forename(a); fb := bf_forename(b);
  RETURN fa = fb
      OR (length(fa) >= 3 AND fb LIKE fa || '%')
      OR (length(fb) >= 3 AND fa LIKE fb || '%')
      OR left(fa, 1) = left(fb, 1);
END;
$$;


--
-- Name: bf_surname(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bf_surname(p text) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public', 'pg_catalog'
    AS $$ SELECT (string_to_array(btrim(regexp_replace(regexp_replace(lower(coalesce(p,'')), '[^a-z ]', ' ', 'g'), ' +', ' ', 'g')), ' '))[
       array_length(string_to_array(btrim(regexp_replace(regexp_replace(lower(coalesce(p,'')), '[^a-z ]', ' ', 'g'), ' +', ' ', 'g')), ' '), 1)]; $$;


--
-- Name: sba_attach_stage2_requirements(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sba_attach_stage2_requirements() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF upper(COALESCE(NEW.type,'')) NOT IN ('SBA','SBA_GOVERNMENT') THEN
    RETURN NEW;
  END IF;

  INSERT INTO lender_product_requirements (lender_product_id, document_type, required, stage)
  SELECT NEW.id, t.doc_type, t.is_required, 2
    FROM (VALUES
        ('sba_form_413',         true),
        ('sba_form_1919',        true),
        ('owner_photo_id',       true),
        ('formation_documents',  true),
        ('personal_tax_returns', true),
        ('business_plan',        true),
        ('sba_1919_attachments', false),
        ('lease_or_loi',         false)
      ) AS t(doc_type, is_required)
   WHERE NOT EXISTS (
     SELECT 1 FROM lender_product_requirements r
      WHERE r.lender_product_id = NEW.id AND r.document_type = t.doc_type
   );

  RETURN NEW;
END;
$$;


--
-- Name: sba_merge_stage2_into_product_json(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sba_merge_stage2_into_product_json() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  wanted jsonb;
  have   jsonb;
BEGIN
  IF upper(COALESCE(NEW.type,'')) NOT IN ('SBA','SBA_GOVERNMENT') THEN
    RETURN NEW;
  END IF;

  wanted := '[
    {"document_type":"sba_form_413",         "required":true,  "stage":2},
    {"document_type":"sba_form_1919",        "required":true,  "stage":2},
    {"document_type":"owner_photo_id",       "required":true,  "stage":2},
    {"document_type":"formation_documents",  "required":true,  "stage":2},
    {"document_type":"personal_tax_returns", "required":true,  "stage":2},
    {"document_type":"business_plan",        "required":true,  "stage":2},
    {"document_type":"sba_1919_attachments", "required":false, "stage":2},
    {"document_type":"lease_or_loi",         "required":false, "stage":2}
  ]'::jsonb;

  have := CASE
            WHEN jsonb_typeof(COALESCE(NEW.required_documents,'[]'::jsonb)) = 'array'
              THEN NEW.required_documents
            ELSE '[]'::jsonb
          END;

  NEW.required_documents := have || (
    SELECT COALESCE(jsonb_agg(w), '[]'::jsonb)
      FROM jsonb_array_elements(wanted) AS w
     WHERE NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(have) AS h
        WHERE COALESCE(h->>'document_type', h->>'category') = w->>'document_type'
     )
  );

  RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: accountant_invites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.accountant_invites (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    application_id text NOT NULL,
    contact_id uuid NOT NULL,
    email text NOT NULL,
    sent_at timestamp with time zone,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    business_name text
);


--
-- Name: ads_negatives_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ads_negatives_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    campaign_id text NOT NULL,
    campaign_name text,
    term text NOT NULL,
    match_type text NOT NULL,
    resource_name text,
    added_by text,
    added_at timestamp with time zone DEFAULT now() NOT NULL,
    removed_at timestamp with time zone
);


--
-- Name: ai_admin_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_admin_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    rule_type text,
    content text,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: ai_embeddings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_embeddings (
    id uuid NOT NULL,
    source_type text NOT NULL,
    source_id text,
    content text NOT NULL,
    embedding public.vector(1536)
);


--
-- Name: ai_escalations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_escalations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid,
    messages jsonb NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: ai_issues; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_issues (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid,
    message text,
    screenshot text,
    page_url text,
    resolved boolean DEFAULT false,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: ai_knowledge; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_knowledge (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text NOT NULL,
    content text NOT NULL,
    source_type text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    source_id text,
    embedding public.vector(1536)
);


--
-- Name: ai_knowledge_chunks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_knowledge_chunks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    document_id uuid,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: ai_knowledge_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_knowledge_documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: ai_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid,
    role character varying(20) NOT NULL,
    content text NOT NULL,
    metadata jsonb,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: ai_policy_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_policy_rules (
    id uuid NOT NULL,
    rule_key text,
    rule_type text NOT NULL,
    content text NOT NULL,
    active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: ai_prequal_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_prequal_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: ai_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    rule_type text DEFAULT 'system'::text NOT NULL,
    rule_content text NOT NULL,
    priority integer DEFAULT 100 NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    rule_key text,
    rule_value text
);


--
-- Name: ai_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source character varying(20) NOT NULL,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    contact_id uuid,
    created_at timestamp without time zone DEFAULT now(),
    closed_at timestamp without time zone,
    visitor_id text NOT NULL,
    context text NOT NULL,
    company_name text,
    full_name text,
    email text,
    phone text,
    application_token text,
    startup_interest_tags jsonb DEFAULT '[]'::jsonb NOT NULL
);


--
-- Name: ai_system_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_system_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    rule_key text NOT NULL,
    rule_value text NOT NULL,
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: ai_voice_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_voice_state (
    session_id uuid NOT NULL,
    state text NOT NULL,
    last_event jsonb,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: analytics_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.analytics_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    ip text,
    user_agent text,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: application_collateral; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.application_collateral (
    id bigint NOT NULL,
    application_id text NOT NULL,
    kind text NOT NULL,
    source_document_id text NOT NULL,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    extracted_by text DEFAULT 'ai'::text NOT NULL,
    edited_by text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: application_collateral_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.application_collateral_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: application_collateral_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.application_collateral_id_seq OWNED BY public.application_collateral.id;


--
-- Name: application_contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.application_contacts (
    application_id text NOT NULL,
    contact_id uuid NOT NULL,
    role text DEFAULT 'applicant'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT application_contacts_role_check CHECK ((role = ANY (ARRAY['applicant'::text, 'partner'::text, 'guarantor'::text, 'other'::text])))
);


--
-- Name: application_continuations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.application_continuations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    token text NOT NULL,
    company_name text,
    full_name text,
    email text,
    phone text,
    industry text,
    years_in_business integer,
    monthly_revenue numeric,
    annual_revenue numeric,
    ar_outstanding numeric,
    existing_debt boolean,
    crm_lead_id uuid,
    converted_application_id text,
    created_at timestamp without time zone DEFAULT now(),
    converted_at timestamp without time zone
);


--
-- Name: application_document_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.application_document_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    application_id text NOT NULL,
    document_type text NOT NULL,
    requested_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: application_document_waivers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.application_document_waivers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    application_id text NOT NULL,
    document_type text NOT NULL,
    waived_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: application_financials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.application_financials (
    id bigint NOT NULL,
    application_id text NOT NULL,
    period text NOT NULL,
    period_end date,
    kind text DEFAULT 'annual'::text NOT NULL,
    line_item text NOT NULL,
    value numeric NOT NULL,
    source_document_id text,
    extracted_by text DEFAULT 'ai'::text NOT NULL,
    edited_by text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: application_financials_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.application_financials_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: application_financials_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.application_financials_id_seq OWNED BY public.application_financials.id;


--
-- Name: application_form_responses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.application_form_responses (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    application_id text NOT NULL,
    doc_type text NOT NULL,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    submitted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    owner_fingerprint text
);


--
-- Name: application_lender_responses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.application_lender_responses (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    application_id text NOT NULL,
    lender_id text NOT NULL,
    ordinal integer NOT NULL,
    outcome text DEFAULT 'declined'::text NOT NULL,
    reason text DEFAULT ''::text NOT NULL,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: application_lender_selections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.application_lender_selections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    application_id text NOT NULL,
    lender_id uuid NOT NULL,
    selected_by text,
    selected_at timestamp with time zone DEFAULT now() NOT NULL,
    is_primary boolean DEFAULT false NOT NULL,
    "position" integer,
    finalized_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: application_packages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.application_packages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    application_id text NOT NULL,
    lender_id uuid NOT NULL,
    blob_name text,
    blob_url text,
    size_bytes bigint,
    status text DEFAULT 'pending'::text NOT NULL,
    failure_reason text,
    built_at timestamp with time zone,
    sent_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    sent_manually boolean DEFAULT false NOT NULL,
    sent_by_user_id text,
    sent_note text
);


--
-- Name: application_stage_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.application_stage_events (
    id uuid NOT NULL,
    application_id text NOT NULL,
    from_stage text,
    to_stage text NOT NULL,
    trigger text NOT NULL,
    triggered_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    reason text
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid NOT NULL,
    email text NOT NULL,
    password_hash text,
    role text,
    active boolean NOT NULL,
    password_changed_at timestamp with time zone,
    failed_login_attempts integer DEFAULT 0 NOT NULL,
    locked_until timestamp with time zone,
    token_version integer DEFAULT 0 NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    phone_number text,
    phone_verified boolean DEFAULT false,
    phone text,
    disabled boolean DEFAULT false,
    is_active boolean,
    silo text,
    lender_id uuid,
    status text DEFAULT 'ACTIVE'::text,
    o365_user_email text,
    o365_access_token text,
    o365_refresh_token text,
    o365_token_expires_at timestamp with time zone,
    first_name text,
    last_name text,
    last_login_at timestamp with time zone,
    profile_image_url text,
    silos text[] DEFAULT ARRAY[]::text[] NOT NULL,
    o365_access_token_expires_at timestamp with time zone,
    o365_account_id text,
    outbound_caller_id text,
    deleted_at timestamp with time zone,
    quick_call_slots jsonb DEFAULT '[]'::jsonb NOT NULL,
    company_name text,
    profile_complete boolean DEFAULT false NOT NULL,
    street text,
    city text,
    province text,
    postal_code text,
    etransfer_email text,
    referrer_status text,
    referrer_commission_rate numeric DEFAULT 20 NOT NULL,
    agreement_document_group_id text,
    agreement_document_id text,
    agreement_signed_at timestamp with time zone,
    verified_callback_number text,
    callback_verified_at timestamp with time zone,
    CONSTRAINT users_status_check CHECK ((status = ANY (ARRAY['ACTIVE'::text, 'INACTIVE'::text])))
);


--
-- Name: application_pipeline_history_view; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.application_pipeline_history_view AS
 SELECT ase.application_id,
    ase.from_stage,
    ase.to_stage,
    ase.trigger,
    ase.triggered_by AS actor_id,
    u.role AS actor_role,
        CASE
            WHEN (ase.triggered_by = 'system'::text) THEN 'system'::text
            WHEN (u.role = ANY (ARRAY['ADMIN'::text, 'STAFF'::text])) THEN 'staff'::text
            ELSE 'system'::text
        END AS actor_type,
    ase.created_at AS occurred_at,
    ase.reason
   FROM (public.application_stage_events ase
     LEFT JOIN public.users u ON (((u.id)::text = ase.triggered_by)));


--
-- Name: application_pipeline_history; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.application_pipeline_history AS
 SELECT application_id,
    from_stage,
    to_stage,
    trigger,
    actor_id,
    actor_role,
    actor_type,
    occurred_at,
    reason
   FROM public.application_pipeline_history_view;


--
-- Name: application_rejection_reasons; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.application_rejection_reasons (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    application_id text NOT NULL,
    lender_id text,
    reason_code text NOT NULL,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: application_required_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.application_required_documents (
    id uuid NOT NULL,
    application_id text NOT NULL,
    document_category text NOT NULL,
    status text DEFAULT 'missing'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    is_required boolean DEFAULT true NOT NULL,
    CONSTRAINT application_required_documents_status_check CHECK ((status = ANY (ARRAY['missing'::text, 'uploaded'::text, 'accepted'::text, 'rejected'::text])))
);


--
-- Name: application_research_facts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.application_research_facts (
    id bigint NOT NULL,
    application_id text NOT NULL,
    source text NOT NULL,
    category text DEFAULT 'web'::text NOT NULL,
    label text NOT NULL,
    value text NOT NULL,
    url text,
    status text DEFAULT 'unverified'::text NOT NULL,
    updated_by text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: application_research_facts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.application_research_facts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: application_research_facts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.application_research_facts_id_seq OWNED BY public.application_research_facts.id;


--
-- Name: application_stage_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.application_stage_history (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    application_id text NOT NULL,
    from_stage text,
    to_stage text NOT NULL,
    reason text,
    actor_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: application_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.application_tasks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    application_id text NOT NULL,
    kind text NOT NULL,
    title text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    hashtag text,
    related_message_id uuid,
    completed_at timestamp with time zone,
    completed_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT application_tasks_status_check CHECK ((status = ANY (ARRAY['open'::text, 'completed'::text, 'skipped'::text])))
);


--
-- Name: applications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.applications (
    id text NOT NULL,
    owner_user_id uuid,
    name text NOT NULL,
    metadata jsonb,
    pipeline_state text DEFAULT 'draft'::text NOT NULL,
    created_at timestamp without time zone NOT NULL,
    updated_at timestamp without time zone NOT NULL,
    product_type text DEFAULT 'standard'::text NOT NULL,
    status text DEFAULT 'NEW'::text NOT NULL,
    lender_id uuid,
    lender_product_id uuid,
    requested_amount numeric,
    source text,
    business_legal_name text,
    ocr_missing_fields jsonb,
    ocr_conflicting_fields jsonb,
    ocr_normalized_values jsonb,
    ocr_has_missing_fields boolean DEFAULT false NOT NULL,
    ocr_has_conflicts boolean DEFAULT false NOT NULL,
    ocr_insights_updated_at timestamp with time zone,
    company_id uuid,
    contact_id uuid,
    product_category text,
    current_stage text,
    first_opened_at timestamp with time zone,
    startup_flag boolean DEFAULT false NOT NULL,
    credit_summary_completed_at timestamp with time zone,
    processing_stage text DEFAULT 'pending'::text NOT NULL,
    application_status text DEFAULT 'in_progress'::text NOT NULL,
    current_step integer DEFAULT 1 NOT NULL,
    last_updated timestamp with time zone DEFAULT now() NOT NULL,
    is_completed boolean DEFAULT false NOT NULL,
    ocr_completed_at timestamp with time zone,
    banking_completed_at timestamp with time zone,
    silo text DEFAULT 'BF'::text NOT NULL,
    submitted_at timestamp with time zone,
    pending_acceptance_offer_id uuid,
    pending_acceptance_at timestamp with time zone,
    signnow_app_document_id text,
    signnow_app_signed_at timestamp with time zone,
    submission_chain_started_at timestamp with time zone,
    parent_application_id text,
    lender_matches jsonb,
    lender_matches_computed_at timestamp with time zone,
    lender_matches_stale boolean DEFAULT true NOT NULL,
    bi_application_id text,
    bi_public_id text,
    bi_completion_url text,
    submission_packages_started_at timestamp with time zone,
    last_portal_seen_at timestamp with time zone,
    previous_processing_stage text,
    lender_matches_inputs jsonb,
    lender_matches_missing_inputs jsonb DEFAULT '[]'::jsonb,
    signnow_document_id text,
    funded_amount numeric(14,2),
    funded_at timestamp with time zone,
    funded_currency text DEFAULT 'CAD'::text NOT NULL,
    parked_previous_stage text,
    parked_at timestamp with time zone,
    parked_by text,
    parked_reason text,
    fraud_confirmed_at timestamp with time zone,
    fraud_confirmed_by text,
    fraud_evidence jsonb DEFAULT '[]'::jsonb NOT NULL,
    abandon_sms_sent_at timestamp with time zone,
    abandon_task_created_at timestamp with time zone,
    abandon_sms_attempts integer DEFAULT 0 NOT NULL,
    rejection_email_sent_at timestamp with time zone,
    CONSTRAINT applications_status_check CHECK (((status IS NULL) OR (status = ANY (ARRAY['RECEIVED'::text, 'DOCUMENTS_REQUIRED'::text, 'IN_REVIEW'::text, 'STARTUP'::text, 'OFF_TO_LENDER'::text, 'SUBMITTED_TO_LENDER'::text, 'ACCEPTED'::text, 'DECLINED'::text]))))
);


--
-- Name: audit_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.audit_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: audit_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_events (
    id text DEFAULT (nextval('public.audit_events_id_seq'::regclass))::text NOT NULL,
    user_id uuid,
    action text,
    ip text,
    user_agent text,
    success boolean NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    actor_user_id uuid,
    target_user_id uuid,
    request_id text,
    target_type text,
    target_id text,
    event_type text,
    event_action text,
    ip_address text,
    metadata jsonb
);


--
-- Name: audit_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_logs (
    id text NOT NULL,
    actor_user_id uuid,
    action text NOT NULL,
    entity text NOT NULL,
    entity_id text,
    ip text,
    success boolean NOT NULL,
    created_at timestamp with time zone NOT NULL
);


--
-- Name: auth_refresh_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_refresh_tokens (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    token text
);


--
-- Name: automation_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.automation_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    silo text DEFAULT 'BF'::text NOT NULL,
    name text NOT NULL,
    trigger_type text NOT NULL,
    conditions jsonb DEFAULT '{}'::jsonb NOT NULL,
    actions jsonb DEFAULT '[]'::jsonb NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: banking_analyses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.banking_analyses (
    application_id text NOT NULL,
    accounts jsonb DEFAULT '[]'::jsonb NOT NULL,
    total_avg_monthly_deposits numeric(14,2),
    average_daily_balance numeric(14,2),
    negative_balance_days integer,
    total_deposits numeric(14,2),
    total_withdrawals numeric(14,2),
    average_monthly_nsfs numeric(8,2),
    days_with_insufficient_funds integer,
    months_profitable_numerator integer,
    months_profitable_denominator integer,
    current_month_net_cash_flow numeric(14,2),
    unusual_transactions jsonb DEFAULT '[]'::jsonb NOT NULL,
    top_vendors jsonb DEFAULT '[]'::jsonb NOT NULL,
    period_start date,
    period_end date,
    months_detected integer,
    status text DEFAULT 'pending'::text NOT NULL,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 3 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    last_error text,
    integrity_report jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: banking_analysis_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.banking_analysis_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    application_id text NOT NULL,
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    retry_count integer DEFAULT 0 NOT NULL,
    last_retry_at timestamp with time zone,
    max_retries integer DEFAULT 2 NOT NULL,
    started_at timestamp with time zone,
    error_message text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT banking_analysis_jobs_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'completed'::text, 'failed'::text])))
);


--
-- Name: banking_monthly_summaries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.banking_monthly_summaries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    application_id text NOT NULL,
    month_start date NOT NULL,
    total_deposits numeric(14,2) DEFAULT 0 NOT NULL,
    total_withdrawals numeric(14,2) DEFAULT 0 NOT NULL,
    net_cash_flow numeric(14,2) DEFAULT 0 NOT NULL,
    ending_balance numeric(14,2),
    nsf_count integer DEFAULT 0 NOT NULL
);


--
-- Name: banking_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.banking_transactions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    application_id text NOT NULL,
    document_id text,
    account_label text,
    transaction_date date NOT NULL,
    description text,
    amount numeric(14,2) NOT NULL,
    balance_after numeric(14,2),
    is_nsf boolean DEFAULT false NOT NULL,
    is_unusual boolean DEFAULT false NOT NULL,
    category text,
    vendor text,
    raw_text text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    currency_code text,
    account_key text
);


--
-- Name: booking_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.booking_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    graph_event_id text NOT NULL,
    silo text DEFAULT 'BF'::text NOT NULL,
    organizer_upn text,
    subject text,
    service_name text,
    customer_name text,
    customer_email text,
    customer_phone text,
    customer_address text,
    customer_notes text,
    scheduled_at timestamp with time zone,
    scheduled_end_at timestamp with time zone,
    contact_id uuid,
    task_id uuid,
    status text DEFAULT 'pending'::text NOT NULL,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: borrowers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.borrowers (
    id uuid NOT NULL,
    application_id text NOT NULL,
    company_name text NOT NULL,
    operating_name text,
    entity_type text,
    incorporation_date date,
    country text,
    province_state text,
    industry text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: broker_deal_confirmations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.broker_deal_confirmations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    application_id text NOT NULL,
    broker_name text NOT NULL,
    boreal_pct numeric(5,2),
    broker_pct numeric(5,2),
    terms text,
    notes text,
    agreed_by_broker text,
    agreed_on date,
    recorded_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: broker_imports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.broker_imports (
    id uuid NOT NULL,
    broker_name text NOT NULL,
    zip_name text,
    application_id text,
    applicant_phone text,
    status text DEFAULT 'processing'::text NOT NULL,
    summary jsonb DEFAULT '{}'::jsonb NOT NULL,
    error text,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: calendar_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.calendar_tasks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    silo text DEFAULT 'BF'::text NOT NULL,
    title text NOT NULL,
    notes text,
    due_at timestamp with time zone,
    priority text DEFAULT 'normal'::text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    o365_task_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    assignee_user_id uuid
);


--
-- Name: call_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.call_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    contact_id uuid,
    application_id uuid,
    silo text,
    event_type text NOT NULL,
    direction text,
    from_number text,
    to_number text,
    twilio_call_sid text,
    duration_seconds integer,
    error_code text,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT call_events_direction_check CHECK ((direction = ANY (ARRAY['outbound'::text, 'inbound'::text]))),
    CONSTRAINT call_events_event_type_check CHECK ((event_type = ANY (ARRAY['call.started'::text, 'call.ended'::text, 'call.failed'::text, 'call.missed'::text, 'call.declined'::text])))
);


--
-- Name: call_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.call_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    application_id text,
    twilio_call_sid text,
    from_number text,
    to_number text,
    direction text,
    duration integer,
    status text,
    recording_sid text,
    answered boolean,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    error_code text,
    error_message text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    recording_duration_seconds integer,
    ended_reason character varying(64),
    price_estimate_cents integer,
    staff_user_id uuid,
    crm_contact_id uuid,
    duration_seconds integer,
    ended_at timestamp with time zone,
    phone_number text,
    contact_id uuid,
    silo text DEFAULT 'BF'::text NOT NULL,
    disposition text,
    CONSTRAINT call_logs_recording_duration_check CHECK (((recording_duration_seconds IS NULL) OR (recording_duration_seconds >= 0)))
);


--
-- Name: call_recordings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.call_recordings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    conference_id uuid,
    twilio_recording_sid text,
    url text,
    duration_sec integer,
    channels integer,
    status text DEFAULT 'in-progress'::text NOT NULL,
    transcription_sid text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: call_transcripts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.call_transcripts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    conference_id uuid,
    transcription_sid text,
    source text DEFAULT 'realtime'::text NOT NULL,
    status text DEFAULT 'in-progress'::text NOT NULL,
    full_text text,
    segments_json jsonb,
    voice_intelligence_sid text,
    voice_intelligence_summary text,
    pii_redacted_text text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    suggested_tasks jsonb
);


--
-- Name: capital_readiness; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.capital_readiness (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    lead_id uuid NOT NULL,
    score integer NOT NULL,
    tier character varying(50) NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: chat_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid,
    created_at timestamp with time zone DEFAULT now(),
    message text NOT NULL,
    metadata jsonb,
    content text NOT NULL,
    role text
);


--
-- Name: chat_queue; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_queue (
    id uuid NOT NULL,
    session_id uuid,
    priority integer DEFAULT 1,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: chat_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    staff_override boolean DEFAULT false NOT NULL,
    status character varying(50) DEFAULT 'ai'::character varying NOT NULL,
    source character varying(50) DEFAULT 'website'::character varying NOT NULL,
    channel character varying(20) DEFAULT 'text'::character varying NOT NULL,
    lead_id uuid,
    crm_contact_id uuid,
    assigned_to uuid,
    CONSTRAINT chat_sessions_status_check CHECK (((status)::text = ANY ((ARRAY['ai'::character varying, 'queued'::character varying, 'live'::character varying, 'closed'::character varying])::text[])))
);


--
-- Name: client_device_credentials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.client_device_credentials (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    phone text NOT NULL,
    secret_hash text NOT NULL,
    device_label text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone,
    expires_at timestamp with time zone DEFAULT (now() + '180 days'::interval) NOT NULL,
    revoked_at timestamp with time zone
);


--
-- Name: client_issues; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.client_issues (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    application_id text,
    contact_phone text,
    message text NOT NULL,
    screenshot_b64 text,
    user_agent text,
    url text,
    silo text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: client_notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.client_notifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    application_id text,
    phone10 text NOT NULL,
    kind text NOT NULL,
    channel text NOT NULL,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: client_push_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.client_push_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id text,
    token text NOT NULL,
    platform text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: client_submissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.client_submissions (
    id text NOT NULL,
    submission_key text NOT NULL,
    application_id text NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamp without time zone NOT NULL
);


--
-- Name: collateral; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.collateral (
    id uuid NOT NULL,
    borrower_id uuid NOT NULL,
    accounts_receivable_value numeric(14,2),
    inventory_value numeric(14,2),
    equipment_value numeric(14,2),
    real_estate_value numeric(14,2),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: collateral_assets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.collateral_assets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    audience text,
    doc_type text,
    blob_name text NOT NULL,
    content_type text,
    size_bytes bigint,
    silo text DEFAULT 'BF'::text NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: communications_conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.communications_conversations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    contact_id uuid,
    contact_name text,
    contact_phone text,
    channel text NOT NULL,
    last_message_preview text,
    last_message_at timestamp with time zone,
    unread integer DEFAULT 0 NOT NULL,
    silo text DEFAULT 'BF'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: communications_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.communications_messages (
    id uuid NOT NULL,
    type text,
    direction text,
    status text,
    contact_id uuid,
    body text,
    created_at timestamp without time zone DEFAULT now(),
    application_id text,
    staff_name text,
    from_number text,
    to_number text,
    phone_number text,
    twilio_sid text,
    silo text DEFAULT 'BF'::text NOT NULL,
    read_at timestamp with time zone,
    cta_label text,
    cta_action text,
    conversation_id uuid,
    channel text,
    twilio_message_sid text,
    attachments jsonb,
    media_url text,
    media_duration_seconds integer
);


--
-- Name: companies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.companies (
    id uuid NOT NULL,
    name text,
    website text,
    email text,
    phone text,
    status text DEFAULT 'prospect'::text NOT NULL,
    owner_id uuid,
    referrer_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    city text,
    province text,
    country text,
    industry text,
    annual_revenue numeric,
    number_of_employees integer,
    silo text DEFAULT 'BF'::text NOT NULL,
    types_of_financing text[] DEFAULT '{}'::text[] NOT NULL,
    dba_name text,
    legal_name text,
    business_structure text,
    address_street text,
    address_city text,
    address_state text,
    address_zip text,
    address_country text,
    start_date date,
    employee_count integer,
    estimated_annual_revenue numeric(18,2),
    domain text,
    lender_id uuid,
    region text
);


--
-- Name: company_research_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.company_research_cache (
    cache_key text NOT NULL,
    places jsonb,
    web jsonb DEFAULT '[]'::jsonb NOT NULL,
    fetched_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: conference_participants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conference_participants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    conference_id uuid NOT NULL,
    twilio_call_sid text,
    twilio_participant_label text,
    identity text,
    phone_number text,
    kind text NOT NULL,
    role text DEFAULT 'participant'::text NOT NULL,
    status text DEFAULT 'invited'::text NOT NULL,
    muted boolean DEFAULT false NOT NULL,
    on_hold boolean DEFAULT false NOT NULL,
    joined_at timestamp with time zone,
    left_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: conferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conferences (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    twilio_conference_sid text,
    friendly_name text NOT NULL,
    status text DEFAULT 'init'::text NOT NULL,
    silo text DEFAULT 'BF'::text NOT NULL,
    created_by_user_id text,
    application_id text,
    contact_id text,
    direction text DEFAULT 'outbound'::text NOT NULL,
    recording_sid text,
    recording_url text,
    recording_status text,
    recording_paused boolean DEFAULT false NOT NULL,
    started_at timestamp with time zone,
    ended_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: contact_ad_attribution; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contact_ad_attribution (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    contact_id uuid NOT NULL,
    gclid text NOT NULL,
    click_date date,
    campaign_id text,
    campaign_name text,
    ad_group_id text,
    ad_group_name text,
    ad_id text,
    keyword text,
    keyword_match_type text,
    raw_click jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: contact_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contact_documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    contact_id uuid NOT NULL,
    silo text DEFAULT 'BF'::text NOT NULL,
    filename text NOT NULL,
    content_type text,
    size_bytes bigint,
    blob_name text NOT NULL,
    blob_url text,
    source text DEFAULT 'email'::text NOT NULL,
    source_message_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: contact_leads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contact_leads (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company text NOT NULL,
    first_name text NOT NULL,
    last_name text NOT NULL,
    email text NOT NULL,
    phone text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: contact_merges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contact_merges (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    silo text DEFAULT 'BF'::text NOT NULL,
    survivor_id uuid NOT NULL,
    loser_id uuid NOT NULL,
    moved jsonb DEFAULT '{}'::jsonb NOT NULL,
    loser_snapshot jsonb,
    merged_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contacts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid,
    name text,
    email text,
    phone text,
    status text DEFAULT 'prospect'::text NOT NULL,
    owner_id uuid,
    referrer_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    silo text DEFAULT 'BF'::text NOT NULL,
    user_id uuid,
    company_name text,
    job_title text,
    lead_status text DEFAULT 'New'::text,
    tags text[] DEFAULT '{}'::text[],
    first_name text,
    last_name text,
    lifecycle_stage text DEFAULT 'lead'::text,
    role text DEFAULT 'unknown'::text,
    dob date,
    ssn_encrypted bytea,
    address_street text,
    address_city text,
    address_state text,
    address_zip text,
    address_country text,
    ownership_percent numeric(5,2),
    is_primary_applicant boolean DEFAULT false NOT NULL,
    marketing_opt_out boolean DEFAULT false NOT NULL,
    sms_opt_out boolean DEFAULT false NOT NULL,
    line_type text,
    line_type_checked_at timestamp with time zone,
    ref_code text,
    referral_silos text[] DEFAULT ARRAY['BF'::text] NOT NULL,
    referral_invite_message text,
    referral_invited_at timestamp with time zone,
    referred_via_code text,
    merged_into_id uuid,
    merged_at timestamp with time zone,
    sms_consent boolean,
    consent_basis text,
    consent_at timestamp with time zone,
    consent_source text,
    outlook_contact_id text,
    onedrive_folder_id text,
    onedrive_drive_id text,
    onedrive_folder_url text,
    secondary_email text,
    secondary_phone text,
    CONSTRAINT contacts_role_check CHECK ((role = ANY (ARRAY['applicant'::text, 'partner'::text, 'guarantor'::text, 'other'::text, 'unknown'::text])))
);


--
-- Name: continuation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.continuation (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_name text NOT NULL,
    full_name text NOT NULL,
    email text NOT NULL,
    phone text NOT NULL,
    industry text NOT NULL,
    years_in_business text,
    monthly_revenue text,
    annual_revenue text,
    ar_outstanding text,
    existing_debt text,
    used_in_application boolean DEFAULT false,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: continuation_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.continuation_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text,
    phone text,
    full_name text,
    company_name text,
    prefill jsonb,
    application_id text,
    created_at timestamp without time zone DEFAULT now(),
    application_status text DEFAULT 'in_progress'::text NOT NULL,
    current_step integer DEFAULT 1 NOT NULL,
    last_updated timestamp with time zone DEFAULT now() NOT NULL,
    is_completed boolean DEFAULT false NOT NULL
);


--
-- Name: credit_summaries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.credit_summaries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    application_id text NOT NULL,
    sections jsonb DEFAULT '{}'::jsonb NOT NULL,
    inputs_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    ai_suggestions jsonb DEFAULT '{}'::jsonb NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    is_locked boolean DEFAULT false NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    generated_at timestamp with time zone,
    submitted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT credit_summaries_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'submitted'::text, 'locked'::text])))
);


--
-- Name: credit_summaries_v2; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.credit_summaries_v2 (
    application_id text NOT NULL,
    doc jsonb NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    submitted_by_id text,
    submitted_by_name text,
    submitted_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: credit_summary_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.credit_summary_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    application_id text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    retry_count integer DEFAULT 0 NOT NULL,
    last_retry_at timestamp with time zone,
    max_retries integer DEFAULT 1 NOT NULL,
    started_at timestamp with time zone,
    error_message text,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: credit_summary_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.credit_summary_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    credit_summary_id uuid NOT NULL,
    application_id text NOT NULL,
    version integer NOT NULL,
    sections jsonb NOT NULL,
    inputs_snapshot jsonb,
    reason text NOT NULL,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: crm_call_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_call_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    direction text DEFAULT 'outbound'::text NOT NULL,
    from_number text,
    to_number text,
    twilio_call_sid text,
    duration_sec integer,
    recording_url text,
    notes text,
    owner_id uuid,
    contact_id uuid,
    company_id uuid,
    silo text DEFAULT 'BF'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: crm_company_web_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_company_web_profiles (
    domain text NOT NULL,
    summary text,
    fetched_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: crm_email_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_email_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    from_address text NOT NULL,
    to_addresses text[] DEFAULT '{}'::text[] NOT NULL,
    cc_addresses text[] DEFAULT '{}'::text[] NOT NULL,
    bcc_addresses text[] DEFAULT '{}'::text[] NOT NULL,
    subject text DEFAULT ''::text NOT NULL,
    body_html text,
    owner_id uuid,
    contact_id uuid,
    company_id uuid,
    graph_message_id text,
    silo text DEFAULT 'BF'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    opened_at timestamp with time zone,
    pixel_token text,
    followup_notified_at timestamp with time zone
);


--
-- Name: crm_lead_activities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_lead_activities (
    id uuid NOT NULL,
    lead_id uuid NOT NULL,
    activity_type text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: crm_leads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_leads (
    id uuid NOT NULL,
    company_name text,
    full_name text,
    phone text,
    email text NOT NULL,
    industry text,
    years_in_business text,
    monthly_revenue text,
    annual_revenue text,
    ar_outstanding text,
    existing_debt text,
    notes text,
    source text NOT NULL,
    tags jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    requested_amount text,
    credit_score_range text,
    product_interest text,
    industry_interest text,
    metadata jsonb
);


--
-- Name: crm_meetings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_meetings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text NOT NULL,
    attendee_description text,
    internal_note text,
    start_at timestamp with time zone NOT NULL,
    end_at timestamp with time zone NOT NULL,
    location text,
    attendees_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    reminder_minutes integer DEFAULT 60 NOT NULL,
    owner_id uuid,
    contact_id uuid,
    company_id uuid,
    graph_id text,
    silo text DEFAULT 'BF'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: crm_notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_notes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    body text NOT NULL,
    owner_id uuid,
    contact_id uuid,
    company_id uuid,
    silo text DEFAULT 'BF'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    application_id text,
    mentions text[] DEFAULT '{}'::text[] NOT NULL,
    is_deleted boolean DEFAULT false NOT NULL
);


--
-- Name: crm_segments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_segments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    silo text DEFAULT 'BF'::text NOT NULL,
    name text NOT NULL,
    filters jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: crm_task; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_task (
    id uuid NOT NULL,
    type character varying(64) NOT NULL,
    staff_id uuid,
    phone_number text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: crm_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_tasks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text NOT NULL,
    notes text,
    due_at timestamp with time zone,
    reminder_at timestamp with time zone,
    task_type text DEFAULT 'todo'::text NOT NULL,
    priority text DEFAULT 'none'::text NOT NULL,
    queue_name text,
    assigned_to uuid,
    owner_id uuid,
    contact_id uuid,
    company_id uuid,
    status text DEFAULT 'open'::text NOT NULL,
    graph_id text,
    silo text DEFAULT 'BF'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone
);


--
-- Name: crm_timeline_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_timeline_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    contact_id uuid NOT NULL,
    application_id text,
    event_type text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    actor_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: document_ocr_fields; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_ocr_fields (
    id text NOT NULL,
    document_id text NOT NULL,
    application_id text NOT NULL,
    field_key text NOT NULL,
    value text NOT NULL,
    confidence numeric NOT NULL,
    page integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: document_processing_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_processing_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    application_id text NOT NULL,
    document_id uuid NOT NULL,
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    job_type text DEFAULT 'ocr'::text NOT NULL,
    retry_count integer DEFAULT 0 NOT NULL,
    last_retry_at timestamp with time zone,
    max_retries integer DEFAULT 3 NOT NULL,
    started_at timestamp with time zone,
    error_message text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT document_processing_jobs_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'completed'::text, 'failed'::text])))
);


--
-- Name: document_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_types (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    key text NOT NULL,
    label text NOT NULL,
    category text DEFAULT 'core'::text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: document_version_reviews; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_version_reviews (
    id text NOT NULL,
    document_version_id text NOT NULL,
    status text NOT NULL,
    reviewed_by_user_id uuid,
    reviewed_at timestamp without time zone NOT NULL
);


--
-- Name: document_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_versions (
    id text NOT NULL,
    document_id text NOT NULL,
    version integer NOT NULL,
    metadata jsonb NOT NULL,
    content text NOT NULL,
    created_at timestamp without time zone NOT NULL,
    blob_name text,
    hash text
);


--
-- Name: documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.documents (
    id text NOT NULL,
    application_id text NOT NULL,
    owner_user_id uuid,
    title text,
    created_at timestamp without time zone NOT NULL,
    document_type text DEFAULT 'general'::text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    status text DEFAULT 'uploaded'::text NOT NULL,
    filename text,
    storage_key text,
    uploaded_by text DEFAULT 'client'::text NOT NULL,
    rejection_reason text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    borrower_id uuid,
    file_url text,
    object_key text,
    uploaded_at timestamp with time zone,
    signed_category text,
    ocr_status text,
    blob_name text,
    blob_url text,
    banking_status text,
    hash text,
    category text,
    storage_path text,
    size_bytes bigint,
    offer_id uuid,
    detected_type text,
    detected_confidence numeric,
    detected_at timestamp with time zone,
    category_before_retag text,
    display_name text,
    tamper_level text,
    tamper_signals jsonb,
    tamper_scanned_at timestamp with time zone,
    received_in_background boolean DEFAULT false NOT NULL
);


--
-- Name: email_link_clicks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_link_clicks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    contact_id text,
    template_id text,
    tse_id text,
    silo text DEFAULT 'BF'::text NOT NULL,
    url text NOT NULL,
    clicked_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: email_open_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_open_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email_log_id uuid NOT NULL,
    opened_at timestamp with time zone DEFAULT now() NOT NULL,
    user_agent text,
    ip text,
    source text DEFAULT 'unverified'::text NOT NULL
);


--
-- Name: export_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.export_audit (
    id text NOT NULL,
    actor_user_id uuid,
    export_type text NOT NULL,
    filters jsonb NOT NULL,
    created_at timestamp without time zone NOT NULL
);


--
-- Name: failed_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.failed_jobs (
    id integer NOT NULL,
    type text NOT NULL,
    data jsonb NOT NULL,
    error text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    retry_count integer DEFAULT 0
);


--
-- Name: failed_jobs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.failed_jobs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: failed_jobs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.failed_jobs_id_seq OWNED BY public.failed_jobs.id;


--
-- Name: financials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.financials (
    id uuid NOT NULL,
    borrower_id uuid NOT NULL,
    annual_revenue numeric(14,2),
    time_in_business_months integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: fx_rates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fx_rates (
    currency text NOT NULL,
    to_cad numeric(12,6) NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: google_ads_daily; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.google_ads_daily (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    stat_date date NOT NULL,
    level text NOT NULL,
    name text NOT NULL,
    status text,
    cost numeric(14,2) DEFAULT 0 NOT NULL,
    impressions bigint DEFAULT 0 NOT NULL,
    clicks bigint DEFAULT 0 NOT NULL,
    conversions numeric(14,2) DEFAULT 0 NOT NULL,
    conv_value numeric(14,2) DEFAULT 0 NOT NULL,
    synced_at timestamp with time zone DEFAULT now() NOT NULL,
    campaign_id text,
    campaign_name text
);


--
-- Name: graph_mail_subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.graph_mail_subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id text NOT NULL,
    subscription_id text NOT NULL,
    resource text NOT NULL,
    client_state text NOT NULL,
    expiration_datetime timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: idempotency_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.idempotency_keys (
    id text NOT NULL,
    key text NOT NULL,
    route text NOT NULL,
    request_hash text NOT NULL,
    response_code integer NOT NULL,
    response_body jsonb NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    method text DEFAULT 'POST'::text
);


--
-- Name: inbound_attachment_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inbound_attachment_attempts (
    silo text NOT NULL,
    message_id text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    last_outcome text,
    last_attempt_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: issue_reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.issue_reports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    screenshot_base64 text,
    user_agent text,
    status text DEFAULT 'open'::text NOT NULL,
    CONSTRAINT issue_reports_status_check CHECK ((status = ANY (ARRAY['open'::text, 'in_progress'::text, 'resolved'::text])))
);


--
-- Name: issues; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.issues (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text,
    description text,
    screenshot_url text,
    contact_id uuid,
    application_id text,
    status text DEFAULT 'open'::text NOT NULL,
    submitted_by text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    source text,
    kind text,
    conversation_id uuid,
    contact_email text,
    contact_phone text,
    page_url text,
    screenshot_blob_name text,
    silo text DEFAULT 'BF'::text NOT NULL,
    CONSTRAINT issues_status_check CHECK ((status = ANY (ARRAY['open'::text, 'in_progress'::text, 'resolved'::text])))
);


--
-- Name: job_queue; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.job_queue (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    type text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    error text,
    attempts integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 3 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT job_queue_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'completed'::text, 'failed'::text, 'dead'::text])))
);


--
-- Name: lender_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lender_documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    lender_id uuid NOT NULL,
    filename text NOT NULL,
    mime_type text NOT NULL,
    blob_url text NOT NULL,
    uploaded_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: lender_email_bounces; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lender_email_bounces (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    ndr_message_id text NOT NULL,
    application_id text,
    lender_id uuid,
    recipient text,
    reason text NOT NULL,
    detail text,
    received_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: lender_package_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lender_package_links (
    token text NOT NULL,
    application_id text NOT NULL,
    lender_id text NOT NULL,
    blob_name text NOT NULL,
    filename text NOT NULL,
    size_bytes bigint,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    download_count integer DEFAULT 0 NOT NULL,
    last_downloaded_at timestamp with time zone
);


--
-- Name: lender_product_requirements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lender_product_requirements (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    lender_product_id text NOT NULL,
    document_type text NOT NULL,
    required boolean DEFAULT true NOT NULL,
    min_amount integer,
    max_amount integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    stage smallint DEFAULT 1 NOT NULL,
    CONSTRAINT lender_product_requirements_stage_check CHECK ((stage = ANY (ARRAY[1, 2])))
);


--
-- Name: lender_products; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lender_products (
    id text NOT NULL,
    lender_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    required_documents jsonb,
    lender_name text,
    type text NOT NULL,
    min_amount integer,
    max_amount integer,
    status text DEFAULT 'active'::text NOT NULL,
    country text DEFAULT 'BOTH'::text NOT NULL,
    rate_type text,
    min_rate text,
    max_rate text,
    eligibility_notes text,
    signnow_template_id text,
    category text DEFAULT 'LOC'::text NOT NULL,
    interest_min text,
    interest_max text,
    term_min integer,
    term_max integer,
    term_unit text DEFAULT 'MONTHS'::text NOT NULL,
    silo text,
    amount_min bigint,
    amount_max bigint,
    commission numeric(6,3),
    min_credit_score integer,
    category_legacy text,
    rate_kind text,
    rate_period_days integer,
    category_label text,
    documents_required text,
    rate_min_num numeric(7,3),
    rate_max_num numeric(7,3),
    CONSTRAINT lender_products_category_check CHECK (((category IS NULL) OR (category = ANY (ARRAY['LOC'::text, 'TERM'::text, 'FACTORING'::text, 'PO'::text, 'EQUIPMENT'::text, 'MCA'::text, 'MEDIA'::text, 'ABL'::text, 'SBA'::text, 'STARTUP'::text])))),
    CONSTRAINT lender_products_country_check CHECK ((country = ANY (ARRAY['CA'::text, 'US'::text, 'BOTH'::text]))),
    CONSTRAINT lender_products_rate_kind_check CHECK (((rate_kind IS NULL) OR (rate_kind = ANY (ARRAY['apr'::text, 'monthly'::text, 'factor'::text])))),
    CONSTRAINT lender_products_rate_type_check CHECK (((rate_type IS NULL) OR (rate_type = ANY (ARRAY['VARIABLE'::text, 'FIXED'::text]))))
);


--
-- Name: lender_sheet_dispatches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lender_sheet_dispatches (
    application_id text NOT NULL,
    lender_id text NOT NULL,
    appended_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: lender_submission_retries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lender_submission_retries (
    id text NOT NULL,
    submission_id text NOT NULL,
    status text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp without time zone,
    last_error text,
    created_at timestamp without time zone NOT NULL,
    updated_at timestamp without time zone NOT NULL,
    canceled_at timestamp without time zone
);


--
-- Name: lender_submissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lender_submissions (
    id text NOT NULL,
    application_id text NOT NULL,
    status text NOT NULL,
    idempotency_key text,
    created_at timestamp without time zone NOT NULL,
    updated_at timestamp without time zone NOT NULL,
    lender_id text DEFAULT 'default'::text NOT NULL,
    submitted_at timestamp without time zone,
    payload jsonb,
    payload_hash text,
    lender_response jsonb,
    response_received_at timestamp without time zone,
    failure_reason text,
    submission_method text,
    external_reference text
);


--
-- Name: lenders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lenders (
    id uuid NOT NULL,
    name text NOT NULL,
    phone text,
    website text,
    description text,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    street text,
    city text,
    region text,
    country text NOT NULL,
    postal_code text,
    contact_name text,
    contact_email text,
    contact_phone text,
    submission_method text DEFAULT 'email'::text,
    submission_email text,
    email text,
    status public.lender_status DEFAULT 'ACTIVE'::public.lender_status NOT NULL,
    submission_config jsonb,
    google_sheet_id text,
    google_sheet_tab text,
    google_sheet_mapping jsonb,
    primary_contact_name text,
    primary_contact_email text,
    primary_contact_phone text,
    api_config jsonb,
    internal_notes text,
    webpage text,
    silo text,
    api_endpoint text,
    api_key_encrypted text,
    street_address text,
    city_state_zip text,
    main_phone text,
    application_url text,
    announcement text,
    has_broker_agreement boolean DEFAULT false NOT NULL,
    ives_participant_name text,
    ives_participant_id text,
    ives_sor_mailbox_id text,
    ives_street text,
    ives_city text,
    ives_state text,
    ives_zip text,
    CONSTRAINT lenders_country_check CHECK (((country IS NULL) OR (country = ANY (ARRAY['CA'::text, 'US'::text, 'BOTH'::text, 'Canada'::text, 'United States'::text, 'USA'::text, 'Both'::text])))),
    CONSTRAINT lenders_submission_method_check CHECK (((submission_method IS NULL) OR (submission_method = ANY (ARRAY['EMAIL'::text, 'API'::text, 'GOOGLE_SHEET'::text, 'GOOGLE_SHEETS'::text, 'email'::text, 'api'::text, 'google_sheet'::text, 'google_sheets'::text]))))
);


--
-- Name: link_previews; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.link_previews (
    url text NOT NULL,
    ok boolean DEFAULT false NOT NULL,
    title text,
    description text,
    image_url text,
    site_name text,
    fetched_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: live_chat_queue; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.live_chat_queue (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    status text DEFAULT 'waiting'::text NOT NULL,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: live_chat_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.live_chat_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text,
    email text,
    message text,
    status text DEFAULT 'open'::text,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: mail_poll_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mail_poll_state (
    mailbox text NOT NULL,
    last_polled_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: marketing_email_template; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.marketing_email_template (
    silo text NOT NULL,
    headline text DEFAULT ''::text NOT NULL,
    hero_url text DEFAULT ''::text NOT NULL,
    hero_link text DEFAULT ''::text NOT NULL,
    body text DEFAULT ''::text NOT NULL,
    cta_label text DEFAULT ''::text NOT NULL,
    cta_url text DEFAULT ''::text NOT NULL,
    image2_url text DEFAULT ''::text NOT NULL,
    image2_link text DEFAULT ''::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    headline2 text DEFAULT ''::text NOT NULL,
    body2 text DEFAULT ''::text NOT NULL,
    right_image_url text DEFAULT ''::text NOT NULL,
    right_image_link text DEFAULT ''::text NOT NULL,
    cta2_label text DEFAULT ''::text NOT NULL,
    cta2_url text DEFAULT ''::text NOT NULL
);


--
-- Name: marketing_landing_pages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.marketing_landing_pages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL,
    silo text DEFAULT 'BF'::text NOT NULL,
    title text,
    html text NOT NULL,
    fields jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: marketing_send_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.marketing_send_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    channel text NOT NULL,
    silo text NOT NULL,
    tag text,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    total integer DEFAULT 0 NOT NULL,
    sent integer DEFAULT 0 NOT NULL,
    failed integer DEFAULT 0 NOT NULL,
    created_by text,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    not_before timestamp with time zone,
    cancel_requested boolean DEFAULT false NOT NULL
);


--
-- Name: marketing_sequence_enrollments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.marketing_sequence_enrollments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    sequence_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    silo text DEFAULT 'BF'::text NOT NULL,
    current_step integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    next_run_at timestamp with time zone DEFAULT now() NOT NULL,
    enrolled_at timestamp with time zone DEFAULT now() NOT NULL,
    last_step_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: marketing_sequence_steps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.marketing_sequence_steps (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    sequence_id uuid NOT NULL,
    step_order integer NOT NULL,
    channel text NOT NULL,
    wait_minutes integer DEFAULT 0 NOT NULL,
    condition text DEFAULT 'always'::text NOT NULL,
    subject text,
    body text,
    html text,
    link_url text,
    template_id uuid,
    task_type text,
    task_priority text,
    task_queue_id uuid,
    task_pause boolean DEFAULT true NOT NULL,
    sms_template_id uuid,
    email_template_id uuid,
    assignee_user_id uuid
);


--
-- Name: marketing_sequences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.marketing_sequences (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    silo text DEFAULT 'BF'::text NOT NULL,
    name text NOT NULL,
    audience_tag text,
    status text DEFAULT 'draft'::text NOT NULL,
    stop_on_reply boolean DEFAULT true NOT NULL,
    quiet_start integer DEFAULT 9 NOT NULL,
    quiet_end integer DEFAULT 21 NOT NULL,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    audience_include_tags text[],
    audience_exclude_tags text[]
);


--
-- Name: marketing_template; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.marketing_template (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    silo text DEFAULT 'BF'::text NOT NULL,
    channel text NOT NULL,
    name text NOT NULL,
    body text,
    link_url text,
    subject text,
    html text,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    fields jsonb
);


--
-- Name: maya_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.maya_audit (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    ts timestamp with time zone DEFAULT now() NOT NULL,
    audience text NOT NULL,
    user_id uuid,
    session_id text,
    tool text NOT NULL,
    args_redacted jsonb,
    result_summary text,
    ok boolean DEFAULT true NOT NULL,
    error_code text,
    CONSTRAINT maya_audit_audience_check CHECK ((audience = ANY (ARRAY['visitor'::text, 'client'::text, 'staff'::text])))
);


--
-- Name: maya_escalations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.maya_escalations (
    id uuid NOT NULL,
    session_id text,
    application_id text,
    reason text NOT NULL,
    surface text,
    silo text,
    payload jsonb DEFAULT '{}'::jsonb,
    notified_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: message_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.message_templates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    channel text NOT NULL,
    name text NOT NULL,
    subject text,
    body_html text,
    body_text text,
    shared boolean DEFAULT true NOT NULL,
    owner_user_id uuid,
    silo text DEFAULT 'BF'::text NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    is_snippet boolean DEFAULT false NOT NULL,
    shortcut text,
    CONSTRAINT message_templates_channel_check CHECK ((channel = ANY (ARRAY['email'::text, 'message'::text, 'sms'::text, 'team'::text])))
);


--
-- Name: messages_typing; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.messages_typing (
    contact_id uuid NOT NULL,
    side text NOT NULL,
    actor_label text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT messages_typing_side_check CHECK ((side = ANY (ARRAY['staff'::text, 'client'::text])))
);


--
-- Name: naics_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.naics_codes (
    code text NOT NULL,
    country text NOT NULL,
    title text NOT NULL,
    description text,
    cached_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    application_id text,
    type text NOT NULL,
    title text DEFAULT 'Notification'::text NOT NULL,
    body text NOT NULL,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    read_at timestamp with time zone,
    ref_table text,
    ref_id text,
    context_url text,
    is_read boolean DEFAULT false NOT NULL
);


--
-- Name: ocr_document_results; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ocr_document_results (
    id text NOT NULL,
    document_id text NOT NULL,
    provider text NOT NULL,
    model text NOT NULL,
    extracted_text text NOT NULL,
    extracted_json jsonb,
    meta jsonb,
    created_at timestamp without time zone NOT NULL,
    updated_at timestamp without time zone NOT NULL
);


--
-- Name: ocr_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ocr_jobs (
    id text NOT NULL,
    document_id text NOT NULL,
    application_id text NOT NULL,
    status text NOT NULL,
    attempt_count integer NOT NULL,
    max_attempts integer NOT NULL,
    next_attempt_at timestamp without time zone,
    locked_at timestamp without time zone,
    locked_by text,
    last_error text,
    created_at timestamp without time zone NOT NULL,
    updated_at timestamp without time zone NOT NULL,
    CONSTRAINT ocr_jobs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'processing'::text, 'succeeded'::text, 'failed'::text, 'canceled'::text])))
);


--
-- Name: ocr_results; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ocr_results (
    id text NOT NULL,
    application_id text NOT NULL,
    document_id text NOT NULL,
    field_key text NOT NULL,
    value text NOT NULL,
    confidence numeric NOT NULL,
    source_document_type text,
    created_at timestamp without time zone NOT NULL,
    status text
);


--
-- Name: offers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.offers (
    id uuid NOT NULL,
    application_id text NOT NULL,
    lender_submission_id text,
    lender_name text NOT NULL,
    amount numeric(14,2),
    rate_factor text,
    term text,
    payment_frequency text,
    expiry_date date,
    document_url text,
    recommended boolean DEFAULT false NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    term_sheet_blob_name text,
    term_sheet_filename text,
    term_sheet_size_bytes bigint,
    term_sheet_uploaded_at timestamp with time zone,
    is_archived boolean DEFAULT false NOT NULL,
    archived_at timestamp with time zone,
    lender_id uuid,
    pending_at timestamp with time zone,
    CONSTRAINT offers_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'rejected'::text, 'changes_requested'::text, 'pending_acceptance'::text])))
);


--
-- Name: ops_kill_switches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ops_kill_switches (
    key text NOT NULL,
    enabled boolean NOT NULL,
    updated_at timestamp without time zone NOT NULL
);


--
-- Name: ops_replay_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ops_replay_events (
    id text NOT NULL,
    replay_job_id text,
    source_table text NOT NULL,
    source_id text NOT NULL,
    processed_at timestamp without time zone
);


--
-- Name: ops_replay_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ops_replay_jobs (
    id text NOT NULL,
    scope text NOT NULL,
    started_at timestamp without time zone,
    completed_at timestamp without time zone,
    status text NOT NULL
);


--
-- Name: otp_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.otp_codes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    phone text NOT NULL,
    code text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    attempts integer DEFAULT 0,
    consumed boolean DEFAULT false
);


--
-- Name: otp_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.otp_sessions (
    id uuid NOT NULL,
    phone text NOT NULL,
    code text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    expires_at timestamp with time zone NOT NULL
);


--
-- Name: otp_verifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.otp_verifications (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    phone text NOT NULL,
    verification_sid text,
    status text NOT NULL,
    verified_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT otp_verifications_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'expired'::text])))
);


--
-- Name: owners; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.owners (
    id uuid NOT NULL,
    borrower_id uuid NOT NULL,
    name text NOT NULL,
    ownership_percentage numeric(6,2),
    email text,
    phone text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: password_resets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.password_resets (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: portal_errors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.portal_errors (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    fingerprint text NOT NULL,
    source text NOT NULL,
    message text NOT NULL,
    stack text,
    url text,
    user_agent text,
    user_id text,
    silo text DEFAULT 'BF'::text NOT NULL,
    context jsonb,
    occurrences integer DEFAULT 1 NOT NULL,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: pre_applications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pre_applications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: processing_job_history_view; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.processing_job_history_view AS
 SELECT document_processing_jobs.id AS job_id,
    'ocr'::text AS job_type,
    document_processing_jobs.application_id,
    (document_processing_jobs.document_id)::text AS document_id,
    NULL::text AS previous_status,
    document_processing_jobs.status AS next_status,
    document_processing_jobs.error_message,
    document_processing_jobs.retry_count,
    document_processing_jobs.last_retry_at,
    COALESCE(document_processing_jobs.updated_at, document_processing_jobs.created_at) AS occurred_at
   FROM public.document_processing_jobs
UNION ALL
 SELECT banking_analysis_jobs.id AS job_id,
    'banking'::text AS job_type,
    banking_analysis_jobs.application_id,
    NULL::text AS document_id,
    NULL::text AS previous_status,
    banking_analysis_jobs.status AS next_status,
    banking_analysis_jobs.error_message,
    banking_analysis_jobs.retry_count,
    banking_analysis_jobs.last_retry_at,
    COALESCE(banking_analysis_jobs.updated_at, banking_analysis_jobs.created_at) AS occurred_at
   FROM public.banking_analysis_jobs
UNION ALL
 SELECT credit_summary_jobs.id AS job_id,
    'credit_summary'::text AS job_type,
    credit_summary_jobs.application_id,
    NULL::text AS document_id,
    NULL::text AS previous_status,
    credit_summary_jobs.status AS next_status,
    credit_summary_jobs.error_message,
    credit_summary_jobs.retry_count,
    credit_summary_jobs.last_retry_at,
    COALESCE(credit_summary_jobs.updated_at, credit_summary_jobs.created_at) AS occurred_at
   FROM public.credit_summary_jobs;


--
-- Name: processing_job_history; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.processing_job_history AS
 SELECT job_id,
    job_type,
    application_id,
    document_id,
    previous_status,
    next_status,
    error_message,
    retry_count,
    last_retry_at,
    occurred_at
   FROM public.processing_job_history_view;


--
-- Name: pwa_notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pwa_notifications (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    level text NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    delivered_at timestamp with time zone NOT NULL,
    acknowledged_at timestamp with time zone,
    payload_hash text NOT NULL
);


--
-- Name: pwa_subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pwa_subscriptions (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    endpoint text NOT NULL,
    p256dh text NOT NULL,
    auth text NOT NULL,
    device_type text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: qa_questions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.qa_questions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    set_id uuid NOT NULL,
    "position" integer DEFAULT 1 NOT NULL,
    prompt text DEFAULT ''::text NOT NULL,
    request_document boolean DEFAULT false NOT NULL,
    answer_text text,
    answer_document_id text,
    review_status text DEFAULT 'draft'::text NOT NULL,
    reject_reason text,
    answered_at timestamp with time zone,
    reviewed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: qa_sets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.qa_sets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    application_id text NOT NULL,
    silo text DEFAULT 'BF'::text NOT NULL,
    round integer DEFAULT 1 NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    finalized_at timestamp with time zone
);


--
-- Name: readiness_application_mappings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.readiness_application_mappings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    readiness_session_id uuid NOT NULL,
    application_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: readiness_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.readiness_sessions (
    id uuid NOT NULL,
    token text NOT NULL,
    email text NOT NULL,
    phone text,
    company_name text NOT NULL,
    full_name text NOT NULL,
    industry text,
    years_in_business integer,
    monthly_revenue numeric,
    annual_revenue numeric,
    ar_outstanding numeric,
    existing_debt boolean,
    crm_lead_id uuid,
    converted_application_id text,
    is_active boolean DEFAULT true NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    business_location text,
    funding_type text,
    requested_amount numeric,
    purpose_of_funds text,
    sales_history_years text,
    annual_revenue_range text,
    avg_monthly_revenue_range text,
    accounts_receivable_range text,
    fixed_assets_value_range text,
    readiness_score integer,
    readiness_tier text,
    readiness_over_ask boolean
);


--
-- Name: referral_conversions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.referral_conversions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    application_id uuid,
    contact_id uuid,
    referrer_id uuid NOT NULL,
    ref_code text,
    source_silo text DEFAULT 'BF'::text NOT NULL,
    external_application_id text,
    conversion_rate numeric DEFAULT 20 NOT NULL,
    deal_amount numeric,
    credit_amount numeric,
    status text DEFAULT 'credited'::text NOT NULL,
    credited_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    paid_at timestamp with time zone
);


--
-- Name: refresh_tokens; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.refresh_tokens AS
 SELECT id,
    user_id,
    token_hash,
    expires_at,
    revoked_at
   FROM public.auth_refresh_tokens;


--
-- Name: rejection_reasons; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rejection_reasons (
    code text NOT NULL,
    label text NOT NULL,
    why_it_matters text DEFAULT ''::text NOT NULL,
    what_helps text,
    sort_order integer DEFAULT 100 NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: reporting_application_volume_daily; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reporting_application_volume_daily (
    id text NOT NULL,
    metric_date date NOT NULL,
    product_type text NOT NULL,
    applications_created integer NOT NULL,
    applications_submitted integer NOT NULL,
    applications_approved integer NOT NULL,
    applications_declined integer NOT NULL,
    applications_funded integer NOT NULL,
    created_at timestamp without time zone NOT NULL
);


--
-- Name: reporting_daily_metrics; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reporting_daily_metrics (
    id text NOT NULL,
    metric_date date NOT NULL,
    applications_created integer NOT NULL,
    applications_submitted integer NOT NULL,
    applications_approved integer NOT NULL,
    applications_declined integer NOT NULL,
    applications_funded integer NOT NULL,
    documents_uploaded integer NOT NULL,
    documents_approved integer NOT NULL,
    lender_submissions integer NOT NULL,
    created_at timestamp without time zone NOT NULL
);


--
-- Name: reporting_document_metrics_daily; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reporting_document_metrics_daily (
    id text NOT NULL,
    metric_date date NOT NULL,
    document_type text NOT NULL,
    documents_uploaded integer NOT NULL,
    documents_reviewed integer NOT NULL,
    documents_approved integer NOT NULL,
    created_at timestamp without time zone NOT NULL
);


--
-- Name: reporting_lender_funnel_daily; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reporting_lender_funnel_daily (
    id text NOT NULL,
    metric_date date NOT NULL,
    lender_id text NOT NULL,
    submissions integer NOT NULL,
    approvals integer NOT NULL,
    funded integer NOT NULL,
    created_at timestamp without time zone NOT NULL
);


--
-- Name: reporting_lender_performance; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reporting_lender_performance (
    id text NOT NULL,
    lender_id text NOT NULL,
    period_start date NOT NULL,
    period_end date NOT NULL,
    submissions integer NOT NULL,
    approvals integer NOT NULL,
    declines integer NOT NULL,
    funded integer NOT NULL,
    avg_decision_time_seconds integer NOT NULL,
    created_at timestamp without time zone NOT NULL
);


--
-- Name: reporting_pipeline_daily_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reporting_pipeline_daily_snapshots (
    id text NOT NULL,
    snapshot_date date NOT NULL,
    pipeline_state text NOT NULL,
    application_count integer NOT NULL,
    created_at timestamp without time zone NOT NULL
);


--
-- Name: reporting_pipeline_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reporting_pipeline_snapshots (
    id text NOT NULL,
    snapshot_at timestamp without time zone NOT NULL,
    pipeline_state text NOT NULL,
    application_count integer NOT NULL
);


--
-- Name: reporting_staff_activity_daily; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reporting_staff_activity_daily (
    id text NOT NULL,
    metric_date date NOT NULL,
    staff_user_id uuid NOT NULL,
    action text NOT NULL,
    activity_count integer NOT NULL,
    created_at timestamp without time zone NOT NULL
);


--
-- Name: scheduled_emails; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scheduled_emails (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    draft_id text NOT NULL,
    silo text DEFAULT 'BF'::text NOT NULL,
    subject text,
    to_preview text,
    send_at timestamp with time zone NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    sent_at timestamp with time zone
);


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    id text NOT NULL,
    applied_at timestamp without time zone
);


--
-- Name: sequence_sends; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sequence_sends (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    sequence_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    silo text DEFAULT 'BF'::text NOT NULL,
    channel text DEFAULT 'sms'::text NOT NULL,
    message_sid text,
    delivery_status text,
    sent_at timestamp with time zone DEFAULT now() NOT NULL,
    clicked_at timestamp with time zone,
    opened_at timestamp with time zone
);


--
-- Name: settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.settings (
    key text NOT NULL,
    value text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: shared_mailbox_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shared_mailbox_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    address text NOT NULL,
    display_name text,
    allowed_roles text[] DEFAULT '{Admin,Staff,Marketing}'::text[] NOT NULL,
    silo text DEFAULT 'BF'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    signature_html text
);


--
-- Name: sms_campaign_sends; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sms_campaign_sends (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    campaign_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    silo text DEFAULT 'BF'::text NOT NULL,
    phone text,
    sent_at timestamp with time zone DEFAULT now() NOT NULL,
    message_sid text,
    delivery_status text,
    clicked_at timestamp with time zone,
    fallback_sent boolean DEFAULT false NOT NULL,
    fallback_at timestamp with time zone
);


--
-- Name: sms_campaigns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sms_campaigns (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    silo text DEFAULT 'BF'::text NOT NULL,
    tag text,
    sms_body text NOT NULL,
    link_url text,
    fallback_subject text,
    fallback_html text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: sms_deliveries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sms_deliveries (
    message_sid text NOT NULL,
    to_number text,
    kind text DEFAULT 'sms'::text NOT NULL,
    application_id text,
    status text,
    error_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: staff_device_credentials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_device_credentials (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    secret_hash text NOT NULL,
    token_version integer DEFAULT 0 NOT NULL,
    device_label text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone,
    expires_at timestamp with time zone DEFAULT (now() + '90 days'::interval) NOT NULL,
    revoked_at timestamp with time zone
);


--
-- Name: staff_presence; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_presence (
    user_id uuid NOT NULL,
    status text DEFAULT 'offline'::text NOT NULL,
    twilio_identity text,
    last_heartbeat timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    manual_busy boolean DEFAULT false NOT NULL,
    on_call boolean DEFAULT false NOT NULL,
    in_meeting boolean DEFAULT false NOT NULL,
    CONSTRAINT staff_presence_status_check CHECK ((status = ANY (ARRAY['available'::text, 'busy'::text, 'offline'::text])))
);


--
-- Name: submission_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.submission_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    lender_id text,
    event_type text,
    payload jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: submit_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.submit_attempts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    application_token text,
    phone text,
    email text,
    business_name text,
    status text DEFAULT 'attempted'::text NOT NULL,
    error text,
    user_agent text,
    silo text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: task_digest_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_digest_log (
    user_id uuid NOT NULL,
    digest_date date NOT NULL,
    notified_at timestamp with time zone
);


--
-- Name: task_queue_shares; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_queue_shares (
    queue_id uuid NOT NULL,
    user_id uuid NOT NULL,
    silo text NOT NULL,
    CONSTRAINT task_queue_shares_silo_check CHECK ((silo = ANY (ARRAY['BF'::text, 'BI'::text, 'SLF'::text])))
);


--
-- Name: task_queues; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_queues (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    silo text NOT NULL,
    name text NOT NULL,
    access_type text DEFAULT 'PRIVATE'::text NOT NULL,
    owner_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT task_queues_access_type_check CHECK ((access_type = ANY (ARRAY['PRIVATE'::text, 'SHARED'::text]))),
    CONSTRAINT task_queues_silo_check CHECK ((silo = ANY (ARRAY['BF'::text, 'BI'::text, 'SLF'::text])))
);


--
-- Name: tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tasks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    silo text NOT NULL,
    title text NOT NULL,
    body text,
    type text DEFAULT 'TODO'::text NOT NULL,
    status text DEFAULT 'NOT_STARTED'::text NOT NULL,
    priority text DEFAULT 'NONE'::text NOT NULL,
    due_at timestamp with time zone,
    reminder_at timestamp with time zone,
    queue_id uuid,
    assignee_user_id uuid NOT NULL,
    contact_id uuid,
    company_id uuid,
    created_by uuid,
    completed_at timestamp with time zone,
    repeat_interval integer,
    repeat_unit text,
    repeat_parent_id uuid,
    repeat_active boolean DEFAULT false NOT NULL,
    source text DEFAULT 'MANUAL'::text NOT NULL,
    source_ref_id uuid,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    reminder_sent_at timestamp with time zone,
    graph_id text,
    CONSTRAINT tasks_priority_check CHECK ((priority = ANY (ARRAY['NONE'::text, 'LOW'::text, 'MEDIUM'::text, 'HIGH'::text]))),
    CONSTRAINT tasks_repeat_unit_check CHECK (((repeat_unit IS NULL) OR (repeat_unit = ANY (ARRAY['DAY'::text, 'WEEK'::text, 'MONTH'::text, 'YEAR'::text])))),
    CONSTRAINT tasks_silo_check CHECK ((silo = ANY (ARRAY['BF'::text, 'BI'::text, 'SLF'::text]))),
    CONSTRAINT tasks_source_check CHECK ((source = ANY (ARRAY['MANUAL'::text, 'SEQUENCE'::text, 'WORKFLOW'::text, 'IMPORT'::text, 'API'::text, 'CALL_DISPOSITION'::text]))),
    CONSTRAINT tasks_status_check CHECK ((status = ANY (ARRAY['NOT_STARTED'::text, 'IN_PROGRESS'::text, 'WAITING'::text, 'COMPLETED'::text, 'DEFERRED'::text]))),
    CONSTRAINT tasks_type_check CHECK ((type = ANY (ARRAY['CALL'::text, 'EMAIL'::text, 'SMS'::text, 'TODO'::text])))
);


--
-- Name: team_channel_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_channel_members (
    channel_id uuid NOT NULL,
    user_id uuid NOT NULL,
    last_read_at timestamp with time zone,
    joined_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: team_channels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_channels (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    kind text DEFAULT 'channel'::text NOT NULL,
    name text,
    dm_key text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT team_channels_kind_chk CHECK ((kind = ANY (ARRAY['channel'::text, 'dm'::text, 'group'::text])))
);


--
-- Name: team_message_reactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_message_reactions (
    message_id uuid NOT NULL,
    user_id uuid NOT NULL,
    emoji text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: team_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    channel_id uuid NOT NULL,
    sender_id uuid,
    body text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    attachments jsonb,
    edited_at timestamp with time zone,
    deleted_at timestamp with time zone,
    reply_to_id uuid,
    mentions uuid[],
    pinned_at timestamp with time zone
);


--
-- Name: teams_meetings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.teams_meetings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    silo text DEFAULT 'BF'::text NOT NULL,
    contact_id uuid,
    lender_id uuid,
    organizer_user_id uuid,
    organizer_upn text,
    subject text,
    graph_event_id text,
    graph_meeting_id text,
    join_url text,
    scheduled_at timestamp with time zone,
    scheduled_end_at timestamp with time zone,
    started_at timestamp with time zone,
    ended_at timestamp with time zone,
    recording_url text,
    transcript_text text,
    transcript_fetched_at timestamp with time zone,
    maya_summary text,
    maya_tasks jsonb DEFAULT '[]'::jsonb NOT NULL,
    maya_profile_updates jsonb DEFAULT '[]'::jsonb NOT NULL,
    status text DEFAULT 'scheduled'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    company_id uuid,
    crm_meeting_id uuid,
    transcript_attempts integer DEFAULT 0 NOT NULL,
    organizer_aad_id text
);


--
-- Name: template_send_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.template_send_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    template_id text NOT NULL,
    contact_id text,
    channel text NOT NULL,
    silo text DEFAULT 'BF'::text NOT NULL,
    subject text,
    sent_at timestamp with time zone DEFAULT now() NOT NULL,
    opened_at timestamp with time zone,
    clicked_at timestamp with time zone
);


--
-- Name: user_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_settings (
    user_id uuid NOT NULL,
    email_signature_html text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    booking_url text
);


--
-- Name: visitor_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.visitor_events (
    id bigint NOT NULL,
    session_id text NOT NULL,
    event_type text NOT NULL,
    path text,
    title text,
    step text,
    dwell_ms integer,
    meta jsonb,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: visitor_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.visitor_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: visitor_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.visitor_events_id_seq OWNED BY public.visitor_events.id;


--
-- Name: visitor_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.visitor_sessions (
    session_id text NOT NULL,
    contact_id text,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    landing_page text,
    referrer text,
    gclid text,
    gbraid text,
    wbraid text,
    utm_source text,
    utm_medium text,
    utm_campaign text,
    utm_term text,
    utm_content text,
    user_agent text,
    stitched_at timestamp with time zone
);


--
-- Name: voicemails; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.voicemails (
    id uuid NOT NULL,
    client_id uuid,
    call_sid text NOT NULL,
    recording_sid text NOT NULL,
    recording_url text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    contact_id uuid,
    application_id text,
    transcription text,
    duration integer,
    from_number text,
    blob_url text,
    transcript text,
    duration_seconds integer,
    silo text,
    conversation_id uuid,
    message_id uuid,
    staff_user_id uuid
);


--
-- Name: vw_application_conversion_funnel; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.vw_application_conversion_funnel AS
 SELECT (count(*))::integer AS applications_created,
    (count(*) FILTER (WHERE (pipeline_state = 'OFF_TO_LENDER'::text)))::integer AS applications_submitted,
    (count(*) FILTER (WHERE (pipeline_state = 'ACCEPTED'::text)))::integer AS applications_approved,
    (count(*) FILTER (WHERE (pipeline_state = 'ACCEPTED'::text)))::integer AS applications_funded
   FROM public.applications;


--
-- Name: vw_document_processing_stats; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.vw_document_processing_stats AS
 SELECT (count(dv.id))::integer AS documents_uploaded,
    (count(r.id))::integer AS documents_reviewed,
    (count(*) FILTER (WHERE (r.status = 'accepted'::text)))::integer AS documents_approved,
        CASE
            WHEN (count(r.id) = 0) THEN (0)::numeric
            ELSE ((count(*) FILTER (WHERE (r.status = 'accepted'::text)))::numeric / (count(r.id))::numeric)
        END AS approval_rate
   FROM (public.document_versions dv
     LEFT JOIN public.document_version_reviews r ON ((r.document_version_id = dv.id)));


--
-- Name: vw_lender_conversion; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.vw_lender_conversion AS
 SELECT ls.lender_id,
    (count(*))::integer AS submissions,
    (count(*) FILTER (WHERE (a.pipeline_state = 'ACCEPTED'::text)))::integer AS approvals,
    (count(*) FILTER (WHERE (a.pipeline_state = 'DECLINED'::text)))::integer AS declines,
    (count(*) FILTER (WHERE (a.pipeline_state = 'ACCEPTED'::text)))::integer AS funded,
        CASE
            WHEN (count(*) = 0) THEN (0)::numeric
            ELSE ((count(*) FILTER (WHERE (a.pipeline_state = 'ACCEPTED'::text)))::numeric / (count(*))::numeric)
        END AS approval_rate,
        CASE
            WHEN (count(*) = 0) THEN (0)::numeric
            ELSE ((count(*) FILTER (WHERE (a.pipeline_state = 'ACCEPTED'::text)))::numeric / (count(*))::numeric)
        END AS funding_rate
   FROM (public.lender_submissions ls
     JOIN public.applications a ON ((a.id = ls.application_id)))
  GROUP BY ls.lender_id;


--
-- Name: vw_pipeline_current_state; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.vw_pipeline_current_state AS
 SELECT pipeline_state,
    (count(*))::integer AS application_count
   FROM public.applications
  GROUP BY pipeline_state;


--
-- Name: watch_call_bridges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.watch_call_bridges (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    staff_user_id uuid NOT NULL,
    device_id uuid NOT NULL,
    destination text NOT NULL,
    callback_number text NOT NULL,
    line text NOT NULL,
    contact_id uuid,
    status text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    provider_call_sid text,
    error_code text,
    idempotency_key text NOT NULL,
    request_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone,
    CONSTRAINT watch_call_bridges_line_check CHECK ((line = ANY (ARRAY['BF'::text, 'BI'::text, 'SLF'::text]))),
    CONSTRAINT watch_call_bridges_status_check CHECK ((status = ANY (ARRAY['requesting'::text, 'waitingForCallback'::text, 'bridging'::text, 'ringing'::text, 'connected'::text, 'ended'::text, 'failed'::text])))
);


--
-- Name: watch_devices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.watch_devices (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    staff_user_id uuid NOT NULL,
    platform text DEFAULT 'watchos'::text NOT NULL,
    application text DEFAULT 'boreal-dialer'::text NOT NULL,
    name text,
    app_version text,
    standalone_routing_enabled boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    CONSTRAINT watch_devices_platform_check CHECK ((platform = 'watchos'::text))
);


--
-- Name: watch_link_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.watch_link_codes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    staff_user_id uuid NOT NULL,
    code_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: watch_push_registrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.watch_push_registrations (
    device_id uuid NOT NULL,
    token_hash text NOT NULL,
    token_ciphertext text NOT NULL,
    push_type text NOT NULL,
    environment text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT watch_push_registrations_environment_check CHECK ((environment = ANY (ARRAY['sandbox'::text, 'production'::text]))),
    CONSTRAINT watch_push_registrations_push_type_check CHECK ((push_type = 'standard'::text))
);


--
-- Name: watch_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.watch_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    device_id uuid NOT NULL,
    refresh_token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    refresh_expires_at timestamp with time zone NOT NULL,
    rotated_at timestamp with time zone,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: webauthn_challenges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.webauthn_challenges (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    challenge text NOT NULL,
    user_id uuid,
    kind text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '00:05:00'::interval) NOT NULL,
    CONSTRAINT webauthn_challenges_kind_check CHECK ((kind = ANY (ARRAY['register'::text, 'login'::text])))
);


--
-- Name: webauthn_credentials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.webauthn_credentials (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    credential_id text NOT NULL,
    public_key text NOT NULL,
    counter bigint DEFAULT 0 NOT NULL,
    transports text[],
    device_label text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone
);


--
-- Name: wizard_block_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wizard_block_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    reason text NOT NULL,
    step integer DEFAULT 1 NOT NULL,
    country text,
    monthly_revenue text,
    application_id text,
    contact_id text,
    lead_id text,
    phone text,
    session_key text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: application_collateral id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.application_collateral ALTER COLUMN id SET DEFAULT nextval('public.application_collateral_id_seq'::regclass);


--
-- Name: application_financials id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.application_financials ALTER COLUMN id SET DEFAULT nextval('public.application_financials_id_seq'::regclass);


--
-- Name: application_research_facts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.application_research_facts ALTER COLUMN id SET DEFAULT nextval('public.application_research_facts_id_seq'::regclass);


--
-- Name: failed_jobs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.failed_jobs ALTER COLUMN id SET DEFAULT nextval('public.failed_jobs_id_seq'::regclass);


--
-- Name: visitor_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.visitor_events ALTER COLUMN id SET DEFAULT nextval('public.visitor_events_id_seq'::regclass);


--
-- Name: accountant_invites accountant_invites_application_id_contact_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accountant_invites
    ADD CONSTRAINT accountant_invites_application_id_contact_id_key UNIQUE (application_id, contact_id);


--
-- Name: accountant_invites accountant_invites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accountant_invites
    ADD CONSTRAINT accountant_invites_pkey PRIMARY KEY (id);


--
-- Name: ads_negatives_log ads_negatives_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ads_negatives_log
    ADD CONSTRAINT ads_negatives_log_pkey PRIMARY KEY (id);


--
-- Name: ai_admin_rules ai_admin_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_admin_rules
    ADD CONSTRAINT ai_admin_rules_pkey PRIMARY KEY (id);


--
-- Name: ai_embeddings ai_embeddings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_embeddings
    ADD CONSTRAINT ai_embeddings_pkey PRIMARY KEY (id);


--
-- Name: ai_escalations ai_escalations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_escalations
    ADD CONSTRAINT ai_escalations_pkey PRIMARY KEY (id);


--
-- Name: ai_issues ai_issues_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_issues
    ADD CONSTRAINT ai_issues_pkey PRIMARY KEY (id);


--
-- Name: ai_knowledge_chunks ai_knowledge_chunks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_knowledge_chunks
    ADD CONSTRAINT ai_knowledge_chunks_pkey PRIMARY KEY (id);


--
-- Name: ai_knowledge_documents ai_knowledge_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_knowledge_documents
    ADD CONSTRAINT ai_knowledge_documents_pkey PRIMARY KEY (id);


--
-- Name: ai_knowledge ai_knowledge_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_knowledge
    ADD CONSTRAINT ai_knowledge_pkey PRIMARY KEY (id);


--
-- Name: ai_messages ai_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_messages
    ADD CONSTRAINT ai_messages_pkey PRIMARY KEY (id);


--
-- Name: ai_policy_rules ai_policy_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_policy_rules
    ADD CONSTRAINT ai_policy_rules_pkey PRIMARY KEY (id);


--
-- Name: ai_policy_rules ai_policy_rules_rule_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_policy_rules
    ADD CONSTRAINT ai_policy_rules_rule_key_key UNIQUE (rule_key);


--
-- Name: ai_prequal_sessions ai_prequal_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_prequal_sessions
    ADD CONSTRAINT ai_prequal_sessions_pkey PRIMARY KEY (id);


--
-- Name: ai_rules ai_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_rules
    ADD CONSTRAINT ai_rules_pkey PRIMARY KEY (id);


--
-- Name: ai_sessions ai_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_sessions
    ADD CONSTRAINT ai_sessions_pkey PRIMARY KEY (id);


--
-- Name: ai_system_rules ai_system_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_system_rules
    ADD CONSTRAINT ai_system_rules_pkey PRIMARY KEY (id);


--
-- Name: ai_system_rules ai_system_rules_rule_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_system_rules
    ADD CONSTRAINT ai_system_rules_rule_key_key UNIQUE (rule_key);


--
-- Name: ai_voice_state ai_voice_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_voice_state
    ADD CONSTRAINT ai_voice_state_pkey PRIMARY KEY (session_id);


--
-- Name: analytics_events analytics_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_events
    ADD CONSTRAINT analytics_events_pkey PRIMARY KEY (id);


--
-- Name: application_collateral application_collateral_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.application_collateral
    ADD CONSTRAINT application_collateral_pkey PRIMARY KEY (id);


--
-- Name: application_contacts application_contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.application_contacts
    ADD CONSTRAINT application_contacts_pkey PRIMARY KEY (application_id, contact_id, role);


--
-- Name: application_continuations application_continuations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.application_continuations
    ADD CONSTRAINT application_continuations_pkey PRIMARY KEY (id);


--
-- Name: application_continuations application_continuations_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.application_continuations
    ADD CONSTRAINT application_continuations_token_key UNIQUE (token);


--
-- Name: application_document_requests application_document_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.application_document_requests
    ADD CONSTRAINT application_document_requests_pkey PRIMARY KEY (id);


--
-- Name: application_document_waivers application_document_waivers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.application_document_waivers
    ADD CONSTRAINT application_document_waivers_pkey PRIMARY KEY (id);


--
-- Name: application_financials application_financials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.application_financials
    ADD CONSTRAINT application_financials_pkey PRIMARY KEY (id);


--
-- Name: application_form_responses application_form_responses_application_id_doc_type_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.application_form_responses
    ADD CONSTRAINT application_form_responses_application_id_doc_type_key UNIQUE (application_id, doc_type);


--
-- Name: application_form_responses application_form_responses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.application_form_responses
    ADD CONSTRAINT application_form_responses_pkey PRIMARY KEY (id);


--
-- Name: application_lender_responses application_lender_responses_application_id_lender_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.application_lender_responses
    ADD CONSTRAINT application_lender_responses_application_id_lender_id_key UNIQUE (application_id, lender_id);


--
-- Name: application_lender_responses application_lender_responses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.application_lender_responses
    ADD CONSTRAINT application_lender_responses_pkey PRIMARY KEY (id);


--
-- Name: application_lender_selections application_lender_selections_application_id_lender_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.application_lender_selections
    ADD CONSTRAINT application_lender_selections_application_id_lender_id_key UNIQUE (application_id, lender_id);


--
-- Name: application_lender_selections application_lender_selections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.application_lender_selections
    ADD CONSTRAINT application_lender_selections_pkey PRIMARY KEY (id);


--
-- Name: application_packages application_packages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.application_packages
    ADD CONSTRAINT application_packages_pkey PRIMARY KEY (id);


--
-- Name: application_rejection_reasons application_rejection_reasons_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.application_rejection_reasons
    ADD CONSTRAINT application_rejection_reasons_pkey PRIMARY KEY (id);


--
-- Name: application_required_documents application_required_document_application_id_document_categ_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.application_required_documents
    ADD CONSTRAINT application_required_document_application_id_document_categ_key UNIQUE (application_id, document_category);


--
-- Name: application_required_documents application_required_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.application_required_documents
    ADD CONSTRAINT application_required_documents_pkey PRIMARY KEY (id);


--
-- Name: application_research_facts application_research_facts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.application_research_facts
    ADD CONSTRAINT application_research_facts_pkey PRIMARY KEY (id);


--
-- Name: application_stage_events application_stage_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.application_stage_events
    ADD CONSTRAINT application_stage_events_pkey PRIMARY KEY (id);


--
-- Name: application_stage_history application_stage_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.application_stage_history
    ADD CONSTRAINT application_stage_history_pkey PRIMARY KEY (id);


--
-- Name: application_tasks application_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.application_tasks
    ADD CONSTRAINT application_tasks_pkey PRIMARY KEY (id);


--
-- Name: applications applications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.applications
    ADD CONSTRAINT applications_pkey PRIMARY KEY (id);


--
-- Name: audit_events audit_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_events
    ADD CONSTRAINT audit_events_pkey PRIMARY KEY (id);


--
-- Name: audit_logs audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id);


--
-- Name: auth_refresh_tokens auth_refresh_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_refresh_tokens
    ADD CONSTRAINT auth_refresh_tokens_pkey PRIMARY KEY (id);


--
-- Name: auth_refresh_tokens auth_refresh_tokens_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_refresh_tokens
    ADD CONSTRAINT auth_refresh_tokens_token_hash_key UNIQUE (token_hash);


--
-- Name: automation_rules automation_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_rules
    ADD CONSTRAINT automation_rules_pkey PRIMARY KEY (id);


--
-- Name: banking_analyses banking_analyses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.banking_analyses
    ADD CONSTRAINT banking_analyses_pkey PRIMARY KEY (application_id);


--
-- Name: banking_analysis_jobs banking_analysis_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.banking_analysis_jobs
    ADD CONSTRAINT banking_analysis_jobs_pkey PRIMARY KEY (id);


--
-- Name: banking_monthly_summaries banking_monthly_summaries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.banking_monthly_summaries
    ADD CONSTRAINT banking_monthly_summaries_pkey PRIMARY KEY (id);


--
-- Name: banking_monthly_summaries banking_monthly_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.banking_monthly_summaries
    ADD CONSTRAINT banking_monthly_unique UNIQUE (application_id, month_start);


--
-- Name: banking_transactions banking_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.banking_transactions
    ADD CONSTRAINT banking_transactions_pkey PRIMARY KEY (id);


--
-- Name: booking_events booking_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.booking_events
    ADD CONSTRAINT booking_events_pkey PRIMARY KEY (id);


--
-- Name: borrowers borrowers_application_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.borrowers
    ADD CONSTRAINT borrowers_application_id_key UNIQUE (application_id);


--
-- Name: borrowers borrowers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.borrowers
    ADD CONSTRAINT borrowers_pkey PRIMARY KEY (id);


--
-- Name: broker_deal_confirmations broker_deal_confirmations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.broker_deal_confirmations
    ADD CONSTRAINT broker_deal_confirmations_pkey PRIMARY KEY (id);


--
-- Name: broker_imports broker_imports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.broker_imports
    ADD CONSTRAINT broker_imports_pkey PRIMARY KEY (id);


--
-- Name: calendar_tasks calendar_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_tasks
    ADD CONSTRAINT calendar_tasks_pkey PRIMARY KEY (id);


--
-- Name: call_events call_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_events
    ADD CONSTRAINT call_events_pkey PRIMARY KEY (id);


--
-- Name: call_logs call_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_logs
    ADD CONSTRAINT call_logs_pkey PRIMARY KEY (id);


--
-- Name: call_recordings call_recordings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_recordings
    ADD CONSTRAINT call_recordings_pkey PRIMARY KEY (id);


--
-- Name: call_recordings call_recordings_twilio_recording_sid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_recordings
    ADD CONSTRAINT call_recordings_twilio_recording_sid_key UNIQUE (twilio_recording_sid);


--
-- Name: call_transcripts call_transcripts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_transcripts
    ADD CONSTRAINT call_transcripts_pkey PRIMARY KEY (id);


--
-- Name: call_transcripts call_transcripts_transcription_sid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_transcripts
    ADD CONSTRAINT call_transcripts_transcription_sid_key UNIQUE (transcription_sid);


--
-- Name: capital_readiness capital_readiness_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.capital_readiness
    ADD CONSTRAINT capital_readiness_pkey PRIMARY KEY (id);


--
-- Name: chat_messages chat_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_pkey PRIMARY KEY (id);


--
-- Name: chat_queue chat_queue_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_queue
    ADD CONSTRAINT chat_queue_pkey PRIMARY KEY (id);


--
-- Name: chat_sessions chat_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_sessions
    ADD CONSTRAINT chat_sessions_pkey PRIMARY KEY (id);


--
-- Name: client_device_credentials client_device_credentials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_device_credentials
    ADD CONSTRAINT client_device_credentials_pkey PRIMARY KEY (id);


--
-- Name: client_issues client_issues_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_issues
    ADD CONSTRAINT client_issues_pkey PRIMARY KEY (id);


--
-- Name: client_notifications client_notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_notifications
    ADD CONSTRAINT client_notifications_pkey PRIMARY KEY (id);


--
-- Name: client_push_tokens client_push_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_push_tokens
    ADD CONSTRAINT client_push_tokens_pkey PRIMARY KEY (id);


--
-- Name: client_push_tokens client_push_tokens_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_push_tokens
    ADD CONSTRAINT client_push_tokens_token_key UNIQUE (token);


--
-- Name: client_submissions client_submissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_submissions
    ADD CONSTRAINT client_submissions_pkey PRIMARY KEY (id);


--
-- Name: client_submissions client_submissions_submission_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_submissions
    ADD CONSTRAINT client_submissions_submission_key_key UNIQUE (submission_key);


--
-- Name: collateral_assets collateral_assets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collateral_assets
    ADD CONSTRAINT collateral_assets_pkey PRIMARY KEY (id);


--
-- Name: collateral collateral_borrower_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collateral
    ADD CONSTRAINT collateral_borrower_id_key UNIQUE (borrower_id);


--
-- Name: collateral collateral_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collateral
    ADD CONSTRAINT collateral_pkey PRIMARY KEY (id);


--
-- Name: communications_conversations communications_conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.communications_conversations
    ADD CONSTRAINT communications_conversations_pkey PRIMARY KEY (id);


--
-- Name: communications_messages communications_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.communications_messages
    ADD CONSTRAINT communications_messages_pkey PRIMARY KEY (id);


--
-- Name: companies companies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.companies
    ADD CONSTRAINT companies_pkey PRIMARY KEY (id);


--
-- Name: company_research_cache company_research_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_research_cache
    ADD CONSTRAINT company_research_cache_pkey PRIMARY KEY (cache_key);


--
-- Name: conference_participants conference_participants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conference_participants
    ADD CONSTRAINT conference_participants_pkey PRIMARY KEY (id);


--
-- Name: conference_participants conference_participants_twilio_call_sid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conference_participants
    ADD CONSTRAINT conference_participants_twilio_call_sid_key UNIQUE (twilio_call_sid);


--
-- Name: conferences conferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conferences
    ADD CONSTRAINT conferences_pkey PRIMARY KEY (id);


--
-- Name: conferences conferences_twilio_conference_sid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conferences
    ADD CONSTRAINT conferences_twilio_conference_sid_key UNIQUE (twilio_conference_sid);


--
-- Name: contact_ad_attribution contact_ad_attribution_contact_id_gclid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_ad_attribution
    ADD CONSTRAINT contact_ad_attribution_contact_id_gclid_key UNIQUE (contact_id, gclid);


--
-- Name: contact_ad_attribution contact_ad_attribution_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_ad_attribution
    ADD CONSTRAINT contact_ad_attribution_pkey PRIMARY KEY (id);


--
-- Name: contact_documents contact_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_documents
    ADD CONSTRAINT contact_documents_pkey PRIMARY KEY (id);


--
-- Name: contact_leads contact_leads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_leads
    ADD CONSTRAINT contact_leads_pkey PRIMARY KEY (id);


--
-- Name: contact_merges contact_merges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_merges
    ADD CONSTRAINT contact_merges_pkey PRIMARY KEY (id);


--
-- Name: contacts contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_pkey PRIMARY KEY (id);


--
-- Name: continuation continuation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuation
    ADD CONSTRAINT continuation_pkey PRIMARY KEY (id);


--
-- Name: continuation_sessions continuation_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuation_sessions
    ADD CONSTRAINT continuation_sessions_pkey PRIMARY KEY (id);


--
-- Name: credit_summaries credit_summaries_application_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_summaries
    ADD CONSTRAINT credit_summaries_application_id_key UNIQUE (application_id);


--
-- Name: credit_summaries credit_summaries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_summaries
    ADD CONSTRAINT credit_summaries_pkey PRIMARY KEY (id);


--
-- Name: credit_summaries_v2 credit_summaries_v2_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_summaries_v2
    ADD CONSTRAINT credit_summaries_v2_pkey PRIMARY KEY (application_id);


--
-- Name: credit_summary_jobs credit_summary_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_summary_jobs
    ADD CONSTRAINT credit_summary_jobs_pkey PRIMARY KEY (id);


--
-- Name: credit_summary_versions credit_summary_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_summary_versions
    ADD CONSTRAINT credit_summary_versions_pkey PRIMARY KEY (id);


--
-- Name: crm_call_log crm_call_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_call_log
    ADD CONSTRAINT crm_call_log_pkey PRIMARY KEY (id);


--
-- Name: crm_company_web_profiles crm_company_web_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_company_web_profiles
    ADD CONSTRAINT crm_company_web_profiles_pkey PRIMARY KEY (domain);


--
-- Name: crm_email_log crm_email_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_email_log
    ADD CONSTRAINT crm_email_log_pkey PRIMARY KEY (id);


--
-- Name: crm_lead_activities crm_lead_activities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_lead_activities
    ADD CONSTRAINT crm_lead_activities_pkey PRIMARY KEY (id);


--
-- Name: crm_leads crm_leads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_leads
    ADD CONSTRAINT crm_leads_pkey PRIMARY KEY (id);


--
-- Name: crm_meetings crm_meetings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_meetings
    ADD CONSTRAINT crm_meetings_pkey PRIMARY KEY (id);


--
-- Name: crm_notes crm_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_notes
    ADD CONSTRAINT crm_notes_pkey PRIMARY KEY (id);


--
-- Name: crm_segments crm_segments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_segments
    ADD CONSTRAINT crm_segments_pkey PRIMARY KEY (id);


--
-- Name: crm_task crm_task_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_task
    ADD CONSTRAINT crm_task_pkey PRIMARY KEY (id);


--
-- Name: crm_tasks crm_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_tasks
    ADD CONSTRAINT crm_tasks_pkey PRIMARY KEY (id);


--
-- Name: crm_timeline_events crm_timeline_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_timeline_events
    ADD CONSTRAINT crm_timeline_events_pkey PRIMARY KEY (id);


--
-- Name: document_ocr_fields document_ocr_fields_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_ocr_fields
    ADD CONSTRAINT document_ocr_fields_pkey PRIMARY KEY (id);


--
-- Name: document_processing_jobs document_processing_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_processing_jobs
    ADD CONSTRAINT document_processing_jobs_pkey PRIMARY KEY (id);


--
-- Name: document_types document_types_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_types
    ADD CONSTRAINT document_types_key_key UNIQUE (key);


--
-- Name: document_types document_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_types
    ADD CONSTRAINT document_types_pkey PRIMARY KEY (id);


--
-- Name: document_version_reviews document_version_reviews_document_version_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_version_reviews
    ADD CONSTRAINT document_version_reviews_document_version_id_key UNIQUE (document_version_id);


--
-- Name: document_version_reviews document_version_reviews_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_version_reviews
    ADD CONSTRAINT document_version_reviews_pkey PRIMARY KEY (id);


--
-- Name: document_versions document_versions_document_id_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_versions
    ADD CONSTRAINT document_versions_document_id_version_key UNIQUE (document_id, version);


--
-- Name: document_versions document_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_versions
    ADD CONSTRAINT document_versions_pkey PRIMARY KEY (id);


--
-- Name: documents documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_pkey PRIMARY KEY (id);


--
-- Name: email_link_clicks email_link_clicks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_link_clicks
    ADD CONSTRAINT email_link_clicks_pkey PRIMARY KEY (id);


--
-- Name: email_open_events email_open_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_open_events
    ADD CONSTRAINT email_open_events_pkey PRIMARY KEY (id);


--
-- Name: export_audit export_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.export_audit
    ADD CONSTRAINT export_audit_pkey PRIMARY KEY (id);


--
-- Name: failed_jobs failed_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.failed_jobs
    ADD CONSTRAINT failed_jobs_pkey PRIMARY KEY (id);


--
-- Name: financials financials_borrower_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.financials
    ADD CONSTRAINT financials_borrower_id_key UNIQUE (borrower_id);


--
-- Name: financials financials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.financials
    ADD CONSTRAINT financials_pkey PRIMARY KEY (id);


--
-- Name: fx_rates fx_rates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fx_rates
    ADD CONSTRAINT fx_rates_pkey PRIMARY KEY (currency);


--
-- Name: google_ads_daily google_ads_daily_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.google_ads_daily
    ADD CONSTRAINT google_ads_daily_pkey PRIMARY KEY (id);


--
-- Name: graph_mail_subscriptions graph_mail_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.graph_mail_subscriptions
    ADD CONSTRAINT graph_mail_subscriptions_pkey PRIMARY KEY (id);


--
-- Name: idempotency_keys idempotency_keys_key_route_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idempotency_keys
    ADD CONSTRAINT idempotency_keys_key_route_key UNIQUE (key, route);


--
-- Name: idempotency_keys idempotency_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idempotency_keys
    ADD CONSTRAINT idempotency_keys_pkey PRIMARY KEY (id);


--
-- Name: inbound_attachment_attempts inbound_attachment_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inbound_attachment_attempts
    ADD CONSTRAINT inbound_attachment_attempts_pkey PRIMARY KEY (silo, message_id);


--
-- Name: issue_reports issue_reports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.issue_reports
    ADD CONSTRAINT issue_reports_pkey PRIMARY KEY (id);


--
-- Name: issues issues_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.issues
    ADD CONSTRAINT issues_pkey PRIMARY KEY (id);


--
-- Name: job_queue job_queue_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_queue
    ADD CONSTRAINT job_queue_pkey PRIMARY KEY (id);


--
-- Name: lender_documents lender_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lender_documents
    ADD CONSTRAINT lender_documents_pkey PRIMARY KEY (id);


--
-- Name: lender_email_bounces lender_email_bounces_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lender_email_bounces
    ADD CONSTRAINT lender_email_bounces_pkey PRIMARY KEY (id);


--
-- Name: lender_package_links lender_package_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lender_package_links
    ADD CONSTRAINT lender_package_links_pkey PRIMARY KEY (token);


--
-- Name: lender_product_requirements lender_product_requirements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lender_product_requirements
    ADD CONSTRAINT lender_product_requirements_pkey PRIMARY KEY (id);


--
-- Name: lender_products lender_products_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lender_products
    ADD CONSTRAINT lender_products_pkey PRIMARY KEY (id);


--
-- Name: lender_sheet_dispatches lender_sheet_dispatches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lender_sheet_dispatches
    ADD CONSTRAINT lender_sheet_dispatches_pkey PRIMARY KEY (application_id, lender_id);


--
-- Name: lender_submission_retries lender_submission_retries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lender_submission_retries
    ADD CONSTRAINT lender_submission_retries_pkey PRIMARY KEY (id);


--
-- Name: lender_submission_retries lender_submission_retries_submission_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lender_submission_retries
    ADD CONSTRAINT lender_submission_retries_submission_id_key UNIQUE (submission_id);


--
-- Name: lender_submissions lender_submissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lender_submissions
    ADD CONSTRAINT lender_submissions_pkey PRIMARY KEY (id);


--
-- Name: lenders lenders_name_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lenders
    ADD CONSTRAINT lenders_name_unique UNIQUE (name);


--
-- Name: lenders lenders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lenders
    ADD CONSTRAINT lenders_pkey PRIMARY KEY (id);


--
-- Name: link_previews link_previews_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.link_previews
    ADD CONSTRAINT link_previews_pkey PRIMARY KEY (url);


--
-- Name: live_chat_queue live_chat_queue_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.live_chat_queue
    ADD CONSTRAINT live_chat_queue_pkey PRIMARY KEY (id);


--
-- Name: live_chat_requests live_chat_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.live_chat_requests
    ADD CONSTRAINT live_chat_requests_pkey PRIMARY KEY (id);


--
-- Name: mail_poll_state mail_poll_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mail_poll_state
    ADD CONSTRAINT mail_poll_state_pkey PRIMARY KEY (mailbox);


--
-- Name: marketing_email_template marketing_email_template_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketing_email_template
    ADD CONSTRAINT marketing_email_template_pkey PRIMARY KEY (silo);


--
-- Name: marketing_landing_pages marketing_landing_pages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketing_landing_pages
    ADD CONSTRAINT marketing_landing_pages_pkey PRIMARY KEY (id);


--
-- Name: marketing_landing_pages marketing_landing_pages_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketing_landing_pages
    ADD CONSTRAINT marketing_landing_pages_slug_key UNIQUE (slug);


--
-- Name: marketing_send_jobs marketing_send_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketing_send_jobs
    ADD CONSTRAINT marketing_send_jobs_pkey PRIMARY KEY (id);


--
-- Name: marketing_sequence_enrollments marketing_sequence_enrollments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketing_sequence_enrollments
    ADD CONSTRAINT marketing_sequence_enrollments_pkey PRIMARY KEY (id);


--
-- Name: marketing_sequence_enrollments marketing_sequence_enrollments_sequence_id_contact_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketing_sequence_enrollments
    ADD CONSTRAINT marketing_sequence_enrollments_sequence_id_contact_id_key UNIQUE (sequence_id, contact_id);


--
-- Name: marketing_sequence_steps marketing_sequence_steps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketing_sequence_steps
    ADD CONSTRAINT marketing_sequence_steps_pkey PRIMARY KEY (id);


--
-- Name: marketing_sequences marketing_sequences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketing_sequences
    ADD CONSTRAINT marketing_sequences_pkey PRIMARY KEY (id);


--
-- Name: marketing_template marketing_template_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketing_template
    ADD CONSTRAINT marketing_template_pkey PRIMARY KEY (id);


--
-- Name: maya_audit maya_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maya_audit
    ADD CONSTRAINT maya_audit_pkey PRIMARY KEY (id);


--
-- Name: maya_escalations maya_escalations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maya_escalations
    ADD CONSTRAINT maya_escalations_pkey PRIMARY KEY (id);


--
-- Name: message_templates message_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_templates
    ADD CONSTRAINT message_templates_pkey PRIMARY KEY (id);


--
-- Name: messages_typing messages_typing_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages_typing
    ADD CONSTRAINT messages_typing_pkey PRIMARY KEY (contact_id, side);


--
-- Name: naics_codes naics_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.naics_codes
    ADD CONSTRAINT naics_codes_pkey PRIMARY KEY (code, country);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: notifications notifications_unique_per_ref; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_unique_per_ref UNIQUE (user_id, ref_table, ref_id, type);


--
-- Name: ocr_jobs ocr_jobs_document_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ocr_jobs
    ADD CONSTRAINT ocr_jobs_document_id_key UNIQUE (document_id);


--
-- Name: ocr_jobs ocr_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ocr_jobs
    ADD CONSTRAINT ocr_jobs_pkey PRIMARY KEY (id);


--
-- Name: ocr_document_results ocr_results_document_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ocr_document_results
    ADD CONSTRAINT ocr_results_document_id_key UNIQUE (document_id);


--
-- Name: ocr_document_results ocr_results_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ocr_document_results
    ADD CONSTRAINT ocr_results_pkey PRIMARY KEY (id);


--
-- Name: ocr_results ocr_results_pkey1; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ocr_results
    ADD CONSTRAINT ocr_results_pkey1 PRIMARY KEY (id);


--
-- Name: offers offers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.offers
    ADD CONSTRAINT offers_pkey PRIMARY KEY (id);


--
-- Name: ops_kill_switches ops_kill_switches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ops_kill_switches
    ADD CONSTRAINT ops_kill_switches_pkey PRIMARY KEY (key);


--
-- Name: ops_replay_events ops_replay_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ops_replay_events
    ADD CONSTRAINT ops_replay_events_pkey PRIMARY KEY (id);


--
-- Name: ops_replay_events ops_replay_events_source_table_source_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ops_replay_events
    ADD CONSTRAINT ops_replay_events_source_table_source_id_key UNIQUE (source_table, source_id);


--
-- Name: ops_replay_jobs ops_replay_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ops_replay_jobs
    ADD CONSTRAINT ops_replay_jobs_pkey PRIMARY KEY (id);


--
-- Name: otp_codes otp_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.otp_codes
    ADD CONSTRAINT otp_codes_pkey PRIMARY KEY (id);


--
-- Name: otp_sessions otp_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.otp_sessions
    ADD CONSTRAINT otp_sessions_pkey PRIMARY KEY (id);


--
-- Name: otp_verifications otp_verifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.otp_verifications
    ADD CONSTRAINT otp_verifications_pkey PRIMARY KEY (id);


--
-- Name: owners owners_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.owners
    ADD CONSTRAINT owners_pkey PRIMARY KEY (id);


--
-- Name: password_resets password_resets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_resets
    ADD CONSTRAINT password_resets_pkey PRIMARY KEY (id);


--
-- Name: password_resets password_resets_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_resets
    ADD CONSTRAINT password_resets_token_hash_key UNIQUE (token_hash);


--
-- Name: portal_errors portal_errors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_errors
    ADD CONSTRAINT portal_errors_pkey PRIMARY KEY (id);


--
-- Name: pre_applications pre_applications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pre_applications
    ADD CONSTRAINT pre_applications_pkey PRIMARY KEY (id);


--
-- Name: pwa_notifications pwa_notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pwa_notifications
    ADD CONSTRAINT pwa_notifications_pkey PRIMARY KEY (id);


--
-- Name: pwa_subscriptions pwa_subscriptions_endpoint_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pwa_subscriptions
    ADD CONSTRAINT pwa_subscriptions_endpoint_key UNIQUE (endpoint);


--
-- Name: pwa_subscriptions pwa_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pwa_subscriptions
    ADD CONSTRAINT pwa_subscriptions_pkey PRIMARY KEY (id);


--
-- Name: qa_questions qa_questions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qa_questions
    ADD CONSTRAINT qa_questions_pkey PRIMARY KEY (id);


--
-- Name: qa_sets qa_sets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qa_sets
    ADD CONSTRAINT qa_sets_pkey PRIMARY KEY (id);


--
-- Name: readiness_application_mappings readiness_application_mappings_application_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.readiness_application_mappings
    ADD CONSTRAINT readiness_application_mappings_application_id_key UNIQUE (application_id);


--
-- Name: readiness_application_mappings readiness_application_mappings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.readiness_application_mappings
    ADD CONSTRAINT readiness_application_mappings_pkey PRIMARY KEY (id);


--
-- Name: readiness_application_mappings readiness_application_mappings_readiness_session_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.readiness_application_mappings
    ADD CONSTRAINT readiness_application_mappings_readiness_session_id_key UNIQUE (readiness_session_id);


--
-- Name: readiness_sessions readiness_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.readiness_sessions
    ADD CONSTRAINT readiness_sessions_pkey PRIMARY KEY (id);


--
-- Name: readiness_sessions readiness_sessions_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.readiness_sessions
    ADD CONSTRAINT readiness_sessions_token_key UNIQUE (token);


--
-- Name: referral_conversions referral_conversions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referral_conversions
    ADD CONSTRAINT referral_conversions_pkey PRIMARY KEY (id);


--
-- Name: rejection_reasons rejection_reasons_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rejection_reasons
    ADD CONSTRAINT rejection_reasons_pkey PRIMARY KEY (code);


--
-- Name: reporting_application_volume_daily reporting_application_volume_daily_metric_date_product_type_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reporting_application_volume_daily
    ADD CONSTRAINT reporting_application_volume_daily_metric_date_product_type_key UNIQUE (metric_date, product_type);


--
-- Name: reporting_application_volume_daily reporting_application_volume_daily_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reporting_application_volume_daily
    ADD CONSTRAINT reporting_application_volume_daily_pkey PRIMARY KEY (id);


--
-- Name: reporting_daily_metrics reporting_daily_metrics_metric_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reporting_daily_metrics
    ADD CONSTRAINT reporting_daily_metrics_metric_date_key UNIQUE (metric_date);


--
-- Name: reporting_daily_metrics reporting_daily_metrics_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reporting_daily_metrics
    ADD CONSTRAINT reporting_daily_metrics_pkey PRIMARY KEY (id);


--
-- Name: reporting_document_metrics_daily reporting_document_metrics_daily_metric_date_document_type_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reporting_document_metrics_daily
    ADD CONSTRAINT reporting_document_metrics_daily_metric_date_document_type_key UNIQUE (metric_date, document_type);


--
-- Name: reporting_document_metrics_daily reporting_document_metrics_daily_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reporting_document_metrics_daily
    ADD CONSTRAINT reporting_document_metrics_daily_pkey PRIMARY KEY (id);


--
-- Name: reporting_lender_funnel_daily reporting_lender_funnel_daily_metric_date_lender_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reporting_lender_funnel_daily
    ADD CONSTRAINT reporting_lender_funnel_daily_metric_date_lender_id_key UNIQUE (metric_date, lender_id);


--
-- Name: reporting_lender_funnel_daily reporting_lender_funnel_daily_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reporting_lender_funnel_daily
    ADD CONSTRAINT reporting_lender_funnel_daily_pkey PRIMARY KEY (id);


--
-- Name: reporting_lender_performance reporting_lender_performance_lender_id_period_start_period__key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reporting_lender_performance
    ADD CONSTRAINT reporting_lender_performance_lender_id_period_start_period__key UNIQUE (lender_id, period_start, period_end);


--
-- Name: reporting_lender_performance reporting_lender_performance_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reporting_lender_performance
    ADD CONSTRAINT reporting_lender_performance_pkey PRIMARY KEY (id);


--
-- Name: reporting_pipeline_daily_snapshots reporting_pipeline_daily_snaps_snapshot_date_pipeline_state_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reporting_pipeline_daily_snapshots
    ADD CONSTRAINT reporting_pipeline_daily_snaps_snapshot_date_pipeline_state_key UNIQUE (snapshot_date, pipeline_state);


--
-- Name: reporting_pipeline_daily_snapshots reporting_pipeline_daily_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reporting_pipeline_daily_snapshots
    ADD CONSTRAINT reporting_pipeline_daily_snapshots_pkey PRIMARY KEY (id);


--
-- Name: reporting_pipeline_snapshots reporting_pipeline_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reporting_pipeline_snapshots
    ADD CONSTRAINT reporting_pipeline_snapshots_pkey PRIMARY KEY (id);


--
-- Name: reporting_pipeline_snapshots reporting_pipeline_snapshots_snapshot_at_pipeline_state_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reporting_pipeline_snapshots
    ADD CONSTRAINT reporting_pipeline_snapshots_snapshot_at_pipeline_state_key UNIQUE (snapshot_at, pipeline_state);


--
-- Name: reporting_staff_activity_daily reporting_staff_activity_dail_metric_date_staff_user_id_act_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reporting_staff_activity_daily
    ADD CONSTRAINT reporting_staff_activity_dail_metric_date_staff_user_id_act_key UNIQUE (metric_date, staff_user_id, action);


--
-- Name: reporting_staff_activity_daily reporting_staff_activity_daily_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reporting_staff_activity_daily
    ADD CONSTRAINT reporting_staff_activity_daily_pkey PRIMARY KEY (id);


--
-- Name: scheduled_emails scheduled_emails_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduled_emails
    ADD CONSTRAINT scheduled_emails_pkey PRIMARY KEY (id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (id);


--
-- Name: sequence_sends sequence_sends_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sequence_sends
    ADD CONSTRAINT sequence_sends_pkey PRIMARY KEY (id);


--
-- Name: settings settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settings
    ADD CONSTRAINT settings_pkey PRIMARY KEY (key);


--
-- Name: shared_mailbox_settings shared_mailbox_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shared_mailbox_settings
    ADD CONSTRAINT shared_mailbox_settings_pkey PRIMARY KEY (id);


--
-- Name: sms_campaign_sends sms_campaign_sends_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sms_campaign_sends
    ADD CONSTRAINT sms_campaign_sends_pkey PRIMARY KEY (id);


--
-- Name: sms_campaigns sms_campaigns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sms_campaigns
    ADD CONSTRAINT sms_campaigns_pkey PRIMARY KEY (id);


--
-- Name: sms_deliveries sms_deliveries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sms_deliveries
    ADD CONSTRAINT sms_deliveries_pkey PRIMARY KEY (message_sid);


--
-- Name: staff_device_credentials staff_device_credentials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_device_credentials
    ADD CONSTRAINT staff_device_credentials_pkey PRIMARY KEY (id);


--
-- Name: staff_presence staff_presence_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_presence
    ADD CONSTRAINT staff_presence_pkey PRIMARY KEY (user_id);


--
-- Name: submission_events submission_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.submission_events
    ADD CONSTRAINT submission_events_pkey PRIMARY KEY (id);


--
-- Name: submit_attempts submit_attempts_application_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.submit_attempts
    ADD CONSTRAINT submit_attempts_application_token_key UNIQUE (application_token);


--
-- Name: submit_attempts submit_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.submit_attempts
    ADD CONSTRAINT submit_attempts_pkey PRIMARY KEY (id);


--
-- Name: task_digest_log task_digest_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_digest_log
    ADD CONSTRAINT task_digest_log_pkey PRIMARY KEY (user_id, digest_date);


--
-- Name: task_queue_shares task_queue_shares_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_queue_shares
    ADD CONSTRAINT task_queue_shares_pkey PRIMARY KEY (queue_id, user_id);


--
-- Name: task_queues task_queues_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_queues
    ADD CONSTRAINT task_queues_pkey PRIMARY KEY (id);


--
-- Name: tasks tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_pkey PRIMARY KEY (id);


--
-- Name: team_channel_members team_channel_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_channel_members
    ADD CONSTRAINT team_channel_members_pkey PRIMARY KEY (channel_id, user_id);


--
-- Name: team_channels team_channels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_channels
    ADD CONSTRAINT team_channels_pkey PRIMARY KEY (id);


--
-- Name: team_message_reactions team_message_reactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_message_reactions
    ADD CONSTRAINT team_message_reactions_pkey PRIMARY KEY (message_id, user_id, emoji);


--
-- Name: team_messages team_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_messages
    ADD CONSTRAINT team_messages_pkey PRIMARY KEY (id);


--
-- Name: teams_meetings teams_meetings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teams_meetings
    ADD CONSTRAINT teams_meetings_pkey PRIMARY KEY (id);


--
-- Name: template_send_events template_send_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.template_send_events
    ADD CONSTRAINT template_send_events_pkey PRIMARY KEY (id);


--
-- Name: user_settings user_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_settings
    ADD CONSTRAINT user_settings_pkey PRIMARY KEY (user_id);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_phone_number_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_phone_number_unique UNIQUE (phone_number);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: visitor_events visitor_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.visitor_events
    ADD CONSTRAINT visitor_events_pkey PRIMARY KEY (id);


--
-- Name: visitor_sessions visitor_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.visitor_sessions
    ADD CONSTRAINT visitor_sessions_pkey PRIMARY KEY (session_id);


--
-- Name: voicemails voicemails_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voicemails
    ADD CONSTRAINT voicemails_pkey PRIMARY KEY (id);


--
-- Name: watch_call_bridges watch_call_bridges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watch_call_bridges
    ADD CONSTRAINT watch_call_bridges_pkey PRIMARY KEY (id);


--
-- Name: watch_call_bridges watch_call_bridges_staff_user_id_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watch_call_bridges
    ADD CONSTRAINT watch_call_bridges_staff_user_id_idempotency_key_key UNIQUE (staff_user_id, idempotency_key);


--
-- Name: watch_devices watch_devices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watch_devices
    ADD CONSTRAINT watch_devices_pkey PRIMARY KEY (id);


--
-- Name: watch_link_codes watch_link_codes_code_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watch_link_codes
    ADD CONSTRAINT watch_link_codes_code_hash_key UNIQUE (code_hash);


--
-- Name: watch_link_codes watch_link_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watch_link_codes
    ADD CONSTRAINT watch_link_codes_pkey PRIMARY KEY (id);


--
-- Name: watch_push_registrations watch_push_registrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watch_push_registrations
    ADD CONSTRAINT watch_push_registrations_pkey PRIMARY KEY (device_id);


--
-- Name: watch_sessions watch_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watch_sessions
    ADD CONSTRAINT watch_sessions_pkey PRIMARY KEY (id);


--
-- Name: watch_sessions watch_sessions_refresh_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watch_sessions
    ADD CONSTRAINT watch_sessions_refresh_token_hash_key UNIQUE (refresh_token_hash);


--
-- Name: webauthn_challenges webauthn_challenges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webauthn_challenges
    ADD CONSTRAINT webauthn_challenges_pkey PRIMARY KEY (id);


--
-- Name: webauthn_credentials webauthn_credentials_credential_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webauthn_credentials
    ADD CONSTRAINT webauthn_credentials_credential_id_key UNIQUE (credential_id);


--
-- Name: webauthn_credentials webauthn_credentials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webauthn_credentials
    ADD CONSTRAINT webauthn_credentials_pkey PRIMARY KEY (id);


--
-- Name: wizard_block_events wizard_block_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wizard_block_events
    ADD CONSTRAINT wizard_block_events_pkey PRIMARY KEY (id);


--
-- Name: ai_rules_active_priority_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_rules_active_priority_idx ON public.ai_rules USING btree (active, priority DESC);


--
-- Name: application_collateral_app_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX application_collateral_app_idx ON public.application_collateral USING btree (application_id);


--
-- Name: application_collateral_doc_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX application_collateral_doc_uq ON public.application_collateral USING btree (application_id, source_document_id);


--
-- Name: application_document_requests_app_type_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX application_document_requests_app_type_uq ON public.application_document_requests USING btree (application_id, document_type);


--
-- Name: application_financials_app_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX application_financials_app_idx ON public.application_financials USING btree (application_id);


--
-- Name: application_financials_cell_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX application_financials_cell_uq ON public.application_financials USING btree (application_id, period, line_item);


--
-- Name: application_research_facts_app_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX application_research_facts_app_idx ON public.application_research_facts USING btree (application_id);


--
-- Name: application_research_facts_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX application_research_facts_uq ON public.application_research_facts USING btree (application_id, source, label, value);


--
-- Name: application_stage_events_application_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX application_stage_events_application_id_idx ON public.application_stage_events USING btree (application_id);


--
-- Name: application_stage_history_app_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX application_stage_history_app_idx ON public.application_stage_history USING btree (application_id, created_at DESC);


--
-- Name: applications_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX applications_created_at_idx ON public.applications USING btree (created_at);


--
-- Name: applications_parent_application_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX applications_parent_application_id_idx ON public.applications USING btree (parent_application_id);


--
-- Name: applications_pipeline_updated_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX applications_pipeline_updated_idx ON public.applications USING btree (pipeline_state, updated_at);


--
-- Name: applications_silo_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX applications_silo_idx ON public.applications USING btree (silo);


--
-- Name: applications_submission_packages_started_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX applications_submission_packages_started_at_idx ON public.applications USING btree (submission_packages_started_at);


--
-- Name: applications_submitted_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX applications_submitted_at_idx ON public.applications USING btree (submitted_at) WHERE (submitted_at IS NOT NULL);


--
-- Name: auth_refresh_tokens_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_refresh_tokens_user_id_idx ON public.auth_refresh_tokens USING btree (user_id);


--
-- Name: automation_rules_trigger_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX automation_rules_trigger_idx ON public.automation_rules USING btree (silo, trigger_type, enabled);


--
-- Name: banking_analyses_next_attempt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX banking_analyses_next_attempt_idx ON public.banking_analyses USING btree (next_attempt_at) WHERE (status = 'failed'::text);


--
-- Name: booking_events_contact_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX booking_events_contact_idx ON public.booking_events USING btree (contact_id, silo);


--
-- Name: booking_events_graph_event_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX booking_events_graph_event_uidx ON public.booking_events USING btree (graph_event_id);


--
-- Name: booking_events_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX booking_events_status_idx ON public.booking_events USING btree (status, scheduled_at);


--
-- Name: broker_deal_confirmations_app_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX broker_deal_confirmations_app_uq ON public.broker_deal_confirmations USING btree (application_id);


--
-- Name: broker_imports_application_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX broker_imports_application_idx ON public.broker_imports USING btree (application_id);


--
-- Name: broker_imports_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX broker_imports_created_idx ON public.broker_imports USING btree (created_at DESC);


--
-- Name: call_logs_application_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX call_logs_application_idx ON public.call_logs USING btree (application_id);


--
-- Name: call_logs_contact_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX call_logs_contact_idx ON public.call_logs USING btree (crm_contact_id);


--
-- Name: call_logs_silo_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX call_logs_silo_idx ON public.call_logs USING btree (silo);


--
-- Name: call_logs_staff_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX call_logs_staff_idx ON public.call_logs USING btree (staff_user_id);


--
-- Name: call_logs_twilio_call_sid_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX call_logs_twilio_call_sid_unique ON public.call_logs USING btree (twilio_call_sid) WHERE (twilio_call_sid IS NOT NULL);


--
-- Name: chat_messages_session_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chat_messages_session_created_idx ON public.chat_messages USING btree (session_id, created_at);


--
-- Name: client_issues_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX client_issues_created_at_idx ON public.client_issues USING btree (created_at DESC);


--
-- Name: client_notifications_app_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX client_notifications_app_idx ON public.client_notifications USING btree (application_id, created_at DESC);


--
-- Name: client_push_tokens_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX client_push_tokens_user_idx ON public.client_push_tokens USING btree (user_id);


--
-- Name: comm_messages_contact_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX comm_messages_contact_idx ON public.communications_messages USING btree (contact_id);


--
-- Name: comm_messages_phone_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX comm_messages_phone_idx ON public.communications_messages USING btree (phone_number);


--
-- Name: comm_messages_twilio_sid_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX comm_messages_twilio_sid_idx ON public.communications_messages USING btree (twilio_sid) WHERE (twilio_sid IS NOT NULL);


--
-- Name: communications_messages_contact_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX communications_messages_contact_idx ON public.communications_messages USING btree (contact_id);


--
-- Name: communications_messages_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX communications_messages_created_idx ON public.communications_messages USING btree (created_at DESC);


--
-- Name: communications_messages_silo_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX communications_messages_silo_idx ON public.communications_messages USING btree (silo);


--
-- Name: companies_domain_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX companies_domain_idx ON public.companies USING btree (domain);


--
-- Name: companies_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX companies_owner_idx ON public.companies USING btree (owner_id);


--
-- Name: companies_region_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX companies_region_idx ON public.companies USING btree (region);


--
-- Name: companies_silo_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX companies_silo_idx ON public.companies USING btree (silo);


--
-- Name: companies_types_of_financing_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX companies_types_of_financing_gin_idx ON public.companies USING gin (types_of_financing);


--
-- Name: contact_merges_loser_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contact_merges_loser_idx ON public.contact_merges USING btree (loser_id);


--
-- Name: contact_merges_survivor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contact_merges_survivor_idx ON public.contact_merges USING btree (survivor_id);


--
-- Name: contacts_company_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contacts_company_idx ON public.contacts USING btree (company_id);


--
-- Name: contacts_lead_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contacts_lead_status_idx ON public.contacts USING btree (lead_status);


--
-- Name: contacts_lifecycle_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contacts_lifecycle_idx ON public.contacts USING btree (lifecycle_stage);


--
-- Name: contacts_merged_into_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contacts_merged_into_idx ON public.contacts USING btree (merged_into_id) WHERE (merged_into_id IS NOT NULL);


--
-- Name: contacts_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contacts_owner_idx ON public.contacts USING btree (owner_id);


--
-- Name: contacts_ref_code_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX contacts_ref_code_uidx ON public.contacts USING btree (ref_code) WHERE (ref_code IS NOT NULL);


--
-- Name: contacts_silo_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contacts_silo_idx ON public.contacts USING btree (silo);


--
-- Name: contacts_surname_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contacts_surname_idx ON public.contacts USING btree (public.bf_surname(name)) WHERE (name IS NOT NULL);


--
-- Name: contacts_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contacts_user_id_idx ON public.contacts USING btree (user_id);


--
-- Name: crm_calls_company_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_calls_company_idx ON public.crm_call_log USING btree (company_id);


--
-- Name: crm_calls_contact_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_calls_contact_idx ON public.crm_call_log USING btree (contact_id);


--
-- Name: crm_calls_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_calls_owner_idx ON public.crm_call_log USING btree (owner_id);


--
-- Name: crm_calls_silo_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_calls_silo_idx ON public.crm_call_log USING btree (silo);


--
-- Name: crm_email_log_graph_msg_contact_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX crm_email_log_graph_msg_contact_idx ON public.crm_email_log USING btree (graph_message_id, contact_id) WHERE (graph_message_id IS NOT NULL);


--
-- Name: crm_emails_company_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_emails_company_idx ON public.crm_email_log USING btree (company_id);


--
-- Name: crm_emails_contact_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_emails_contact_idx ON public.crm_email_log USING btree (contact_id);


--
-- Name: crm_emails_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_emails_owner_idx ON public.crm_email_log USING btree (owner_id);


--
-- Name: crm_emails_silo_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_emails_silo_idx ON public.crm_email_log USING btree (silo);


--
-- Name: crm_lead_activities_lead_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_lead_activities_lead_id_idx ON public.crm_lead_activities USING btree (lead_id, created_at DESC);


--
-- Name: crm_meetings_company_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_meetings_company_idx ON public.crm_meetings USING btree (company_id);


--
-- Name: crm_meetings_contact_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_meetings_contact_idx ON public.crm_meetings USING btree (contact_id);


--
-- Name: crm_meetings_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_meetings_owner_idx ON public.crm_meetings USING btree (owner_id);


--
-- Name: crm_meetings_silo_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_meetings_silo_idx ON public.crm_meetings USING btree (silo);


--
-- Name: crm_meetings_start_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_meetings_start_idx ON public.crm_meetings USING btree (start_at);


--
-- Name: crm_notes_company_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_notes_company_idx ON public.crm_notes USING btree (company_id);


--
-- Name: crm_notes_contact_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_notes_contact_idx ON public.crm_notes USING btree (contact_id);


--
-- Name: crm_notes_silo_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_notes_silo_idx ON public.crm_notes USING btree (silo);


--
-- Name: crm_segments_silo_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_segments_silo_idx ON public.crm_segments USING btree (silo);


--
-- Name: crm_task_staff_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_task_staff_created_idx ON public.crm_task USING btree (staff_id, created_at DESC);


--
-- Name: crm_tasks_assigned_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_tasks_assigned_idx ON public.crm_tasks USING btree (assigned_to);


--
-- Name: crm_tasks_company_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_tasks_company_idx ON public.crm_tasks USING btree (company_id);


--
-- Name: crm_tasks_contact_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_tasks_contact_idx ON public.crm_tasks USING btree (contact_id);


--
-- Name: crm_tasks_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_tasks_due_idx ON public.crm_tasks USING btree (due_at);


--
-- Name: crm_tasks_silo_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_tasks_silo_idx ON public.crm_tasks USING btree (silo);


--
-- Name: crm_timeline_application_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_timeline_application_idx ON public.crm_timeline_events USING btree (application_id, created_at DESC);


--
-- Name: crm_timeline_contact_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_timeline_contact_idx ON public.crm_timeline_events USING btree (contact_id, created_at DESC);


--
-- Name: crm_timeline_event_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_timeline_event_type_idx ON public.crm_timeline_events USING btree (event_type);


--
-- Name: document_ocr_fields_application_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX document_ocr_fields_application_id_idx ON public.document_ocr_fields USING btree (application_id);


--
-- Name: document_ocr_fields_document_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX document_ocr_fields_document_id_idx ON public.document_ocr_fields USING btree (document_id);


--
-- Name: document_version_reviews_status_reviewed_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX document_version_reviews_status_reviewed_idx ON public.document_version_reviews USING btree (status, reviewed_at);


--
-- Name: document_versions_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX document_versions_created_at_idx ON public.document_versions USING btree (created_at);


--
-- Name: documents_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX documents_created_at_idx ON public.documents USING btree (created_at);


--
-- Name: documents_detected_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX documents_detected_type_idx ON public.documents USING btree (detected_type);


--
-- Name: documents_offer_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX documents_offer_id_idx ON public.documents USING btree (offer_id);


--
-- Name: email_open_events_log_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX email_open_events_log_idx ON public.email_open_events USING btree (email_log_id);


--
-- Name: email_open_events_log_opened_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX email_open_events_log_opened_idx ON public.email_open_events USING btree (email_log_id, opened_at DESC);


--
-- Name: email_open_events_log_source_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX email_open_events_log_source_idx ON public.email_open_events USING btree (email_log_id, source);


--
-- Name: graph_mail_subs_user_resource_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX graph_mail_subs_user_resource_idx ON public.graph_mail_subscriptions USING btree (user_id, resource);


--
-- Name: graph_mail_subscriptions_sub_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX graph_mail_subscriptions_sub_id_idx ON public.graph_mail_subscriptions USING btree (subscription_id);


--
-- Name: graph_mail_subscriptions_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX graph_mail_subscriptions_user_idx ON public.graph_mail_subscriptions USING btree (user_id);


--
-- Name: idempotency_keys_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idempotency_keys_created_at_idx ON public.idempotency_keys USING btree (created_at);


--
-- Name: idempotency_keys_id_unique_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idempotency_keys_id_unique_idx ON public.idempotency_keys USING btree (id);


--
-- Name: idempotency_keys_key_route_unique_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idempotency_keys_key_route_unique_idx ON public.idempotency_keys USING btree (key, route);


--
-- Name: idx_ads_negatives_log_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ads_negatives_log_active ON public.ads_negatives_log USING btree (added_at DESC) WHERE (removed_at IS NULL);


--
-- Name: idx_ai_embeddings_source_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ai_embeddings_source_type ON public.ai_embeddings USING btree (source_type);


--
-- Name: idx_ai_escalations_status_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ai_escalations_status_created_at ON public.ai_escalations USING btree (status, created_at DESC);


--
-- Name: idx_ai_knowledge_source_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ai_knowledge_source_type ON public.ai_knowledge USING btree (source_type);


--
-- Name: idx_ai_messages_session_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ai_messages_session_created_at ON public.ai_messages USING btree (session_id, created_at);


--
-- Name: idx_analytics_events_event_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_analytics_events_event_created_at ON public.analytics_events USING btree (event, created_at DESC);


--
-- Name: idx_app_lender_selections_app; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_app_lender_selections_app ON public.application_lender_selections USING btree (application_id);


--
-- Name: idx_app_lender_selections_finalized_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_app_lender_selections_finalized_at ON public.application_lender_selections USING btree (application_id, finalized_at);


--
-- Name: idx_application_contacts_app; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_application_contacts_app ON public.application_contacts USING btree (application_id);


--
-- Name: idx_application_contacts_contact; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_application_contacts_contact ON public.application_contacts USING btree (contact_id);


--
-- Name: idx_application_form_responses_app; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_application_form_responses_app ON public.application_form_responses USING btree (application_id);


--
-- Name: idx_application_form_responses_submitted; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_application_form_responses_submitted ON public.application_form_responses USING btree (application_id) WHERE (submitted_at IS NOT NULL);


--
-- Name: idx_application_lender_responses_app; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_application_lender_responses_app ON public.application_lender_responses USING btree (application_id);


--
-- Name: idx_application_packages_app; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_application_packages_app ON public.application_packages USING btree (application_id);


--
-- Name: idx_application_tasks_app; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_application_tasks_app ON public.application_tasks USING btree (application_id);


--
-- Name: idx_application_tasks_open; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_application_tasks_open ON public.application_tasks USING btree (application_id) WHERE (status = 'open'::text);


--
-- Name: idx_applications_abandon_nudge; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_applications_abandon_nudge ON public.applications USING btree (updated_at) WHERE (submitted_at IS NULL);


--
-- Name: idx_applications_bi_application_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_applications_bi_application_id ON public.applications USING btree (bi_application_id) WHERE (bi_application_id IS NOT NULL);


--
-- Name: idx_applications_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_applications_company_id ON public.applications USING btree (company_id);


--
-- Name: idx_applications_last_portal_seen_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_applications_last_portal_seen_at ON public.applications USING btree (last_portal_seen_at) WHERE (last_portal_seen_at IS NOT NULL);


--
-- Name: idx_applications_lender_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_applications_lender_id ON public.applications USING btree (lender_id) WHERE (lender_id IS NOT NULL);


--
-- Name: idx_applications_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_applications_owner ON public.applications USING btree (owner_user_id);


--
-- Name: idx_applications_parked_stage; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_applications_parked_stage ON public.applications USING btree (silo, pipeline_state) WHERE (pipeline_state = ANY (ARRAY['Fraud'::text, 'Hold'::text]));


--
-- Name: idx_applications_pending_acceptance; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_applications_pending_acceptance ON public.applications USING btree (pending_acceptance_offer_id) WHERE (pending_acceptance_offer_id IS NOT NULL);


--
-- Name: idx_applications_signnow_document_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_applications_signnow_document_id ON public.applications USING btree (signnow_document_id);


--
-- Name: idx_arr_app; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_arr_app ON public.application_rejection_reasons USING btree (application_id);


--
-- Name: idx_arr_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_arr_unique ON public.application_rejection_reasons USING btree (application_id, COALESCE(lender_id, ''::text), reason_code);


--
-- Name: idx_baj_app; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_baj_app ON public.banking_analysis_jobs USING btree (application_id);


--
-- Name: idx_baj_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_baj_status ON public.banking_analysis_jobs USING btree (status);


--
-- Name: idx_banking_analysis_jobs_application; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_banking_analysis_jobs_application ON public.banking_analysis_jobs USING btree (application_id);


--
-- Name: idx_banking_analysis_jobs_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_banking_analysis_jobs_status ON public.banking_analysis_jobs USING btree (status);


--
-- Name: idx_banking_tx_app; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_banking_tx_app ON public.banking_transactions USING btree (application_id);


--
-- Name: idx_banking_tx_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_banking_tx_date ON public.banking_transactions USING btree (application_id, transaction_date);


--
-- Name: idx_calendar_tasks_assignee; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_calendar_tasks_assignee ON public.calendar_tasks USING btree (assignee_user_id);


--
-- Name: idx_calendar_tasks_due_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_calendar_tasks_due_at ON public.calendar_tasks USING btree (due_at);


--
-- Name: idx_calendar_tasks_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_calendar_tasks_status ON public.calendar_tasks USING btree (status);


--
-- Name: idx_calendar_tasks_user_silo; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_calendar_tasks_user_silo ON public.calendar_tasks USING btree (user_id, silo);


--
-- Name: idx_call_events_application; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_events_application ON public.call_events USING btree (application_id, occurred_at DESC);


--
-- Name: idx_call_events_contact; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_events_contact ON public.call_events USING btree (contact_id, occurred_at DESC);


--
-- Name: idx_call_events_sid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_events_sid ON public.call_events USING btree (twilio_call_sid);


--
-- Name: idx_call_events_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_events_user ON public.call_events USING btree (user_id, occurred_at DESC);


--
-- Name: idx_call_logs_application_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_logs_application_id ON public.call_logs USING btree (application_id);


--
-- Name: idx_call_logs_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_logs_status ON public.call_logs USING btree (status);


--
-- Name: idx_call_recordings_updated_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_recordings_updated_at ON public.call_recordings USING btree (updated_at);


--
-- Name: idx_call_transcripts_updated_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_transcripts_updated_at ON public.call_transcripts USING btree (updated_at);


--
-- Name: idx_client_device_credentials_phone; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_client_device_credentials_phone ON public.client_device_credentials USING btree (phone) WHERE (revoked_at IS NULL);


--
-- Name: idx_cm_silo_contact_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cm_silo_contact_created ON public.communications_messages USING btree (silo, contact_id, created_at DESC);


--
-- Name: idx_cm_silo_type_contact_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cm_silo_type_contact_created ON public.communications_messages USING btree (silo, type, contact_id, created_at DESC);


--
-- Name: idx_cm_unread_inbound; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cm_unread_inbound ON public.communications_messages USING btree (silo, contact_id) WHERE ((read_at IS NULL) AND (direction = 'inbound'::text));


--
-- Name: idx_collateral_silo; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_collateral_silo ON public.collateral_assets USING btree (silo, created_at DESC);


--
-- Name: idx_comm_messages_application_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_comm_messages_application_id ON public.communications_messages USING btree (application_id);


--
-- Name: idx_comm_messages_cta; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_comm_messages_cta ON public.communications_messages USING btree (application_id) WHERE (cta_action IS NOT NULL);


--
-- Name: idx_comm_msg_conv; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_comm_msg_conv ON public.communications_messages USING btree (conversation_id, created_at) WHERE (conversation_id IS NOT NULL);


--
-- Name: idx_comm_msg_silo_contact_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_comm_msg_silo_contact_created ON public.communications_messages USING btree (silo, contact_id, created_at DESC) WHERE ((type IS NULL) OR (type <> 'sms'::text));


--
-- Name: idx_communications_messages_read_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_communications_messages_read_at ON public.communications_messages USING btree (read_at);


--
-- Name: idx_companies_address_state; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_companies_address_state ON public.companies USING btree (address_state);


--
-- Name: idx_companies_email_lower_silo; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_companies_email_lower_silo ON public.companies USING btree (silo, lower(COALESCE(email, ''::text))) WHERE ((email IS NOT NULL) AND (email <> ''::text));


--
-- Name: idx_companies_legal_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_companies_legal_name ON public.companies USING btree (legal_name);


--
-- Name: idx_companies_lender_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_companies_lender_id ON public.companies USING btree (lender_id);


--
-- Name: idx_companies_name_lower_silo; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_companies_name_lower_silo ON public.companies USING btree (silo, lower(TRIM(BOTH FROM name)));


--
-- Name: idx_companies_phone_silo; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_companies_phone_silo ON public.companies USING btree (silo, phone) WHERE ((phone IS NOT NULL) AND (phone <> ''::text));


--
-- Name: idx_conferences_sid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_conferences_sid ON public.conferences USING btree (twilio_conference_sid);


--
-- Name: idx_conferences_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_conferences_status ON public.conferences USING btree (status);


--
-- Name: idx_conferences_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_conferences_user ON public.conferences USING btree (created_by_user_id, created_at DESC);


--
-- Name: idx_contact_ad_attribution_contact_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contact_ad_attribution_contact_id ON public.contact_ad_attribution USING btree (contact_id);


--
-- Name: idx_contact_ad_attribution_gclid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contact_ad_attribution_gclid ON public.contact_ad_attribution USING btree (gclid);


--
-- Name: idx_contact_documents_contact; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contact_documents_contact ON public.contact_documents USING btree (contact_id);


--
-- Name: idx_contact_documents_silo; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contact_documents_silo ON public.contact_documents USING btree (silo);


--
-- Name: idx_contact_leads_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contact_leads_created_at ON public.contact_leads USING btree (created_at DESC);


--
-- Name: idx_contacts_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contacts_company_id ON public.contacts USING btree (company_id);


--
-- Name: idx_contacts_consent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contacts_consent ON public.contacts USING btree (consent_basis, consent_at);


--
-- Name: idx_contacts_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contacts_email ON public.contacts USING btree (email);


--
-- Name: idx_contacts_is_primary; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contacts_is_primary ON public.contacts USING btree (is_primary_applicant);


--
-- Name: idx_contacts_owner_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contacts_owner_id ON public.contacts USING btree (owner_id);


--
-- Name: idx_contacts_phone; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contacts_phone ON public.contacts USING btree (phone);


--
-- Name: idx_contacts_role; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contacts_role ON public.contacts USING btree (role);


--
-- Name: idx_continuation_email_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_continuation_email_created_at ON public.continuation USING btree (email, created_at DESC);


--
-- Name: idx_continuation_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_continuation_token ON public.application_continuations USING btree (token);


--
-- Name: idx_conv_contact_phone; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_conv_contact_phone ON public.communications_conversations USING btree (contact_phone) WHERE (contact_phone IS NOT NULL);


--
-- Name: idx_conv_silo_channel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_conv_silo_channel ON public.communications_conversations USING btree (silo, channel, last_message_at DESC);


--
-- Name: idx_cparts_call_sid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cparts_call_sid ON public.conference_participants USING btree (twilio_call_sid);


--
-- Name: idx_cparts_conf; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cparts_conf ON public.conference_participants USING btree (conference_id);


--
-- Name: idx_cparts_identity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cparts_identity ON public.conference_participants USING btree (identity);


--
-- Name: idx_credit_summaries_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_credit_summaries_status ON public.credit_summaries USING btree (status);


--
-- Name: idx_credit_summary_jobs_application; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_credit_summary_jobs_application ON public.credit_summary_jobs USING btree (application_id);


--
-- Name: idx_credit_summary_jobs_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_credit_summary_jobs_status ON public.credit_summary_jobs USING btree (status);


--
-- Name: idx_credit_summary_versions_app; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_credit_summary_versions_app ON public.credit_summary_versions USING btree (application_id, version);


--
-- Name: idx_crm_email_log_followup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_email_log_followup ON public.crm_email_log USING btree (opened_at, followup_notified_at, created_at);


--
-- Name: idx_crm_email_log_opened; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_email_log_opened ON public.crm_email_log USING btree (owner_id, opened_at);


--
-- Name: idx_crm_email_log_pixel_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_email_log_pixel_token ON public.crm_email_log USING btree (pixel_token);


--
-- Name: idx_crm_leads_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_leads_created_at ON public.crm_leads USING btree (created_at DESC);


--
-- Name: idx_crm_leads_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_crm_leads_id ON public.crm_leads USING btree (id);


--
-- Name: idx_crm_leads_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_leads_source ON public.crm_leads USING btree (source);


--
-- Name: idx_crm_notes_application_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_notes_application_id ON public.crm_notes USING btree (application_id) WHERE (application_id IS NOT NULL);


--
-- Name: idx_crm_notes_mentions; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_notes_mentions ON public.crm_notes USING gin (mentions);


--
-- Name: idx_csj_app; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_csj_app ON public.credit_summary_jobs USING btree (application_id);


--
-- Name: idx_csj_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_csj_status ON public.credit_summary_jobs USING btree (status);


--
-- Name: idx_document_processing_jobs_application; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_processing_jobs_application ON public.document_processing_jobs USING btree (application_id);


--
-- Name: idx_document_processing_jobs_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_processing_jobs_status ON public.document_processing_jobs USING btree (status);


--
-- Name: idx_document_types_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_types_active ON public.document_types USING btree (active);


--
-- Name: idx_document_types_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_types_category ON public.document_types USING btree (category);


--
-- Name: idx_document_versions_document; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_versions_document ON public.document_versions USING btree (document_id);


--
-- Name: idx_documents_application; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_application ON public.documents USING btree (application_id);


--
-- Name: idx_documents_application_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_application_id ON public.documents USING btree (application_id);


--
-- Name: idx_documents_application_uploaded; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_application_uploaded ON public.documents USING btree (application_id, created_at DESC);


--
-- Name: idx_documents_banking_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_banking_status ON public.documents USING btree (banking_status);


--
-- Name: idx_documents_blob_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_blob_name ON public.documents USING btree (blob_name);


--
-- Name: idx_documents_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_category ON public.documents USING btree (application_id, category);


--
-- Name: idx_documents_ocr_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_ocr_status ON public.documents USING btree (ocr_status);


--
-- Name: idx_documents_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_owner ON public.documents USING btree (owner_user_id);


--
-- Name: idx_documents_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_status ON public.documents USING btree (status);


--
-- Name: idx_documents_tamper_unscanned; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_tamper_unscanned ON public.documents USING btree (created_at) WHERE (tamper_scanned_at IS NULL);


--
-- Name: idx_dpj_app; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dpj_app ON public.document_processing_jobs USING btree (application_id);


--
-- Name: idx_dpj_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dpj_status ON public.document_processing_jobs USING btree (status);


--
-- Name: idx_elc_clicked_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_elc_clicked_at ON public.email_link_clicks USING btree (clicked_at DESC);


--
-- Name: idx_elc_contact; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_elc_contact ON public.email_link_clicks USING btree (contact_id, clicked_at DESC);


--
-- Name: idx_elc_template; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_elc_template ON public.email_link_clicks USING btree (template_id, clicked_at DESC);


--
-- Name: idx_google_ads_daily_campaign; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_google_ads_daily_campaign ON public.google_ads_daily USING btree (level, campaign_id, stat_date DESC);


--
-- Name: idx_google_ads_daily_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_google_ads_daily_date ON public.google_ads_daily USING btree (stat_date DESC);


--
-- Name: idx_issue_reports_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_issue_reports_status ON public.issue_reports USING btree (status);


--
-- Name: idx_issues_contact; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_issues_contact ON public.issues USING btree (contact_id);


--
-- Name: idx_issues_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_issues_created ON public.issues USING btree (created_at DESC);


--
-- Name: idx_issues_silo_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_issues_silo_created ON public.issues USING btree (silo, created_at DESC);


--
-- Name: idx_issues_source_kind; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_issues_source_kind ON public.issues USING btree (source, kind);


--
-- Name: idx_issues_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_issues_status ON public.issues USING btree (status);


--
-- Name: idx_issues_status_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_issues_status_created ON public.issues USING btree (status, created_at DESC);


--
-- Name: idx_lender_email_bounces_app; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lender_email_bounces_app ON public.lender_email_bounces USING btree (application_id, lender_id);


--
-- Name: idx_lender_package_links_app; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lender_package_links_app ON public.lender_package_links USING btree (application_id, lender_id);


--
-- Name: idx_lender_product_requirements_stage; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lender_product_requirements_stage ON public.lender_product_requirements USING btree (stage);


--
-- Name: idx_lender_submissions_app; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lender_submissions_app ON public.lender_submissions USING btree (application_id);


--
-- Name: idx_lenders_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lenders_id ON public.lenders USING btree (id);


--
-- Name: idx_lenders_submission_method; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lenders_submission_method ON public.lenders USING btree (submission_method);


--
-- Name: idx_live_chat_requests_status_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_live_chat_requests_status_created_at ON public.live_chat_requests USING btree (status, created_at DESC);


--
-- Name: idx_maya_audit_audience_tool; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_maya_audit_audience_tool ON public.maya_audit USING btree (audience, tool);


--
-- Name: idx_maya_audit_ts; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_maya_audit_ts ON public.maya_audit USING btree (ts DESC);


--
-- Name: idx_maya_audit_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_maya_audit_user_id ON public.maya_audit USING btree (user_id) WHERE (user_id IS NOT NULL);


--
-- Name: idx_maya_escalations_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_maya_escalations_created ON public.maya_escalations USING btree (created_at DESC);


--
-- Name: idx_maya_escalations_session_recent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_maya_escalations_session_recent ON public.maya_escalations USING btree (session_id, created_at DESC);


--
-- Name: idx_messages_typing_updated_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messages_typing_updated_at ON public.messages_typing USING btree (updated_at);


--
-- Name: idx_mlp_silo; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mlp_silo ON public.marketing_landing_pages USING btree (silo, created_at DESC);


--
-- Name: idx_mlp_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mlp_slug ON public.marketing_landing_pages USING btree (slug);


--
-- Name: idx_msj_silo; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_msj_silo ON public.marketing_send_jobs USING btree (silo, created_at DESC);


--
-- Name: idx_msj_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_msj_status ON public.marketing_send_jobs USING btree (status, created_at);


--
-- Name: idx_mtpl_silo_channel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mtpl_silo_channel ON public.marketing_template USING btree (silo, channel, updated_at DESC);


--
-- Name: idx_notifications_user_unread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notifications_user_unread ON public.notifications USING btree (user_id, is_read, created_at DESC);


--
-- Name: idx_ocr_results_application; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ocr_results_application ON public.ocr_results USING btree (application_id);


--
-- Name: idx_ocr_results_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ocr_results_status ON public.ocr_results USING btree (status);


--
-- Name: idx_offers_application_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_offers_application_active ON public.offers USING btree (application_id) WHERE (is_archived = false);


--
-- Name: idx_offers_application_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_offers_application_id ON public.offers USING btree (application_id, created_at DESC);


--
-- Name: idx_offers_application_lender_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_offers_application_lender_active ON public.offers USING btree (application_id, lender_id) WHERE (is_archived = false);


--
-- Name: idx_otp_phone; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_otp_phone ON public.otp_sessions USING btree (phone);


--
-- Name: idx_otp_verifications_phone_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_otp_verifications_phone_created ON public.otp_verifications USING btree (phone, created_at DESC);


--
-- Name: idx_owners_borrower_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_owners_borrower_id ON public.owners USING btree (borrower_id);


--
-- Name: idx_pre_applications_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pre_applications_created_at ON public.pre_applications USING btree (created_at DESC);


--
-- Name: idx_pwa_notifications_user_delivered; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pwa_notifications_user_delivered ON public.pwa_notifications USING btree (user_id, delivered_at DESC);


--
-- Name: idx_pwa_notifications_user_hash_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pwa_notifications_user_hash_time ON public.pwa_notifications USING btree (user_id, payload_hash, delivered_at DESC);


--
-- Name: idx_pwa_notifications_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pwa_notifications_user_id ON public.pwa_notifications USING btree (user_id);


--
-- Name: idx_pwa_subscriptions_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pwa_subscriptions_user_id ON public.pwa_subscriptions USING btree (user_id);


--
-- Name: idx_qa_questions_set; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_qa_questions_set ON public.qa_questions USING btree (set_id);


--
-- Name: idx_qa_sets_application; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_qa_sets_application ON public.qa_sets USING btree (application_id);


--
-- Name: idx_recordings_conf; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_recordings_conf ON public.call_recordings USING btree (conference_id);


--
-- Name: idx_scheduled_emails_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_scheduled_emails_due ON public.scheduled_emails USING btree (status, send_at);


--
-- Name: idx_scheduled_emails_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_scheduled_emails_user ON public.scheduled_emails USING btree (user_id, status);


--
-- Name: idx_seqenroll_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_seqenroll_due ON public.marketing_sequence_enrollments USING btree (status, next_run_at);


--
-- Name: idx_seqstep_seq; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_seqstep_seq ON public.marketing_sequence_steps USING btree (sequence_id, step_order);


--
-- Name: idx_sms_deliveries_app_kind; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sms_deliveries_app_kind ON public.sms_deliveries USING btree (application_id, kind, created_at DESC);


--
-- Name: idx_staff_device_credentials_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_device_credentials_user ON public.staff_device_credentials USING btree (user_id) WHERE (revoked_at IS NULL);


--
-- Name: idx_staff_presence_status_available; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_presence_status_available ON public.staff_presence USING btree (status) WHERE (status = 'available'::text);


--
-- Name: idx_task_queues_silo; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_task_queues_silo ON public.task_queues USING btree (silo);


--
-- Name: idx_tasks_assignee; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tasks_assignee ON public.tasks USING btree (assignee_user_id);


--
-- Name: idx_tasks_contact; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tasks_contact ON public.tasks USING btree (contact_id);


--
-- Name: idx_tasks_queue; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tasks_queue ON public.tasks USING btree (queue_id);


--
-- Name: idx_tasks_silo_status_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tasks_silo_status_due ON public.tasks USING btree (silo, status, due_at);


--
-- Name: idx_templates_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_templates_lookup ON public.message_templates USING btree (silo, channel);


--
-- Name: idx_templates_shortcut; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_templates_shortcut ON public.message_templates USING btree (silo, COALESCE(owner_user_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(shortcut)) WHERE (shortcut IS NOT NULL);


--
-- Name: idx_templates_snippets; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_templates_snippets ON public.message_templates USING btree (silo, channel, is_snippet);


--
-- Name: idx_transcripts_conf; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transcripts_conf ON public.call_transcripts USING btree (conference_id);


--
-- Name: idx_tse_contact; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tse_contact ON public.template_send_events USING btree (contact_id, sent_at DESC);


--
-- Name: idx_tse_template; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tse_template ON public.template_send_events USING btree (template_id);


--
-- Name: idx_users_active_not_deleted; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_active_not_deleted ON public.users USING btree (id) WHERE (deleted_at IS NULL);


--
-- Name: idx_users_lender_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_lender_id ON public.users USING btree (lender_id) WHERE (lender_id IS NOT NULL);


--
-- Name: idx_visitor_events_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_visitor_events_session ON public.visitor_events USING btree (session_id, occurred_at);


--
-- Name: idx_visitor_events_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_visitor_events_type ON public.visitor_events USING btree (event_type);


--
-- Name: idx_visitor_sessions_contact; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_visitor_sessions_contact ON public.visitor_sessions USING btree (contact_id);


--
-- Name: idx_visitor_sessions_gclid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_visitor_sessions_gclid ON public.visitor_sessions USING btree (gclid);


--
-- Name: idx_wbe_app; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wbe_app ON public.wizard_block_events USING btree (application_id);


--
-- Name: idx_wbe_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wbe_created ON public.wizard_block_events USING btree (created_at DESC);


--
-- Name: idx_wbe_session_reason; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_wbe_session_reason ON public.wizard_block_events USING btree (COALESCE(session_key, (id)::text), reason);


--
-- Name: idx_webauthn_challenges_challenge; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_webauthn_challenges_challenge ON public.webauthn_challenges USING btree (challenge);


--
-- Name: idx_webauthn_challenges_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_webauthn_challenges_user ON public.webauthn_challenges USING btree (user_id);


--
-- Name: idx_webauthn_credentials_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_webauthn_credentials_user ON public.webauthn_credentials USING btree (user_id);


--
-- Name: inbound_attachment_attempts_last_attempt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX inbound_attachment_attempts_last_attempt_idx ON public.inbound_attachment_attempts USING btree (last_attempt_at);


--
-- Name: job_queue_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX job_queue_created_idx ON public.job_queue USING btree (created_at DESC);


--
-- Name: job_queue_lender_package_dedup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX job_queue_lender_package_dedup_idx ON public.job_queue USING btree (((payload ->> 'applicationId'::text))) WHERE ((type = 'send_lender_package'::text) AND (status = ANY (ARRAY['pending'::text, 'running'::text])));


--
-- Name: job_queue_next_attempt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX job_queue_next_attempt_idx ON public.job_queue USING btree (next_attempt_at) WHERE (status = 'pending'::text);


--
-- Name: job_queue_ready_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX job_queue_ready_idx ON public.job_queue USING btree (type, status, next_attempt_at);


--
-- Name: job_queue_status_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX job_queue_status_type_idx ON public.job_queue USING btree (status, type) WHERE (status = ANY (ARRAY['pending'::text, 'running'::text]));


--
-- Name: lender_docs_lender_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX lender_docs_lender_idx ON public.lender_documents USING btree (lender_id);


--
-- Name: lender_product_requirements_document_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX lender_product_requirements_document_type_idx ON public.lender_product_requirements USING btree (document_type);


--
-- Name: lender_product_requirements_lender_product_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX lender_product_requirements_lender_product_id_idx ON public.lender_product_requirements USING btree (lender_product_id);


--
-- Name: lender_products_rate_kind_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX lender_products_rate_kind_idx ON public.lender_products USING btree (rate_kind);


--
-- Name: lender_products_silo_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX lender_products_silo_idx ON public.lender_products USING btree (silo);


--
-- Name: lender_submissions_application_lender_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX lender_submissions_application_lender_unique ON public.lender_submissions USING btree (application_id, lender_id);


--
-- Name: lender_submissions_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX lender_submissions_created_at_idx ON public.lender_submissions USING btree (created_at);


--
-- Name: lender_submissions_idempotency_key_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX lender_submissions_idempotency_key_unique ON public.lender_submissions USING btree (idempotency_key) WHERE (idempotency_key IS NOT NULL);


--
-- Name: lender_submissions_lender_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX lender_submissions_lender_created_idx ON public.lender_submissions USING btree (lender_id, created_at);


--
-- Name: lender_submissions_lender_submitted_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX lender_submissions_lender_submitted_idx ON public.lender_submissions USING btree (lender_id, submitted_at);


--
-- Name: lender_submissions_submitted_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX lender_submissions_submitted_at_idx ON public.lender_submissions USING btree (submitted_at);


--
-- Name: lenders_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX lenders_active_idx ON public.lenders USING btree (active);


--
-- Name: lenders_silo_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX lenders_silo_idx ON public.lenders USING btree (silo);


--
-- Name: naics_codes_country_code_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX naics_codes_country_code_idx ON public.naics_codes USING btree (country, code);


--
-- Name: naics_codes_title_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX naics_codes_title_idx ON public.naics_codes USING btree (lower(title));


--
-- Name: ocr_jobs_document_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ocr_jobs_document_id_idx ON public.ocr_jobs USING btree (document_id);


--
-- Name: ocr_jobs_status_next_attempt_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ocr_jobs_status_next_attempt_at_idx ON public.ocr_jobs USING btree (status, next_attempt_at);


--
-- Name: ocr_results_application_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ocr_results_application_id_idx ON public.ocr_results USING btree (application_id);


--
-- Name: ocr_results_document_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ocr_results_document_id_idx ON public.ocr_document_results USING btree (document_id);


--
-- Name: ocr_results_field_key_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ocr_results_field_key_idx ON public.ocr_results USING btree (field_key);


--
-- Name: otp_codes_phone_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX otp_codes_phone_idx ON public.otp_codes USING btree (phone);


--
-- Name: otp_verifications_phone_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX otp_verifications_phone_idx ON public.otp_verifications USING btree (phone);


--
-- Name: otp_verifications_user_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX otp_verifications_user_status_idx ON public.otp_verifications USING btree (user_id, status);


--
-- Name: portal_errors_fingerprint_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX portal_errors_fingerprint_idx ON public.portal_errors USING btree (fingerprint);


--
-- Name: portal_errors_recent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX portal_errors_recent_idx ON public.portal_errors USING btree (last_seen_at DESC);


--
-- Name: readiness_sessions_email_active_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX readiness_sessions_email_active_uniq ON public.readiness_sessions USING btree (lower(email)) WHERE (is_active = true);


--
-- Name: readiness_sessions_email_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX readiness_sessions_email_idx ON public.readiness_sessions USING btree (email);


--
-- Name: readiness_sessions_expires_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX readiness_sessions_expires_at_idx ON public.readiness_sessions USING btree (expires_at);


--
-- Name: readiness_sessions_phone_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX readiness_sessions_phone_active_idx ON public.readiness_sessions USING btree (phone) WHERE (is_active = true);


--
-- Name: readiness_sessions_phone_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX readiness_sessions_phone_idx ON public.readiness_sessions USING btree (phone);


--
-- Name: readiness_sessions_token_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX readiness_sessions_token_idx ON public.readiness_sessions USING btree (token);


--
-- Name: referral_conversions_application_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX referral_conversions_application_uidx ON public.referral_conversions USING btree (application_id) WHERE (application_id IS NOT NULL);


--
-- Name: referral_conversions_external_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX referral_conversions_external_uidx ON public.referral_conversions USING btree (source_silo, external_application_id) WHERE (external_application_id IS NOT NULL);


--
-- Name: reporting_application_volume_daily_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reporting_application_volume_daily_idx ON public.reporting_application_volume_daily USING btree (metric_date, product_type);


--
-- Name: reporting_daily_metrics_metric_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reporting_daily_metrics_metric_date_idx ON public.reporting_daily_metrics USING btree (metric_date);


--
-- Name: reporting_document_metrics_daily_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reporting_document_metrics_daily_idx ON public.reporting_document_metrics_daily USING btree (metric_date, document_type);


--
-- Name: reporting_lender_funnel_daily_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reporting_lender_funnel_daily_idx ON public.reporting_lender_funnel_daily USING btree (metric_date, lender_id);


--
-- Name: reporting_lender_performance_period_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reporting_lender_performance_period_idx ON public.reporting_lender_performance USING btree (lender_id, period_start, period_end);


--
-- Name: reporting_lender_performance_unique_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX reporting_lender_performance_unique_idx ON public.reporting_lender_performance USING btree (lender_id, period_start, period_end);


--
-- Name: reporting_pipeline_daily_snapshot_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reporting_pipeline_daily_snapshot_idx ON public.reporting_pipeline_daily_snapshots USING btree (snapshot_date, pipeline_state);


--
-- Name: reporting_pipeline_snapshots_snapshot_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reporting_pipeline_snapshots_snapshot_idx ON public.reporting_pipeline_snapshots USING btree (snapshot_at, pipeline_state);


--
-- Name: reporting_staff_activity_daily_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reporting_staff_activity_daily_idx ON public.reporting_staff_activity_daily USING btree (metric_date, staff_user_id, action);


--
-- Name: sequence_sends_contact_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sequence_sends_contact_idx ON public.sequence_sends USING btree (contact_id, clicked_at);


--
-- Name: sequence_sends_sid_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sequence_sends_sid_idx ON public.sequence_sends USING btree (message_sid);


--
-- Name: shared_mailbox_address_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX shared_mailbox_address_uidx ON public.shared_mailbox_settings USING btree (lower(address), silo);


--
-- Name: sms_sends_cascade_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sms_sends_cascade_idx ON public.sms_campaign_sends USING btree (sent_at) WHERE ((fallback_sent = false) AND (clicked_at IS NULL));


--
-- Name: sms_sends_sid_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sms_sends_sid_idx ON public.sms_campaign_sends USING btree (message_sid);


--
-- Name: staff_presence_heartbeat_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX staff_presence_heartbeat_idx ON public.staff_presence USING btree (last_heartbeat);


--
-- Name: staff_presence_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX staff_presence_status_idx ON public.staff_presence USING btree (status);


--
-- Name: submit_attempts_status_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX submit_attempts_status_created_idx ON public.submit_attempts USING btree (status, created_at DESC);


--
-- Name: tasks_assignee_due_open_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tasks_assignee_due_open_idx ON public.tasks USING btree (assignee_user_id, due_at) WHERE (status <> 'COMPLETED'::text);


--
-- Name: team_channel_members_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX team_channel_members_user_idx ON public.team_channel_members USING btree (user_id);


--
-- Name: team_channels_dm_key_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX team_channels_dm_key_uidx ON public.team_channels USING btree (dm_key) WHERE (dm_key IS NOT NULL);


--
-- Name: team_message_reactions_msg_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX team_message_reactions_msg_idx ON public.team_message_reactions USING btree (message_id);


--
-- Name: team_messages_channel_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX team_messages_channel_idx ON public.team_messages USING btree (channel_id, created_at DESC);


--
-- Name: team_messages_pinned_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX team_messages_pinned_idx ON public.team_messages USING btree (channel_id) WHERE (pinned_at IS NOT NULL);


--
-- Name: teams_meetings_contact_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX teams_meetings_contact_idx ON public.teams_meetings USING btree (contact_id, silo);


--
-- Name: teams_meetings_graph_event_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX teams_meetings_graph_event_uidx ON public.teams_meetings USING btree (graph_event_id);


--
-- Name: teams_meetings_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX teams_meetings_status_idx ON public.teams_meetings USING btree (status, scheduled_end_at);


--
-- Name: uniq_app_packages_app_lender; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_app_packages_app_lender ON public.application_packages USING btree (application_id, lender_id);


--
-- Name: uniq_lender_email_bounces_ndr; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_lender_email_bounces_ndr ON public.lender_email_bounces USING btree (ndr_message_id);


--
-- Name: uq_app_doc_waiver; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_app_doc_waiver ON public.application_document_waivers USING btree (application_id, document_type);


--
-- Name: uq_comm_msg_twilio_sid; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_comm_msg_twilio_sid ON public.communications_messages USING btree (twilio_message_sid) WHERE (twilio_message_sid IS NOT NULL);


--
-- Name: uq_companies_lender_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_companies_lender_id ON public.companies USING btree (lender_id) WHERE (lender_id IS NOT NULL);


--
-- Name: uq_companies_lender_id_not_null; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_companies_lender_id_not_null ON public.companies USING btree (lender_id) WHERE (lender_id IS NOT NULL);


--
-- Name: uq_contact_documents_dedupe; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_contact_documents_dedupe ON public.contact_documents USING btree (silo, source_message_id, filename) WHERE (source_message_id IS NOT NULL);


--
-- Name: uq_google_ads_daily_v414; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_google_ads_daily_v414 ON public.google_ads_daily USING btree (stat_date, level, name, COALESCE(campaign_id, ''::text));


--
-- Name: users_email_unique_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX users_email_unique_idx ON public.users USING btree (email);


--
-- Name: users_o365_account_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX users_o365_account_idx ON public.users USING btree (o365_account_id);


--
-- Name: users_silos_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX users_silos_gin_idx ON public.users USING gin (silos);


--
-- Name: voicemails_call_sid_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX voicemails_call_sid_idx ON public.voicemails USING btree (call_sid);


--
-- Name: voicemails_client_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX voicemails_client_id_idx ON public.voicemails USING btree (client_id);


--
-- Name: voicemails_contact_id_idx2; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX voicemails_contact_id_idx2 ON public.voicemails USING btree (contact_id);


--
-- Name: voicemails_recording_sid_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX voicemails_recording_sid_uq ON public.voicemails USING btree (recording_sid);


--
-- Name: voicemails_staff_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX voicemails_staff_user_id_idx ON public.voicemails USING btree (staff_user_id);


--
-- Name: watch_calls_staff_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX watch_calls_staff_idx ON public.watch_call_bridges USING btree (staff_user_id, created_at DESC);


--
-- Name: watch_devices_staff_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX watch_devices_staff_idx ON public.watch_devices USING btree (staff_user_id) WHERE (revoked_at IS NULL);


--
-- Name: lender_products trg_sba_attach_stage2; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_sba_attach_stage2 AFTER INSERT OR UPDATE OF type ON public.lender_products FOR EACH ROW EXECUTE FUNCTION public.sba_attach_stage2_requirements();


--
-- Name: lender_products trg_sba_merge_stage2_json; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_sba_merge_stage2_json BEFORE INSERT OR UPDATE OF type ON public.lender_products FOR EACH ROW EXECUTE FUNCTION public.sba_merge_stage2_into_product_json();


--
-- Name: ai_escalations ai_escalations_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_escalations
    ADD CONSTRAINT ai_escalations_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.chat_sessions(id) ON DELETE SET NULL;


--
-- Name: ai_issues ai_issues_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_issues
    ADD CONSTRAINT ai_issues_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.ai_sessions(id);


--
-- Name: ai_messages ai_messages_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_messages
    ADD CONSTRAINT ai_messages_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.ai_sessions(id) ON DELETE CASCADE;


--
-- Name: application_contacts application_contacts_application_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.application_contacts
    ADD CONSTRAINT application_contacts_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.applications(id) ON DELETE SET NULL;


--
-- Name: application_required_documents application_required_documents_application_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.application_required_documents
    ADD CONSTRAINT application_required_documents_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.applications(id) ON DELETE CASCADE;


--
-- Name: application_stage_events application_stage_events_application_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.application_stage_events
    ADD CONSTRAINT application_stage_events_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.applications(id) ON DELETE CASCADE;


--
-- Name: application_stage_history application_stage_history_application_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.application_stage_history
    ADD CONSTRAINT application_stage_history_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.applications(id) ON DELETE CASCADE;


--
-- Name: applications applications_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.applications
    ADD CONSTRAINT applications_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE SET NULL;


--
-- Name: applications applications_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.applications
    ADD CONSTRAINT applications_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;


--
-- Name: applications applications_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.applications
    ADD CONSTRAINT applications_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: applications applications_parent_application_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.applications
    ADD CONSTRAINT applications_parent_application_id_fkey FOREIGN KEY (parent_application_id) REFERENCES public.applications(id) ON DELETE SET NULL;


--
-- Name: audit_events audit_events_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_events
    ADD CONSTRAINT audit_events_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: audit_events audit_events_target_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_events
    ADD CONSTRAINT audit_events_target_user_id_fkey FOREIGN KEY (target_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: audit_events audit_events_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_events
    ADD CONSTRAINT audit_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: audit_logs audit_logs_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: auth_refresh_tokens auth_refresh_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_refresh_tokens
    ADD CONSTRAINT auth_refresh_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: banking_analyses banking_analyses_application_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.banking_analyses
    ADD CONSTRAINT banking_analyses_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.applications(id) ON DELETE CASCADE;


--
-- Name: banking_analysis_jobs banking_analysis_jobs_application_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.banking_analysis_jobs
    ADD CONSTRAINT banking_analysis_jobs_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.applications(id) ON DELETE SET NULL;


--
-- Name: banking_monthly_summaries banking_monthly_summaries_application_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.banking_monthly_summaries
    ADD CONSTRAINT banking_monthly_summaries_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.applications(id) ON DELETE CASCADE;


--
-- Name: banking_transactions banking_transactions_application_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.banking_transactions
    ADD CONSTRAINT banking_transactions_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.applications(id) ON DELETE CASCADE;


--
-- Name: borrowers borrowers_application_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.borrowers
    ADD CONSTRAINT borrowers_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.applications(id) ON DELETE CASCADE;


--
-- Name: call_logs call_logs_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_logs
    ADD CONSTRAINT call_logs_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;


--
-- Name: call_logs call_logs_staff_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_logs
    ADD CONSTRAINT call_logs_staff_user_id_fkey FOREIGN KEY (staff_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: call_recordings call_recordings_conference_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_recordings
    ADD CONSTRAINT call_recordings_conference_id_fkey FOREIGN KEY (conference_id) REFERENCES public.conferences(id) ON DELETE CASCADE;


--
-- Name: call_transcripts call_transcripts_conference_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_transcripts
    ADD CONSTRAINT call_transcripts_conference_id_fkey FOREIGN KEY (conference_id) REFERENCES public.conferences(id) ON DELETE CASCADE;


--
-- Name: chat_queue chat_queue_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_queue
    ADD CONSTRAINT chat_queue_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.chat_sessions(id);


--
-- Name: client_issues client_issues_application_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_issues
    ADD CONSTRAINT client_issues_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.applications(id) ON DELETE SET NULL;


--
-- Name: client_submissions client_submissions_application_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_submissions
    ADD CONSTRAINT client_submissions_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.applications(id) ON DELETE CASCADE;


--
-- Name: collateral collateral_borrower_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collateral
    ADD CONSTRAINT collateral_borrower_id_fkey FOREIGN KEY (borrower_id) REFERENCES public.borrowers(id) ON DELETE CASCADE;


--
-- Name: companies companies_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.companies
    ADD CONSTRAINT companies_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: companies companies_referrer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.companies
    ADD CONSTRAINT companies_referrer_id_fkey FOREIGN KEY (referrer_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: conference_participants conference_participants_conference_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conference_participants
    ADD CONSTRAINT conference_participants_conference_id_fkey FOREIGN KEY (conference_id) REFERENCES public.conferences(id) ON DELETE CASCADE;


--
-- Name: contact_ad_attribution contact_ad_attribution_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_ad_attribution
    ADD CONSTRAINT contact_ad_attribution_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE;


--
-- Name: contact_documents contact_documents_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_documents
    ADD CONSTRAINT contact_documents_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE;


--
-- Name: contacts contacts_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE SET NULL;


--
-- Name: contacts contacts_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: contacts contacts_referrer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_referrer_id_fkey FOREIGN KEY (referrer_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: contacts contacts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: continuation_sessions continuation_sessions_application_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuation_sessions
    ADD CONSTRAINT continuation_sessions_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.applications(id) ON DELETE SET NULL;


--
-- Name: credit_summaries credit_summaries_application_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_summaries
    ADD CONSTRAINT credit_summaries_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.applications(id) ON DELETE CASCADE;


--
-- Name: credit_summary_versions credit_summary_versions_credit_summary_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_summary_versions
    ADD CONSTRAINT credit_summary_versions_credit_summary_id_fkey FOREIGN KEY (credit_summary_id) REFERENCES public.credit_summaries(id) ON DELETE CASCADE;


--
-- Name: crm_call_log crm_call_log_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_call_log
    ADD CONSTRAINT crm_call_log_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE SET NULL;


--
-- Name: crm_call_log crm_call_log_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_call_log
    ADD CONSTRAINT crm_call_log_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;


--
-- Name: crm_call_log crm_call_log_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_call_log
    ADD CONSTRAINT crm_call_log_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: crm_email_log crm_email_log_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_email_log
    ADD CONSTRAINT crm_email_log_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE SET NULL;


--
-- Name: crm_email_log crm_email_log_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_email_log
    ADD CONSTRAINT crm_email_log_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;


--
-- Name: crm_email_log crm_email_log_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_email_log
    ADD CONSTRAINT crm_email_log_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: crm_lead_activities crm_lead_activities_lead_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_lead_activities
    ADD CONSTRAINT crm_lead_activities_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES public.crm_leads(id) ON DELETE CASCADE;


--
-- Name: crm_meetings crm_meetings_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_meetings
    ADD CONSTRAINT crm_meetings_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE SET NULL;


--
-- Name: crm_meetings crm_meetings_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_meetings
    ADD CONSTRAINT crm_meetings_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;


--
-- Name: crm_meetings crm_meetings_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_meetings
    ADD CONSTRAINT crm_meetings_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: crm_notes crm_notes_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_notes
    ADD CONSTRAINT crm_notes_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: crm_notes crm_notes_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_notes
    ADD CONSTRAINT crm_notes_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE;


--
-- Name: crm_notes crm_notes_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_notes
    ADD CONSTRAINT crm_notes_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: crm_segments crm_segments_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_segments
    ADD CONSTRAINT crm_segments_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: crm_task crm_task_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_task
    ADD CONSTRAINT crm_task_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: crm_tasks crm_tasks_assigned_to_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_tasks
    ADD CONSTRAINT crm_tasks_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: crm_tasks crm_tasks_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_tasks
    ADD CONSTRAINT crm_tasks_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE SET NULL;


--
-- Name: crm_tasks crm_tasks_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_tasks
    ADD CONSTRAINT crm_tasks_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;


--
-- Name: crm_tasks crm_tasks_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_tasks
    ADD CONSTRAINT crm_tasks_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: crm_timeline_events crm_timeline_events_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_timeline_events
    ADD CONSTRAINT crm_timeline_events_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: crm_timeline_events crm_timeline_events_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_timeline_events
    ADD CONSTRAINT crm_timeline_events_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE;


--
-- Name: document_ocr_fields document_ocr_fields_application_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_ocr_fields
    ADD CONSTRAINT document_ocr_fields_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.applications(id) ON DELETE CASCADE;


--
-- Name: document_ocr_fields document_ocr_fields_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_ocr_fields
    ADD CONSTRAINT document_ocr_fields_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;


--
-- Name: document_processing_jobs document_processing_jobs_application_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_processing_jobs
    ADD CONSTRAINT document_processing_jobs_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.applications(id) ON DELETE SET NULL;


--
-- Name: document_version_reviews document_version_reviews_document_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_version_reviews
    ADD CONSTRAINT document_version_reviews_document_version_id_fkey FOREIGN KEY (document_version_id) REFERENCES public.document_versions(id) ON DELETE CASCADE;


--
-- Name: document_version_reviews document_version_reviews_reviewed_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_version_reviews
    ADD CONSTRAINT document_version_reviews_reviewed_by_user_id_fkey FOREIGN KEY (reviewed_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: document_versions document_versions_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_versions
    ADD CONSTRAINT document_versions_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;


--
-- Name: documents documents_application_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.applications(id) ON DELETE CASCADE;


--
-- Name: documents documents_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: financials financials_borrower_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.financials
    ADD CONSTRAINT financials_borrower_id_fkey FOREIGN KEY (borrower_id) REFERENCES public.borrowers(id) ON DELETE CASCADE;


--
-- Name: issues issues_application_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.issues
    ADD CONSTRAINT issues_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.applications(id) ON DELETE SET NULL;


--
-- Name: issues issues_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.issues
    ADD CONSTRAINT issues_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;


--
-- Name: lender_documents lender_documents_lender_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lender_documents
    ADD CONSTRAINT lender_documents_lender_id_fkey FOREIGN KEY (lender_id) REFERENCES public.lenders(id) ON DELETE CASCADE;


--
-- Name: lender_documents lender_documents_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lender_documents
    ADD CONSTRAINT lender_documents_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: lender_product_requirements lender_product_requirements_lender_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lender_product_requirements
    ADD CONSTRAINT lender_product_requirements_lender_product_id_fkey FOREIGN KEY (lender_product_id) REFERENCES public.lender_products(id) ON DELETE CASCADE;


--
-- Name: lender_products lender_products_lender_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lender_products
    ADD CONSTRAINT lender_products_lender_id_fkey FOREIGN KEY (lender_id) REFERENCES public.lenders(id) ON DELETE CASCADE;


--
-- Name: lender_submission_retries lender_submission_retries_submission_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lender_submission_retries
    ADD CONSTRAINT lender_submission_retries_submission_id_fkey FOREIGN KEY (submission_id) REFERENCES public.lender_submissions(id) ON DELETE CASCADE;


--
-- Name: lender_submissions lender_submissions_application_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lender_submissions
    ADD CONSTRAINT lender_submissions_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.applications(id) ON DELETE CASCADE;


--
-- Name: maya_escalations maya_escalations_application_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maya_escalations
    ADD CONSTRAINT maya_escalations_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.applications(id) ON DELETE SET NULL;


--
-- Name: notifications notifications_application_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.applications(id) ON DELETE SET NULL;


--
-- Name: notifications notifications_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: ocr_document_results ocr_document_results_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ocr_document_results
    ADD CONSTRAINT ocr_document_results_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;


--
-- Name: ocr_jobs ocr_jobs_application_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ocr_jobs
    ADD CONSTRAINT ocr_jobs_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.applications(id) ON DELETE CASCADE;


--
-- Name: ocr_jobs ocr_jobs_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ocr_jobs
    ADD CONSTRAINT ocr_jobs_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;


--
-- Name: ocr_results ocr_results_application_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ocr_results
    ADD CONSTRAINT ocr_results_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.applications(id) ON DELETE CASCADE;


--
-- Name: ocr_results ocr_results_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ocr_results
    ADD CONSTRAINT ocr_results_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;


--
-- Name: ocr_results ocr_results_document_id_fkey1; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ocr_results
    ADD CONSTRAINT ocr_results_document_id_fkey1 FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;


--
-- Name: offers offers_application_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.offers
    ADD CONSTRAINT offers_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.applications(id) ON DELETE CASCADE;


--
-- Name: offers offers_lender_submission_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.offers
    ADD CONSTRAINT offers_lender_submission_id_fkey FOREIGN KEY (lender_submission_id) REFERENCES public.lender_submissions(id) ON DELETE SET NULL;


--
-- Name: ops_replay_events ops_replay_events_replay_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ops_replay_events
    ADD CONSTRAINT ops_replay_events_replay_job_id_fkey FOREIGN KEY (replay_job_id) REFERENCES public.ops_replay_jobs(id) ON DELETE CASCADE;


--
-- Name: otp_verifications otp_verifications_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.otp_verifications
    ADD CONSTRAINT otp_verifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: owners owners_borrower_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.owners
    ADD CONSTRAINT owners_borrower_id_fkey FOREIGN KEY (borrower_id) REFERENCES public.borrowers(id) ON DELETE CASCADE;


--
-- Name: password_resets password_resets_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_resets
    ADD CONSTRAINT password_resets_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: pwa_notifications pwa_notifications_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pwa_notifications
    ADD CONSTRAINT pwa_notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: pwa_subscriptions pwa_subscriptions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pwa_subscriptions
    ADD CONSTRAINT pwa_subscriptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: readiness_application_mappings readiness_application_mappings_application_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.readiness_application_mappings
    ADD CONSTRAINT readiness_application_mappings_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.applications(id) ON DELETE SET NULL;


--
-- Name: readiness_application_mappings readiness_application_mappings_readiness_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.readiness_application_mappings
    ADD CONSTRAINT readiness_application_mappings_readiness_session_id_fkey FOREIGN KEY (readiness_session_id) REFERENCES public.readiness_sessions(id) ON DELETE CASCADE;


--
-- Name: reporting_staff_activity_daily reporting_staff_activity_daily_staff_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reporting_staff_activity_daily
    ADD CONSTRAINT reporting_staff_activity_daily_staff_user_id_fkey FOREIGN KEY (staff_user_id) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: sms_campaign_sends sms_campaign_sends_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sms_campaign_sends
    ADD CONSTRAINT sms_campaign_sends_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.sms_campaigns(id) ON DELETE CASCADE;


--
-- Name: sms_campaign_sends sms_campaign_sends_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sms_campaign_sends
    ADD CONSTRAINT sms_campaign_sends_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE;


--
-- Name: staff_presence staff_presence_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_presence
    ADD CONSTRAINT staff_presence_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: task_queue_shares task_queue_shares_queue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_queue_shares
    ADD CONSTRAINT task_queue_shares_queue_id_fkey FOREIGN KEY (queue_id) REFERENCES public.task_queues(id) ON DELETE CASCADE;


--
-- Name: task_queue_shares task_queue_shares_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_queue_shares
    ADD CONSTRAINT task_queue_shares_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: task_queues task_queues_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_queues
    ADD CONSTRAINT task_queues_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: tasks tasks_assignee_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_assignee_user_id_fkey FOREIGN KEY (assignee_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: tasks tasks_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE SET NULL;


--
-- Name: tasks tasks_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;


--
-- Name: tasks tasks_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: tasks tasks_queue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_queue_id_fkey FOREIGN KEY (queue_id) REFERENCES public.task_queues(id) ON DELETE SET NULL;


--
-- Name: tasks tasks_repeat_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_repeat_parent_id_fkey FOREIGN KEY (repeat_parent_id) REFERENCES public.tasks(id) ON DELETE SET NULL;


--
-- Name: team_channel_members team_channel_members_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_channel_members
    ADD CONSTRAINT team_channel_members_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.team_channels(id) ON DELETE CASCADE;


--
-- Name: team_message_reactions team_message_reactions_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_message_reactions
    ADD CONSTRAINT team_message_reactions_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.team_messages(id) ON DELETE CASCADE;


--
-- Name: team_messages team_messages_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_messages
    ADD CONSTRAINT team_messages_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.team_channels(id) ON DELETE CASCADE;


--
-- Name: voicemails voicemails_application_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voicemails
    ADD CONSTRAINT voicemails_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.applications(id) ON DELETE SET NULL;


--
-- Name: voicemails voicemails_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voicemails
    ADD CONSTRAINT voicemails_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;


--
-- Name: watch_call_bridges watch_call_bridges_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watch_call_bridges
    ADD CONSTRAINT watch_call_bridges_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;


--
-- Name: watch_call_bridges watch_call_bridges_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watch_call_bridges
    ADD CONSTRAINT watch_call_bridges_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.watch_devices(id) ON DELETE RESTRICT;


--
-- Name: watch_call_bridges watch_call_bridges_staff_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watch_call_bridges
    ADD CONSTRAINT watch_call_bridges_staff_user_id_fkey FOREIGN KEY (staff_user_id) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: watch_devices watch_devices_staff_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watch_devices
    ADD CONSTRAINT watch_devices_staff_user_id_fkey FOREIGN KEY (staff_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: watch_link_codes watch_link_codes_staff_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watch_link_codes
    ADD CONSTRAINT watch_link_codes_staff_user_id_fkey FOREIGN KEY (staff_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: watch_push_registrations watch_push_registrations_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watch_push_registrations
    ADD CONSTRAINT watch_push_registrations_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.watch_devices(id) ON DELETE CASCADE;


--
-- Name: watch_sessions watch_sessions_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watch_sessions
    ADD CONSTRAINT watch_sessions_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.watch_devices(id) ON DELETE CASCADE;


--
-- Name: webauthn_challenges webauthn_challenges_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webauthn_challenges
    ADD CONSTRAINT webauthn_challenges_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: webauthn_credentials webauthn_credentials_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webauthn_credentials
    ADD CONSTRAINT webauthn_credentials_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict mfb79LKYOaXMmNE33eAWKbL6MSTGeGLlK9CbHparUFmhUzxq83mJoiwCHEhqIXW

