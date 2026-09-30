-- READ ONLY. Review source list UUIDs against project records before execution.
-- psql -X -q -v ON_ERROR_STOP=1 -v live_uuid=... -v test_uuid=... \
--   -f export-memberships.sql > protected-memberships.csv
-- Use a separately approved read-only connection; never put passwords in argv.
-- No orphan subscribers, global attributes, SMTP settings, users or campaigns.
\set ON_ERROR_STOP on
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT count(*) = 2 AND bool_and(optin = 'double') AS approved_lists_present
FROM lists WHERE uuid IN (:'live_uuid'::uuid, :'test_uuid'::uuid) \gset
\if :approved_lists_present
COPY (
  SELECT s.id AS source_subscriber_id, s.uuid AS source_subscriber_uuid,
         s.email, s.status AS subscriber_status,
         s.created_at AS subscriber_created_at, s.updated_at AS subscriber_updated_at,
         l.id AS source_list_id, l.uuid AS source_list_uuid,
         sl.status AS subscription_status,
         sl.created_at AS membership_created_at, sl.updated_at AS membership_updated_at,
         sl.meta AS membership_evidence
  FROM subscriber_lists sl
  JOIN subscribers s ON s.id = sl.subscriber_id
  JOIN lists l ON l.id = sl.list_id
  WHERE l.uuid IN (:'live_uuid'::uuid, :'test_uuid'::uuid)
  ORDER BY s.id, l.id
) TO STDOUT WITH (FORMAT csv, HEADER true);
COMMIT;
\else
ROLLBACK;
-- psql 17 does not support an exit-code argument to \quit. Force a SQL
-- error under ON_ERROR_STOP so a rejected export cannot look successful.
SELECT CAST('STOP: expected two distinct existing double-opt-in lists' AS integer);
\endif
