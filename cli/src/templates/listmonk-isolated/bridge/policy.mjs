import { createHmac, timingSafeEqual } from "node:crypto";
export const ttl = 21 * 24 * 60 * 60 * 1000;
export function verifyToken(token, secret, now = Date.now()) {
  if (typeof token !== "string" || token.length > 2048 || !secret)
    throw Error("Invalid confirmation");
  const parts = token.split(".");
  if (parts.length !== 2) throw Error("Invalid confirmation");
  const expected = createHmac("sha256", secret).update(parts[0]).digest(),
    provided = Buffer.from(parts[1], "base64url");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected))
    throw Error("Invalid confirmation");
  const p = JSON.parse(Buffer.from(parts[0], "base64url").toString());
  if (
    typeof p.e !== "string" ||
    p.e !== p.e.toLowerCase() ||
    p.e.length > 254 ||
    !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(p.e) ||
    !Number.isSafeInteger(p.x) ||
    p.x < now ||
    p.x - ttl > now
  )
    throw Error("Invalid confirmation");
  return { email: p.e, issuedAt: p.x - ttl, expiresAt: p.x };
}
export function legacyDecision(snapshot, mapping, evidence, tokenIssuedAt, tokenListId) {
  const sub = snapshot.subscriber;
  if (
    evidence?.deleted ||
    snapshot.events.some((e) => ["deleted", "membership_deleted"].includes(e.kind))
  )
    return { blocked: true, deleted: true };
  if (
    mapping &&
    (!sub || sub.uuid !== mapping.source_uuid || sub.email.toLowerCase() !== mapping.email)
  )
    return { blocked: true, deleted: true };
  if (
    (sub && sub.status !== "enabled") ||
    snapshot.events.some((e) => ["disabled", "blocklisted"].includes(e.kind))
  )
    return { blocked: true };
  const unsub = [];
  for (const m of snapshot.memberships)
    if (m.status === "unsubscribed") unsub.push({ listId: m.list_id, at: m.updated_at });
  for (const e of snapshot.events)
    if (e.kind === "unsubscribed") unsub.push({ listId: e.list_id, at: e.at });
  return {
    blocked: false,
    unsubscribed: unsub.filter((e) => {
      const effective =
        e.listId === tokenListId && tokenIssuedAt !== undefined
          ? tokenIssuedAt
          : Date.parse(evidence?.consents?.[e.listId]);
      return (
        !Number.isFinite(Date.parse(e.at)) ||
        !Number.isFinite(effective) ||
        effective <= Date.parse(e.at)
      );
    }),
  };
}
