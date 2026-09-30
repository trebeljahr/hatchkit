/** Offline SQL generator. Installation is an explicit, separately reviewed DB mutation. */
import { createHash } from "node:crypto";
const lit = (value) => `'${String(value).replaceAll("'", "''")}'`;
const uuid = (value) =>
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
export function validateScope(scope) {
  if (
    !scope ||
    scope.version !== 1 ||
    scope.reviewed !== true ||
    !/^[a-z0-9-]+$/.test(scope.project)
  )
    throw Error("Reviewed bridge scope required");
  for (const key of ["sourceOrigin", "targetOrigin"]) {
    const u = new URL(scope[key]);
    if (u.protocol !== "https:" || u.origin !== scope[key])
      throw Error("Exact HTTPS origins required");
  }
  if (scope.sourceOrigin === scope.targetOrigin || !Number.isFinite(Date.parse(scope.cutover)))
    throw Error("Distinct origins and cutover required");
  if (
    !Array.isArray(scope.lists) ||
    scope.lists.length !== 2 ||
    scope.lists
      .map((x) => x.role)
      .sort()
      .join() !== "live,test"
  )
    throw Error("Live/test mappings required");
  for (const list of scope.lists)
    if (
      !uuid(list.sourceUuid) ||
      !uuid(list.targetUuid) ||
      !Number.isSafeInteger(list.sourceId) ||
      list.sourceId < 1
    )
      throw Error("Invalid list mapping");
  for (const key of ["sourceId", "sourceUuid", "targetUuid"])
    if (new Set(scope.lists.map((x) => x[key])).size !== 2) throw Error("Duplicate list mapping");
  return {
    ...scope,
    sourceSchema: `hk_legacy_${createHash("sha256").update(scope.project).digest("hex").slice(0, 16)}`,
  };
}
export function installationSql(input) {
  const cfg = validateScope(input),
    ns = cfg.sourceSchema;
  const data = lit(JSON.stringify(cfg));
  const source = `\\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL standard_conforming_strings=on;
-- Install while project sends/writes are paused. No subscriber data is copied.
CREATE SCHEMA ${ns};
REVOKE ALL ON SCHEMA ${ns} FROM PUBLIC;
CREATE TABLE ${ns}.scope(data jsonb NOT NULL);
INSERT INTO ${ns}.scope VALUES (${data}::jsonb);
DO $guard$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM public.settings WHERE key='app.root_url' AND value=${lit(JSON.stringify(cfg.sourceOrigin))}::jsonb)
 OR (SELECT count(*) FROM public.lists l JOIN jsonb_to_recordset((SELECT data->'lists' FROM ${ns}.scope)) x("sourceId" int,"sourceUuid" uuid)
 ON l.id=x."sourceId" AND l.uuid=x."sourceUuid" WHERE l.optin='double')<>2 THEN RAISE EXCEPTION 'Wrong source or list mapping'; END IF;
END $guard$;
CREATE TABLE ${ns}.watched(email text PRIMARY KEY, source_uuid uuid NOT NULL);
INSERT INTO ${ns}.watched SELECT DISTINCT lower(s.email),s.uuid FROM public.subscribers s JOIN public.subscriber_lists sl ON sl.subscriber_id=s.id
 WHERE sl.list_id IN (SELECT (v->>'sourceId')::int FROM ${ns}.scope,jsonb_array_elements(data->'lists') v);
CREATE TABLE ${ns}.events(id bigserial PRIMARY KEY,email text NOT NULL,kind text NOT NULL,list_id int,at timestamptz NOT NULL DEFAULT clock_timestamp(),acked boolean NOT NULL DEFAULT false);
CREATE INDEX ON ${ns}.events(email,id);
CREATE INDEX ON ${ns}.events(id) WHERE NOT acked;
CREATE FUNCTION ${ns}.lock_email(email text) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT pg_advisory_xact_lock(hashtextextended(${lit(ns)}||lower(email),0));
$$;
-- Only exact-email state and the two project lists are returned. No global attributes/names.
CREATE FUNCTION ${ns}.snapshot(address text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE sub record; result jsonb;
BEGIN
 IF address IS NULL OR length(address)>254 OR address<>lower(address) THEN RAISE EXCEPTION 'Invalid email'; END IF;
 PERFORM ${ns}.lock_email(address);
 IF (SELECT count(*) FROM pg_trigger WHERE tgname IN ('${ns}_subscriber','${ns}_membership') AND tgenabled='O')<>2 THEN RAISE EXCEPTION 'Source capture disabled'; END IF;
 IF (SELECT count(*) FROM public.lists l JOIN jsonb_to_recordset((SELECT data->'lists' FROM ${ns}.scope)) x("sourceId" int,"sourceUuid" uuid)
 ON l.id=x."sourceId" AND l.uuid=x."sourceUuid" WHERE l.optin='double')<>2 THEN RAISE EXCEPTION 'Source list mapping changed'; END IF;
 SELECT id,uuid,email,status,created_at,updated_at INTO sub FROM public.subscribers WHERE lower(email)=address;
 IF FOUND THEN INSERT INTO ${ns}.watched VALUES(address,sub.uuid) ON CONFLICT DO NOTHING; END IF;
 SELECT jsonb_build_object('scope',(SELECT data FROM ${ns}.scope),'subscriber',CASE WHEN sub.id IS NULL THEN NULL ELSE to_jsonb(sub) END,
 'memberships',COALESCE((SELECT jsonb_agg(jsonb_build_object('list_id',sl.list_id,'status',sl.status,'updated_at',sl.updated_at)) FROM public.subscriber_lists sl
 WHERE sl.subscriber_id=sub.id AND sl.list_id IN (SELECT (v->>'sourceId')::int FROM ${ns}.scope,jsonb_array_elements(data->'lists') v)),'[]'::jsonb),
 'events',COALESCE((SELECT jsonb_agg(to_jsonb(e)||jsonb_build_object('id',e.id::text) ORDER BY e.id) FROM ${ns}.events e WHERE e.email=address OR e.email IN (SELECT email FROM ${ns}.watched WHERE source_uuid=sub.uuid)),'[]'::jsonb)) INTO result;
 RETURN result;
END $$;
CREATE FUNCTION ${ns}.capture() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE address text; sid int; lid int; kind text; scoped boolean;
BEGIN
 IF TG_TABLE_NAME='subscribers' THEN
  IF TG_OP='INSERT' THEN address:=lower(NEW.email);sid:=NEW.id; ELSE address:=lower(OLD.email);sid:=OLD.id; END IF;
  PERFORM ${ns}.lock_email(address);
  SELECT EXISTS(SELECT 1 FROM ${ns}.watched WHERE email=address) OR EXISTS(SELECT 1 FROM public.subscriber_lists WHERE subscriber_id=sid AND list_id IN
   (SELECT (v->>'sourceId')::int FROM ${ns}.scope,jsonb_array_elements(data->'lists') v)) INTO scoped;
  IF NOT scoped THEN IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF; END IF;
  PERFORM ${ns}.lock_email(address);
  IF TG_OP='DELETE' THEN kind:='deleted';
  ELSIF TG_OP='UPDATE' AND (NEW.email<>OLD.email OR NEW.uuid<>OLD.uuid) THEN kind:='deleted';
  ELSIF NEW.status<>'enabled' THEN kind:=NEW.status::text; END IF;
 ELSE
  IF TG_OP='UPDATE' AND (NEW.subscriber_id<>OLD.subscriber_id OR NEW.list_id<>OLD.list_id) AND OLD.list_id IN (SELECT (v->>'sourceId')::int FROM ${ns}.scope,jsonb_array_elements(data->'lists') v) THEN
   SELECT lower(email) INTO address FROM public.subscribers WHERE id=OLD.subscriber_id;
   IF address IS NOT NULL THEN PERFORM ${ns}.lock_email(address);
    INSERT INTO ${ns}.events(email,kind,list_id) VALUES(address,'membership_deleted',OLD.list_id); END IF;
  END IF;
  IF TG_OP='DELETE' THEN sid:=OLD.subscriber_id;lid:=OLD.list_id; ELSE sid:=NEW.subscriber_id;lid:=NEW.list_id; END IF;
  IF lid NOT IN (SELECT (v->>'sourceId')::int FROM ${ns}.scope,jsonb_array_elements(data->'lists') v) THEN IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF; END IF;
  SELECT lower(email) INTO address FROM public.subscribers WHERE id=sid;
  IF address IS NULL THEN IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF; END IF;
  PERFORM ${ns}.lock_email(address);
  IF TG_OP='DELETE' THEN kind:='membership_deleted'; ELSIF NEW.status='unsubscribed' THEN kind:='unsubscribed'; END IF;
 END IF;
 IF kind IS NOT NULL THEN INSERT INTO ${ns}.events(email,kind,list_id) VALUES(address,kind,lid); END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER ${ns}_subscriber BEFORE INSERT OR UPDATE OR DELETE ON public.subscribers FOR EACH ROW EXECUTE FUNCTION ${ns}.capture();
CREATE TRIGGER ${ns}_membership BEFORE INSERT OR UPDATE OR DELETE ON public.subscriber_lists FOR EACH ROW EXECUTE FUNCTION ${ns}.capture();
CREATE FUNCTION ${ns}.pending() RETURNS TABLE(email text) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF (SELECT count(*) FROM pg_trigger WHERE tgname IN ('${ns}_subscriber','${ns}_membership') AND tgenabled='O')<>2 THEN RAISE EXCEPTION 'Source capture disabled'; END IF;
 RETURN QUERY SELECT e.email FROM ${ns}.events e WHERE NOT e.acked GROUP BY e.email ORDER BY min(e.id) LIMIT 100; END $$;
CREATE FUNCTION ${ns}.ack(ids bigint[]) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$ UPDATE ${ns}.events SET acked=true WHERE id=ANY(ids); $$;
REVOKE ALL ON ALL TABLES IN SCHEMA ${ns} FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${ns} FROM PUBLIC;
-- Supply a dedicated pre-created login as psql -v bridge_role=... . No shared admin credential in the service.
GRANT USAGE ON SCHEMA ${ns} TO :"bridge_role";
GRANT EXECUTE ON FUNCTION ${ns}.snapshot(text),${ns}.pending(),${ns}.ack(bigint[]) TO :"bridge_role";
COMMIT;
`;
  const target = `\\set ON_ERROR_STOP on
BEGIN;
SET LOCAL standard_conforming_strings=on;
CREATE SCHEMA hatchkit_newsletter_bridge;
REVOKE ALL ON SCHEMA hatchkit_newsletter_bridge FROM PUBLIC;
CREATE TABLE hatchkit_newsletter_bridge.scope(data jsonb NOT NULL);
INSERT INTO hatchkit_newsletter_bridge.scope VALUES (${data}::jsonb);
CREATE TABLE hatchkit_newsletter_bridge.evidence(email text PRIMARY KEY,source_uuid uuid,consents jsonb NOT NULL DEFAULT '{}',pending jsonb NOT NULL DEFAULT '{}',unsubscribed jsonb NOT NULL DEFAULT '{}',blocked boolean NOT NULL DEFAULT false,deleted boolean NOT NULL DEFAULT false);
CREATE TABLE hatchkit_newsletter_bridge.events(source_id bigint PRIMARY KEY,email text NOT NULL,kind text NOT NULL,list_id int,at timestamptz NOT NULL);
CREATE TABLE hatchkit_newsletter_bridge.attempts(id uuid PRIMARY KEY,email text NOT NULL,message_id text UNIQUE,status text NOT NULL CHECK(status IN ('pending','accepted','reviewed')),created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE hatchkit_newsletter_bridge.feedback(id text PRIMARY KEY,sha256 text NOT NULL,at timestamptz NOT NULL DEFAULT now());
CREATE TABLE hatchkit_newsletter_bridge.confirmations(topic text PRIMARY KEY,token text NOT NULL,at timestamptz NOT NULL DEFAULT now());
CREATE FUNCTION hatchkit_newsletter_bridge.capture() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE address text;sid int;
BEGIN
 IF TG_TABLE_NAME='subscribers' THEN IF TG_OP='INSERT' THEN address:=lower(NEW.email); ELSE address:=lower(OLD.email); END IF;
 ELSE IF TG_OP='DELETE' THEN sid:=OLD.subscriber_id; ELSE sid:=NEW.subscriber_id; END IF;
 SELECT lower(email) INTO address FROM public.subscribers WHERE id=sid; END IF;
 IF address IS NULL THEN IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('hatchkit_newsletter_bridge'||address,0));
 IF TG_TABLE_NAME='subscribers' AND TG_OP='UPDATE' THEN
  IF NEW.email<>OLD.email OR NEW.uuid<>OLD.uuid THEN
   INSERT INTO hatchkit_newsletter_bridge.evidence(email,deleted) SELECT DISTINCT a.email,true FROM unnest(ARRAY[lower(OLD.email),lower(NEW.email)]) AS a(email) ON CONFLICT(email) DO UPDATE SET deleted=true;
  END IF;
 END IF;
 IF TG_OP='DELETE' THEN
 INSERT INTO hatchkit_newsletter_bridge.evidence(email,deleted) VALUES(address,true) ON CONFLICT(email) DO UPDATE SET deleted=true;
 END IF;
 IF TG_TABLE_NAME='subscribers' AND TG_OP<>'DELETE' AND NEW.status::text<>'enabled' THEN
 INSERT INTO hatchkit_newsletter_bridge.evidence(email,blocked) VALUES(address,true) ON CONFLICT(email) DO UPDATE SET blocked=true;
 ELSIF TG_TABLE_NAME='subscriber_lists' AND TG_OP<>'DELETE' AND NEW.status::text='unsubscribed' THEN
 INSERT INTO hatchkit_newsletter_bridge.evidence(email,unsubscribed) VALUES(address,jsonb_build_object(NEW.list_id::text,NEW.updated_at))
 ON CONFLICT(email) DO UPDATE SET unsubscribed=hatchkit_newsletter_bridge.evidence.unsubscribed||jsonb_build_object(NEW.list_id::text,
 CASE WHEN hatchkit_newsletter_bridge.evidence.unsubscribed ? NEW.list_id::text AND (hatchkit_newsletter_bridge.evidence.unsubscribed->>NEW.list_id::text IS NULL OR NEW.updated_at IS NULL) THEN NULL
 ELSE greatest((hatchkit_newsletter_bridge.evidence.unsubscribed->>NEW.list_id::text)::timestamptz,NEW.updated_at) END);
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER hk_bridge_subscriber BEFORE INSERT OR UPDATE OR DELETE ON public.subscribers FOR EACH ROW EXECUTE FUNCTION hatchkit_newsletter_bridge.capture();
CREATE TRIGGER hk_bridge_membership BEFORE INSERT OR UPDATE OR DELETE ON public.subscriber_lists FOR EACH ROW EXECUTE FUNCTION hatchkit_newsletter_bridge.capture();
COMMIT;
`;
  return { source, target, config: cfg };
}
