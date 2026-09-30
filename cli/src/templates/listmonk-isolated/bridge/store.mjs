/** Privileged adapter. Source credentials can execute only this project's scoped functions. */
import { randomUUID, createHash } from "node:crypto";
import { validateScope } from "./install.mjs";
import { verifyToken, legacyDecision } from "./policy.mjs";
export class NewsletterBridge {
  constructor(source, target, scope, tokenSecret) {
    this.source = source;
    this.target = target;
    this.scope = validateScope(scope);
    this.secret = tokenSecret;
  }
  async verify() {
    const triggers = await this.target.query(
      "SELECT count(*)::int AS n FROM pg_trigger WHERE tgname IN ('hk_bridge_subscriber','hk_bridge_membership') AND tgenabled='O'",
    );
    if (triggers.rows[0].n !== 2) throw Error("Destination capture disabled");
    const {
      rows: [{ data }],
    } = await this.target.query("SELECT data FROM hatchkit_newsletter_bridge.scope");
    if (JSON.stringify(data) !== JSON.stringify(this.scope)) {
      // jsonb does not preserve key order.
      if (
        createHash("sha256")
          .update(JSON.stringify(canonical(data)))
          .digest("hex") !==
        createHash("sha256")
          .update(JSON.stringify(canonical(this.scope)))
          .digest("hex")
      )
        throw Error("Bridge scope mismatch");
    }
    const { rows } = await this.target.query(
      "SELECT key,value FROM settings WHERE key IN ('app.root_url','smtp')",
    );
    const settings = Object.fromEntries(rows.map((x) => [x.key, x.value]));
    if (
      settings["app.root_url"] !== this.scope.targetOrigin ||
      JSON.stringify(settings.smtp) !== "[]"
    )
      throw Error("Wrong destination or SMTP enabled");
    const lists = await this.target.query(
      "SELECT id,uuid FROM lists WHERE uuid=ANY($1::uuid[]) AND optin='double' AND status='active'",
      [this.scope.lists.map((x) => x.targetUuid)],
    );
    if (lists.rows.length !== 2) throw Error("Destination lists changed");
    this.lists = this.scope.lists.map((l) => ({
      ...l,
      targetId: lists.rows.find((x) => x.uuid === l.targetUuid).id,
    }));
  }
  async guarded(email, action) {
    await this.verify();
    const source = await this.source.connect();
    const target = await this.target.connect();
    let snapshot;
    try {
      await source.query("BEGIN");
      await source.query(
        "SET LOCAL statement_timeout='20s'; SET LOCAL idle_in_transaction_session_timeout='60s'",
      );
      // snapshot takes the same per-address advisory lock as the source triggers.
      ({
        rows: [{ snapshot }],
      } = await source.query(`SELECT ${this.scope.sourceSchema}.snapshot($1) AS snapshot`, [
        email,
      ]));
      if (JSON.stringify(canonical(snapshot.scope)) !== JSON.stringify(canonical(this.scope)))
        throw Error("Source bridge scope mismatch");
      await target.query("BEGIN");
      await target.query(
        "SET LOCAL statement_timeout='20s'; SET LOCAL idle_in_transaction_session_timeout='60s'",
      );
      await target.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('hatchkit_newsletter_bridge'||$1,0))",
        [email],
      );
      const result = await action(source, target, snapshot);
      await target.query("COMMIT");
      // No high-watermark: commit-ordered delivery is not guaranteed by sequences.
      await source.query(`SELECT ${this.scope.sourceSchema}.ack($1::bigint[])`, [
        snapshot.events.map((e) => String(e.id)),
      ]);
      await source.query("COMMIT");
      return result;
    } catch (error) {
      await Promise.allSettled([source.query("ROLLBACK"), target.query("ROLLBACK")]);
      throw error;
    } finally {
      source.release();
      target.release();
    }
  }
  async state(target, email, snapshot, tokenIssuedAt, tokenListId) {
    const {
      rows: [sub],
    } = await target.query("SELECT id,uuid,email,status FROM subscribers WHERE lower(email)=$1", [
      email,
    ]);
    const {
      rows: [evidence],
    } = await target.query("SELECT * FROM hatchkit_newsletter_bridge.evidence WHERE email=$1", [
      email,
    ]);
    let mapping;
    const hasImport = await target.query(
      "SELECT to_regclass('hatchkit_newsletter_transfer.subscribers') IS NOT NULL AS present",
    );
    if (sub && hasImport.rows[0].present)
      ({
        rows: [mapping],
      } = await target.query(
        "SELECT source_uuid,$2::text AS email FROM hatchkit_newsletter_transfer.subscribers WHERE target_uuid=$1",
        [sub.uuid, email],
      ));
    if (!mapping && evidence?.source_uuid) mapping = { source_uuid: evidence.source_uuid, email };
    const decision = legacyDecision(snapshot, mapping, evidence, tokenIssuedAt, tokenListId);
    for (const event of snapshot.events)
      await target.query(
        "INSERT INTO hatchkit_newsletter_bridge.events(source_id,email,kind,list_id,at) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
        [String(event.id), email, event.kind, event.list_id, event.at],
      );
    if (evidence?.blocked) decision.blocked = true;
    if (!decision.blocked)
      for (const [targetList, at] of Object.entries(evidence?.unsubscribed ?? {})) {
        const list = this.lists.find((x) => x.targetId === Number(targetList));
        if (!list) throw Error("Unknown suppression list");
        const issued =
          list.sourceId === tokenListId
            ? tokenIssuedAt
            : Date.parse(evidence?.consents?.[list.sourceId]);
        if (
          !Number.isFinite(Date.parse(at)) ||
          !Number.isFinite(issued) ||
          issued <= Date.parse(at)
        )
          decision.unsubscribed.push({ listId: list.sourceId, at });
      }
    if (decision.blocked) {
      if (sub)
        await target.query(
          "UPDATE subscribers SET status='blocklisted',updated_at=now() WHERE id=$1 AND status<>'blocklisted'",
          [sub.id],
        );
      if (decision.deleted)
        await target.query(
          "INSERT INTO hatchkit_newsletter_bridge.evidence(email,deleted) VALUES($1,true) ON CONFLICT(email) DO UPDATE SET deleted=true",
          [email],
        );
      return { blocked: true, sub, evidence };
    }
    if (sub)
      for (const item of decision.unsubscribed) {
        const list = this.lists.find((x) => x.sourceId === item.listId);
        if (!list) throw Error("Foreign source event");
        await target.query(
          "INSERT INTO subscriber_lists(subscriber_id,list_id,status,updated_at) VALUES($1,$2,'unsubscribed',$3) ON CONFLICT(subscriber_id,list_id) DO UPDATE SET status='unsubscribed',updated_at=CASE WHEN subscriber_lists.status='unsubscribed' AND (subscriber_lists.updated_at IS NULL OR excluded.updated_at IS NULL) THEN NULL ELSE greatest(subscriber_lists.updated_at,excluded.updated_at) END",
          [sub.id, list.targetId, item.at],
        );
      }
    return { blocked: !!sub && sub.status !== "enabled", sub, evidence, decision };
  }
  async prepare(token, role, confirm = false) {
    const proof = verifyToken(token, this.secret);
    const email = proof.email;
    const outcome = await this.guarded(email, async (_source, target, snapshot) => {
      const list = this.lists.find((x) => x.role === role);
      if (!list) throw Error("Unknown list role");
      const state = await this.state(target, email, snapshot, proof.issuedAt, list.sourceId);
      if (state.blocked) return false;
      if (!snapshot.subscriber && proof.issuedAt < Date.parse(this.scope.cutover)) return false;
      if (state.decision.unsubscribed.some((x) => x.listId === list.sourceId)) return false;
      let sub = state.sub;
      if (!sub)
        ({
          rows: [sub],
        } = await target.query(
          "INSERT INTO subscribers(uuid,email,name,status,created_at,updated_at) VALUES(gen_random_uuid(),$1,$1,'enabled',$2,$3) RETURNING id,uuid,email,status",
          [
            email,
            snapshot.subscriber ? snapshot.subscriber.created_at : new Date(),
            snapshot.subscriber ? snapshot.subscriber.updated_at : new Date(),
          ],
        ));
      const {
        rows: [membership],
      } = await target.query(
        "SELECT status,updated_at FROM subscriber_lists WHERE subscriber_id=$1 AND list_id=$2",
        [sub.id, list.targetId],
      );
      if (
        membership?.status === "unsubscribed" &&
        (!membership.updated_at || proof.issuedAt <= Date.parse(membership.updated_at))
      )
        return false;
      await target.query(
        "INSERT INTO hatchkit_newsletter_bridge.evidence(email,source_uuid,pending) VALUES($1,$2,jsonb_build_object($3::text,$4::jsonb)) ON CONFLICT(email) DO UPDATE SET source_uuid=COALESCE(hatchkit_newsletter_bridge.evidence.source_uuid,excluded.source_uuid),pending=hatchkit_newsletter_bridge.evidence.pending||excluded.pending",
        [email, snapshot.subscriber?.uuid ?? null, String(list.sourceId), JSON.stringify(proof)],
      );
      if (confirm) {
        await target.query(
          "INSERT INTO subscriber_lists(subscriber_id,list_id,status) VALUES($1,$2,'confirmed') ON CONFLICT(subscriber_id,list_id) DO UPDATE SET status='confirmed',updated_at=now()",
          [sub.id, list.targetId],
        );
        await target.query(
          "UPDATE hatchkit_newsletter_bridge.evidence SET consents=consents||jsonb_build_object($2::text,$3::text),pending=pending-$2::text WHERE email=$1",
          [email, String(list.sourceId), new Date(proof.issuedAt).toISOString()],
        );
      }
      return true;
    });
    if (!outcome) throw Error("Confirmation held by retained suppression");
  }
  async health() {
    await this.verify();
    await this.source.query(`SELECT * FROM ${this.scope.sourceSchema}.pending()`);
  }
  async reconcile() {
    const { rows } = await this.source.query(`SELECT * FROM ${this.scope.sourceSchema}.pending()`);
    for (const { email } of rows)
      await this.guarded(email, (_source, target, snapshot) => this.state(target, email, snapshot));
    return rows.length;
  }
  async deliver(message, payload, send) {
    const email = message.Destination.ToAddresses[0].toLowerCase();
    const attempt = randomUUID();
    let sendStarted = false;
    const accepted = await this.guarded(email, async (_source, target, snapshot) => {
      const state = await this.state(target, email, snapshot);
      if (state.blocked || !state.sub) return false;
      const memberships = await target.query(
        "SELECT list_id,status,updated_at FROM subscriber_lists WHERE subscriber_id=$1",
        [state.sub.id],
      );
      let allowed;
      if (payload.campaign) {
        if (payload.recipients[0].uuid !== state.sub.uuid) return false;
        // Campaign ownership comes from destination DB, not payload list IDs.
        const campaign = await target.query(
          "SELECT cl.list_id FROM campaigns c JOIN campaign_lists cl ON cl.campaign_id=c.id WHERE c.uuid=$1",
          [payload.campaign.uuid],
        );
        if (
          !campaign.rows.length ||
          campaign.rows.some((x) => !this.lists.some((l) => l.targetId === x.list_id))
        )
          return false;
        allowed = campaign.rows.some((x) =>
          memberships.rows.some((m) => m.list_id === x.list_id && m.status === "confirmed"),
        );
      } else {
        allowed = memberships.rows.some(
          (m) => this.lists.some((l) => l.targetId === m.list_id) && m.status === "confirmed",
        );
        for (const list of this.lists) {
          const pending = state.evidence?.pending?.[list.sourceId];
          if (!pending || pending.expiresAt <= Date.now()) continue;
          const check = legacyDecision(
            snapshot,
            null,
            state.evidence,
            pending.issuedAt,
            list.sourceId,
          );
          const membership = memberships.rows.find((m) => m.list_id === list.targetId);
          allowed ||=
            !check.blocked &&
            !check.unsubscribed.some((x) => x.listId === list.sourceId) &&
            !(
              membership?.status === "unsubscribed" &&
              (!membership.updated_at || pending.issuedAt <= Date.parse(membership.updated_at))
            );
        }
      }
      if (!allowed) return false;
      if (
        (
          await target.query(
            "SELECT 1 FROM hatchkit_newsletter_bridge.attempts WHERE email=$1 AND status='pending'",
            [email],
          )
        ).rowCount
      )
        return false;
      // Separate connection commits the intent before SES. An ambiguous send stays held.
      await this.target.query(
        "INSERT INTO hatchkit_newsletter_bridge.attempts(id,email,status) VALUES($1,$2,'pending')",
        [attempt, email],
      );
      sendStarted = true;
      const result = await send(message);
      if (!result?.MessageId) throw Error("No SES receipt");
      await target.query(
        "UPDATE hatchkit_newsletter_bridge.attempts SET message_id=$2,status='accepted' WHERE id=$1",
        [attempt, result.MessageId],
      );
      return true;
    });
    if (!accepted) throw Error("Delivery held by reconciliation");
    return { attempt, sendStarted };
  }
  async feedback(envelope, event, rawDigest) {
    const type = event.eventType ?? event.notificationType;
    if (!["Bounce", "Complaint"].includes(type)) throw Error("Unsupported feedback");
    const messageId = event.mail?.messageId;
    const receipt = await this.target.query(
      "SELECT email FROM hatchkit_newsletter_bridge.attempts WHERE message_id=$1 AND status='accepted'",
      [messageId],
    );
    if (receipt.rows.length !== 1)
      throw Error("Unknown project message; retry or operator review required");
    const email = receipt.rows[0].email;
    const recipients =
      type === "Bounce" ? event.bounce?.bouncedRecipients : event.complaint?.complainedRecipients;
    if (
      !Array.isArray(recipients) ||
      recipients.length !== 1 ||
      recipients[0].emailAddress?.toLowerCase() !== email
    )
      throw Error("Feedback recipient mismatch");
    const client = await this.target.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('hatchkit_newsletter_bridge'||$1,0))",
        [email],
      );
      const prior = await client.query(
        "SELECT sha256 FROM hatchkit_newsletter_bridge.feedback WHERE id=$1",
        [envelope.MessageId],
      );
      if (prior.rowCount) {
        if (prior.rows[0].sha256 !== rawDigest) throw Error("Feedback ID collision");
      } else {
        if (type === "Complaint" || event.bounce?.bounceType === "Permanent")
          await client.query(
            "UPDATE subscribers SET status='blocklisted',updated_at=now() WHERE lower(email)=$1",
            [email],
          );
        await client.query(
          "INSERT INTO hatchkit_newsletter_bridge.feedback(id,sha256) VALUES($1,$2)",
          [envelope.MessageId, rawDigest],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
function canonical(value) {
  return Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k) => [k, canonical(value[k])]),
        )
      : value;
}
