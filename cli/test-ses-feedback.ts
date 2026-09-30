/**
 * SES bounce + complaint feedback into Listmonk.
 *
 * On 2026-09-29 the feedback path was wired by hand: SNS topic
 * `ses-feedback-listmonk`, subscribed to Listmonk's SES webhook, set as
 * the Bounce + Complaint topic on every verified identity, plus account
 * suppression and Listmonk's three bounce settings. Provisioning never
 * set the identity topics, so the next identity Hatchkit made would have
 * dropped its bounces silently.
 *
 * The properties that keep that from coming back:
 *   1. Provisioning wires a new identity end to end, and a second run
 *      over the result makes no write: no CreateTopic, no Subscribe, no
 *      SetIdentityNotificationTopic, no suppression PUT, and no Listmonk
 *      settings PUT (each PUT reloads Listmonk).
 *   2. Only Listmonk bounce keys that are off get PUT, one per key
 *      (`PUT /api/settings/<key>`, raw `true`), never the whole document.
 *   3. A notification topic someone else set on the identity is left
 *      alone, and is not counted as something this run set.
 *   4. A missing IAM permission is a warning that names the action, and
 *      the other steps still run. A refused topic write also comes with
 *      the exact `aws ses set-identity-notification-topic` command.
 *   5. Destroy clears only the identity's own topics this run set. The
 *      shared topic, its subscription, account suppression and Listmonk
 *      settings stay, so every other project keeps its bounces.
 *   6. Doctor reads without writing, reports each broken piece as a
 *      failure with a `--fix` repair, and after the repairs has nothing
 *      left to report.
 *   7. With basic-auth credentials, the SNS endpoint carries them, a
 *      subscription SNS lists with the password masked still counts as
 *      ours, the older plain subscription goes only once the new one is
 *      confirmed, and no output line holds the password.
 *
 * AWS and Listmonk are in-memory stubs behind the module's port
 * interfaces; nothing here touches the network except a stubbed fetch.
 *
 * Run: `pnpm test` (via the script in cli/package.json).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import bcrypt from "bcryptjs";
import { checkSesBounceFeedback } from "./src/doctor.js";
import {
  type IdentityNotificationTopics,
  SES_FEEDBACK_TOPIC_NAME,
  type SesFeedbackAws,
  type SesFeedbackListmonk,
  type SesFeedbackType,
  type SnsSubscription,
  type WebhookCredentials,
  clearSesFeedbackTopics,
  createSesFeedbackListmonk,
  ensureSesFeedback,
  listmonkSesWebhookUrl,
  redactEndpoint,
  renderSesFeedbackLines,
  subscriptionState,
  traefikBasicAuthLabels,
} from "./src/provision/ses-feedback.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const failures: string[] = [];

async function expect(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`${label}: ${(err as Error).message}`);
    console.log(`  ✗ ${label}`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Stubs
// ────────────────────────────────────────────────────────────────────────────

const ACCOUNT = "111122223333";
const REGION = "eu-west-1";
const LISTMONK_URL = "https://listmonk.example.com/";
const WEBHOOK = "https://listmonk.example.com/webhooks/service/ses";
const TOPIC_ARN = `arn:aws:sns:${REGION}:${ACCOUNT}:${SES_FEEDBACK_TOPIC_NAME}`;

function awsError(name: string, message: string): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

/** One AWS account: SNS topics, SES identities, account suppression.
 *  `writes` logs every mutating call; `denied` names methods that throw
 *  the error AWS returns for a missing IAM action. */
class FakeAws implements SesFeedbackAws {
  topics = new Map<string, SnsSubscription[]>();
  identities = new Map<string, { verified: boolean } & IdentityNotificationTopics>();
  suppressed: string[] = [];
  writes: string[] = [];
  denied = new Set<keyof SesFeedbackAws>();
  /** Listmonk confirms a subscription as soon as SNS asks. */
  autoConfirm = true;
  /** List endpoints with the password masked, as SNS may. */
  maskPasswords = false;

  addIdentity(name: string, topics: Partial<IdentityNotificationTopics> = {}, verified = true) {
    this.identities.set(name, {
      verified,
      bounceTopic: topics.bounceTopic ?? null,
      complaintTopic: topics.complaintTopic ?? null,
    });
  }

  private guard(method: keyof SesFeedbackAws): void {
    if (!this.denied.has(method)) return;
    if (
      method === "createTopic" ||
      method === "subscribe" ||
      method === "unsubscribe" ||
      method === "listSubscriptions"
    ) {
      throw awsError("AuthorizationError", `User is not authorized to perform: sns:${method}`);
    }
    throw awsError("AccessDenied", `User is not authorized to perform: ses:${method}`);
  }

  async createTopic(name: string) {
    this.guard("createTopic");
    this.writes.push(`createTopic ${name}`);
    const arn = `arn:aws:sns:${REGION}:${ACCOUNT}:${name}`;
    if (!this.topics.has(arn)) this.topics.set(arn, []);
    return arn;
  }
  async listSubscriptions(topicArn: string) {
    this.guard("listSubscriptions");
    const subs = this.topics.get(topicArn);
    if (!subs) throw awsError("NotFound", "Topic does not exist");
    return subs.map((s) => ({
      ...s,
      endpoint: this.maskPasswords ? s.endpoint.replace(/:[^:@/]+@/, ":****@") : s.endpoint,
    }));
  }
  async unsubscribe(subscriptionArn: string) {
    this.guard("unsubscribe");
    this.writes.push(`unsubscribe ${subscriptionArn}`);
    for (const [arn, subs] of this.topics) {
      this.topics.set(
        arn,
        subs.filter((s) => s.subscriptionArn !== subscriptionArn),
      );
    }
  }
  async subscribe(topicArn: string, protocol: "http" | "https", endpoint: string) {
    this.guard("subscribe");
    this.writes.push(`subscribe ${endpoint}`);
    const subs = this.topics.get(topicArn);
    if (!subs) throw awsError("NotFound", "Topic does not exist");
    const existing = subs.find((s) => s.endpoint === endpoint);
    const arn = this.autoConfirm ? `${topicArn}:sub-${subs.length + 1}` : "PendingConfirmation";
    if (existing) existing.subscriptionArn = arn;
    else subs.push({ subscriptionArn: arn, protocol, endpoint });
  }
  async getNotificationTopics(identities: string[]) {
    this.guard("getNotificationTopics");
    const out = new Map<string, IdentityNotificationTopics>();
    for (const name of identities) {
      const id = this.identities.get(name);
      if (id) out.set(name, { bounceTopic: id.bounceTopic, complaintTopic: id.complaintTopic });
    }
    return out;
  }
  async setNotificationTopic(identity: string, type: SesFeedbackType, topicArn: string | null) {
    this.guard("setNotificationTopic");
    this.writes.push(`setNotificationTopic ${identity} ${type} ${topicArn ?? "(clear)"}`);
    const id = this.identities.get(identity);
    if (!id) throw awsError("InvalidParameterValue", `Identity ${identity} does not exist`);
    if (type === "Bounce") id.bounceTopic = topicArn;
    else id.complaintTopic = topicArn;
  }
  async getSuppressedReasons() {
    this.guard("getSuppressedReasons");
    return [...this.suppressed];
  }
  async putSuppressedReasons(reasons: string[]) {
    this.guard("putSuppressedReasons");
    this.writes.push(`putSuppressedReasons ${reasons.join(",")}`);
    this.suppressed = [...reasons];
  }
  async listVerifiedIdentities() {
    this.guard("listVerifiedIdentities");
    return [...this.identities].filter(([, v]) => v.verified).map(([k]) => k);
  }
}

class FakeListmonk implements SesFeedbackListmonk {
  settings: Record<string, unknown> = {
    "bounce.enabled": false,
    "bounce.webhooks_enabled": false,
    "bounce.ses_enabled": false,
    "app.from_email": "x <noreply@mail.example.com>",
  };
  writes: string[] = [];
  failRead: string | null = null;
  async getSettings() {
    if (this.failRead) throw new Error(this.failRead);
    return { ...this.settings };
  }
  async putSetting(key: string, value: unknown) {
    this.writes.push(`${key}=${JSON.stringify(value)}`);
    this.settings[key] = value;
  }
}

/** The state after the hand setup of 2026-09-29, for one identity. */
function healthyAccount(): { aws: FakeAws; listmonk: FakeListmonk } {
  const aws = new FakeAws();
  aws.topics.set(TOPIC_ARN, [
    { subscriptionArn: `${TOPIC_ARN}:sub-1`, protocol: "https", endpoint: WEBHOOK },
  ]);
  aws.addIdentity("mail.a.com", { bounceTopic: TOPIC_ARN, complaintTopic: TOPIC_ARN });
  aws.suppressed = ["BOUNCE", "COMPLAINT"];
  const listmonk = new FakeListmonk();
  for (const k of ["bounce.enabled", "bounce.webhooks_enabled", "bounce.ses_enabled"]) {
    listmonk.settings[k] = true;
  }
  return { aws, listmonk };
}

function run(aws: FakeAws, listmonk: FakeListmonk, identity: string) {
  return ensureSesFeedback({
    identity,
    listmonkUrl: LISTMONK_URL,
    aws,
    listmonk,
    confirmTimeoutMs: 0,
  });
}

// ────────────────────────────────────────────────────────────────────────────

console.log("webhook URL:");

await expect("derives Listmonk's SES webhook from the stored URL, trailing slash dropped", () => {
  assert.equal(
    listmonkSesWebhookUrl("https://listmonk.trebeljahr.com/"),
    "https://listmonk.trebeljahr.com/webhooks/service/ses",
  );
  assert.equal(listmonkSesWebhookUrl(LISTMONK_URL), WEBHOOK);
});

console.log("\nensureSesFeedback:");

await expect("wires a new identity on a fresh account end to end", async () => {
  const aws = new FakeAws();
  const listmonk = new FakeListmonk();
  aws.addIdentity("mail.trackyourtime.dev", {}, false);
  const r = await run(aws, listmonk, "mail.trackyourtime.dev");

  assert.deepEqual(r.warnings, []);
  assert.equal(r.topicArn, TOPIC_ARN);
  assert.equal(r.subscription, "confirmed");
  assert.deepEqual(r.typesSetThisRun, ["Bounce", "Complaint"]);
  assert.deepEqual(r.suppressionAdded, ["BOUNCE", "COMPLAINT"]);
  assert.deepEqual(r.listmonkSettingsWritten, [
    "bounce.enabled",
    "bounce.webhooks_enabled",
    "bounce.ses_enabled",
  ]);
  const id = aws.identities.get("mail.trackyourtime.dev");
  assert.equal(id?.bounceTopic, TOPIC_ARN);
  assert.equal(id?.complaintTopic, TOPIC_ARN);
  assert.deepEqual(
    aws.topics.get(TOPIC_ARN)?.map((s) => s.endpoint),
    [WEBHOOK],
  );
  assert.deepEqual(aws.suppressed, ["BOUNCE", "COMPLAINT"]);
  assert.deepEqual(listmonk.writes, [
    "bounce.enabled=true",
    "bounce.webhooks_enabled=true",
    "bounce.ses_enabled=true",
  ]);
});

await expect(
  "turns Listmonk's bounce settings on before subscribing (Listmonk confirms only then)",
  async () => {
    const aws = new FakeAws();
    aws.addIdentity("mail.a.com");
    const order: string[] = [];
    const listmonk = new FakeListmonk();
    const put = listmonk.putSetting.bind(listmonk);
    listmonk.putSetting = async (k, v) => {
      order.push(`listmonk ${k}`);
      await put(k, v);
    };
    const subscribe = aws.subscribe.bind(aws);
    aws.subscribe = async (...args) => {
      order.push("sns subscribe");
      await subscribe(...args);
    };
    await run(aws, listmonk, "mail.a.com");
    assert.equal(order.at(-1), "sns subscribe");
    assert.ok(order.indexOf("listmonk bounce.ses_enabled") < order.indexOf("sns subscribe"));
  },
);

await expect("a second run makes no write to AWS or Listmonk", async () => {
  const aws = new FakeAws();
  const listmonk = new FakeListmonk();
  aws.addIdentity("mail.a.com");
  await run(aws, listmonk, "mail.a.com");
  aws.writes = [];
  listmonk.writes = [];

  const r = await run(aws, listmonk, "mail.a.com");
  assert.deepEqual(aws.writes, []);
  assert.deepEqual(listmonk.writes, []);
  assert.deepEqual(r.typesSetThisRun, []);
  assert.equal(r.subscribedThisRun, false);
  assert.equal(r.subscription, "confirmed");
  assert.deepEqual(r.warnings, []);
});

await expect(
  "over the hand-wired account, a new identity costs only its own two topic writes",
  async () => {
    const { aws, listmonk } = healthyAccount();
    aws.addIdentity("mail.trackyourtime.dev");
    const r = await run(aws, listmonk, "mail.trackyourtime.dev");
    assert.deepEqual(aws.writes, [
      // The identity routes nowhere yet, so the ARN comes from CreateTopic
      // (idempotent by name); everything shared is already in place.
      `createTopic ${SES_FEEDBACK_TOPIC_NAME}`,
      `setNotificationTopic mail.trackyourtime.dev Bounce ${TOPIC_ARN}`,
      `setNotificationTopic mail.trackyourtime.dev Complaint ${TOPIC_ARN}`,
    ]);
    assert.deepEqual(listmonk.writes, []);
    assert.equal(r.subscribedThisRun, false);
  },
);

await expect("PUTs only the Listmonk keys that are still off", async () => {
  const aws = new FakeAws();
  aws.addIdentity("mail.a.com");
  const listmonk = new FakeListmonk();
  listmonk.settings["bounce.enabled"] = true;
  listmonk.settings["bounce.ses_enabled"] = true;
  const r = await run(aws, listmonk, "mail.a.com");
  assert.deepEqual(listmonk.writes, ["bounce.webhooks_enabled=true"]);
  assert.deepEqual(r.listmonkSettingsWritten, ["bounce.webhooks_enabled"]);
});

await expect("keeps suppression reasons already there and adds only the missing one", async () => {
  const aws = new FakeAws();
  aws.addIdentity("mail.a.com");
  aws.suppressed = ["BOUNCE"];
  const r = await run(aws, new FakeListmonk(), "mail.a.com");
  assert.deepEqual(r.suppressionAdded, ["COMPLAINT"]);
  assert.deepEqual(aws.suppressed, ["BOUNCE", "COMPLAINT"]);
});

await expect("leaves a topic someone else set, and doesn't count it as set this run", async () => {
  const aws = new FakeAws();
  const theirs = `arn:aws:sns:${REGION}:${ACCOUNT}:their-bounces`;
  aws.addIdentity("mail.a.com", { bounceTopic: theirs });
  const r = await run(aws, new FakeListmonk(), "mail.a.com");
  assert.equal(aws.identities.get("mail.a.com")?.bounceTopic, theirs);
  assert.equal(aws.identities.get("mail.a.com")?.complaintTopic, TOPIC_ARN);
  assert.deepEqual(r.typesSetThisRun, ["Complaint"]);
  assert.deepEqual(r.foreignTopics, [{ type: "Bounce", topicArn: theirs }]);
  assert.ok(renderSesFeedbackLines(r).some((l) => l.level === "warn" && l.text.includes(theirs)));
});

await expect("re-subscribes a pending subscription so SNS resends the confirmation", async () => {
  const { aws, listmonk } = healthyAccount();
  aws.topics.set(TOPIC_ARN, [
    { subscriptionArn: "PendingConfirmation", protocol: "https", endpoint: WEBHOOK },
  ]);
  const r = await run(aws, listmonk, "mail.a.com");
  assert.deepEqual(aws.writes, [`subscribe ${WEBHOOK}`]);
  assert.equal(r.subscription, "confirmed");
});

await expect(
  "reports a subscription Listmonk hasn't confirmed as pending, with a warning line",
  async () => {
    const aws = new FakeAws();
    aws.autoConfirm = false;
    aws.addIdentity("mail.a.com");
    const r = await run(aws, new FakeListmonk(), "mail.a.com");
    assert.equal(r.subscription, "pending");
    assert.ok(
      renderSesFeedbackLines(r).some((l) => l.level === "warn" && l.text.includes("not confirmed")),
    );
  },
);

await expect("recreates a deleted topic under its name, same ARN", async () => {
  const { aws, listmonk } = healthyAccount();
  aws.topics.clear();
  const r = await run(aws, listmonk, "mail.a.com");
  assert.equal(r.topicArn, TOPIC_ARN);
  assert.equal(r.subscription, "confirmed");
  assert.deepEqual(aws.writes, [`createTopic ${SES_FEEDBACK_TOPIC_NAME}`, `subscribe ${WEBHOOK}`]);
});

await expect("a missing sns:CreateTopic is a named warning; suppression still runs", async () => {
  const aws = new FakeAws();
  aws.addIdentity("mail.a.com");
  aws.denied.add("createTopic");
  const r = await run(aws, new FakeListmonk(), "mail.a.com");
  assert.equal(r.topicArn, null);
  assert.equal(r.iamGap, true);
  assert.deepEqual(r.warnings, ["missing IAM permission sns:CreateTopic"]);
  assert.deepEqual(r.suppressionAdded, ["BOUNCE", "COMPLAINT"]);
  const lines = renderSesFeedbackLines(r)
    .map((l) => l.text)
    .join("\n");
  assert.ok(lines.includes("ses:SetIdentityNotificationTopic"), "hint lists the IAM actions");
});

await expect("missing SES v1 + account permissions warn instead of throwing", async () => {
  const aws = new FakeAws();
  aws.addIdentity("mail.a.com");
  aws.denied.add("getNotificationTopics");
  aws.denied.add("getSuppressedReasons");
  const r = await run(aws, new FakeListmonk(), "mail.a.com");
  assert.deepEqual(r.warnings, [
    "missing IAM permission ses:GetIdentityNotificationAttributes",
    "missing IAM permission ses:GetAccount / ses:PutAccountSuppressionAttributes",
  ]);
  assert.deepEqual(r.typesSetThisRun, []);
  assert.equal(r.subscription, "confirmed", "the topic + subscription still get wired");
});

await expect(
  "a refused ses:SetIdentityNotificationTopic comes with the exact aws command per unset type",
  async () => {
    const aws = new FakeAws();
    aws.addIdentity("mail.a.com", { bounceTopic: TOPIC_ARN });
    aws.denied.add("setNotificationTopic");
    const r = await ensureSesFeedback({
      identity: "mail.a.com",
      listmonkUrl: LISTMONK_URL,
      aws,
      listmonk: new FakeListmonk(),
      region: REGION,
      confirmTimeoutMs: 0,
    });
    assert.equal(r.iamGap, true);
    assert.deepEqual(r.warnings, ["missing IAM permission ses:SetIdentityNotificationTopic"]);
    // Bounce is already routed; only Complaint needs the command.
    assert.deepEqual(r.manualTopics, [
      { identity: "mail.a.com", type: "Complaint", topicArn: TOPIC_ARN },
    ]);
    const lines = renderSesFeedbackLines(r).map((l) => l.text.trim());
    assert.ok(
      lines.includes(
        `aws ses set-identity-notification-topic --identity mail.a.com --notification-type Complaint --sns-topic ${TOPIC_ARN} --region ${REGION}`,
      ),
      lines.join("\n"),
    );
  },
);

await expect("an identity IAM won't let us read still gets both commands", async () => {
  const aws = new FakeAws();
  aws.addIdentity("mail.a.com");
  aws.denied.add("getNotificationTopics");
  aws.denied.add("setNotificationTopic");
  const r = await run(aws, new FakeListmonk(), "mail.a.com");
  assert.deepEqual(
    r.manualTopics.map((t) => t.type),
    ["Bounce", "Complaint"],
  );
  assert.ok(
    !aws.writes.some((w) => w.startsWith("setNotificationTopic")),
    "no set without knowing what is there",
  );
});

await expect("a healthy run carries no commands", async () => {
  const { aws, listmonk } = healthyAccount();
  const r = await run(aws, listmonk, "mail.a.com");
  assert.deepEqual(r.manualTopics, []);
  assert.ok(!renderSesFeedbackLines(r).some((l) => l.text.includes("aws ses")));
});

await expect("a Listmonk API user without Settings: All is a warning, not a crash", async () => {
  const aws = new FakeAws();
  aws.addIdentity("mail.a.com");
  const listmonk = new FakeListmonk();
  listmonk.failRead = "Listmonk GET /api/settings failed: HTTP 403 permission denied";
  const r = await run(aws, listmonk, "mail.a.com");
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /Settings: All/);
  assert.deepEqual(r.typesSetThisRun, ["Bounce", "Complaint"]);
});

console.log("\ndestroy:");

await expect(
  "clears only this identity's topics; shared topic, subscription, suppression, Listmonk stay",
  async () => {
    const { aws, listmonk } = healthyAccount();
    aws.addIdentity("mail.b.com");
    const r = await run(aws, listmonk, "mail.b.com");
    aws.writes = [];
    listmonk.writes = [];

    assert.equal(
      await clearSesFeedbackTopics(aws, "mail.b.com", TOPIC_ARN, r.typesSetThisRun),
      "cleared",
    );
    assert.deepEqual(aws.writes, [
      "setNotificationTopic mail.b.com Bounce (clear)",
      "setNotificationTopic mail.b.com Complaint (clear)",
    ]);
    assert.deepEqual(listmonk.writes, []);
    assert.deepEqual(
      aws.topics.get(TOPIC_ARN)?.map((s) => s.endpoint),
      [WEBHOOK],
    );
    assert.deepEqual(aws.suppressed, ["BOUNCE", "COMPLAINT"]);
    const other = aws.identities.get("mail.a.com");
    assert.equal(other?.bounceTopic, TOPIC_ARN, "another project keeps its bounces");
    assert.equal(other?.complaintTopic, TOPIC_ARN);
  },
);

await expect("leaves a type that was re-pointed since, and one this run didn't set", async () => {
  const aws = new FakeAws();
  const theirs = `arn:aws:sns:${REGION}:${ACCOUNT}:their-bounces`;
  aws.addIdentity("mail.a.com", { bounceTopic: theirs, complaintTopic: TOPIC_ARN });
  assert.equal(await clearSesFeedbackTopics(aws, "mail.a.com", TOPIC_ARN, ["Bounce"]), "not-found");
  assert.deepEqual(aws.writes, []);
});

await expect("an identity already deleted is not-found, no write", async () => {
  const aws = new FakeAws();
  assert.equal(
    await clearSesFeedbackTopics(aws, "mail.gone.com", TOPIC_ARN, ["Bounce", "Complaint"]),
    "not-found",
  );
  assert.deepEqual(aws.writes, []);
});

await expect("the rollback step calls only clearSesFeedbackTopics from the feedback module", () => {
  const src = readFileSync(join(HERE, "src/deploy/rollback.ts"), "utf8");
  const start = src.indexOf('case "sesNotificationTopics": {');
  assert.ok(start > 0, "rollback executes sesNotificationTopics");
  const block = src.slice(start, src.indexOf("case ", start + 10));
  assert.ok(block.includes("clearSesFeedbackTopics("));
  for (const forbidden of [
    "createTopic",
    "subscribe",
    "putSuppressedReasons",
    "putSetting",
    "Delete",
  ]) {
    assert.ok(!block.includes(forbidden), `rollback block must not call ${forbidden}`);
  }
  const ledger = readFileSync(join(HERE, "src/utils/run-ledger.ts"), "utf8");
  assert.ok(!/kind: "sesFeedbackTopic"|kind: "snsTopic"|kind: "snsSubscription"/.test(ledger));
});

console.log("\ndoctor:");

function doctorSource(aws: FakeAws, listmonk: FakeListmonk) {
  return { aws, listmonk, listmonkUrl: LISTMONK_URL };
}

await expect("healthy account: four ok rows, no write", async () => {
  const { aws, listmonk } = healthyAccount();
  const rows = await checkSesBounceFeedback(doctorSource(aws, listmonk));
  assert.deepEqual(
    rows.map((r) => r.status),
    ["ok", "ok", "ok", "ok"],
  );
  assert.deepEqual(aws.writes, []);
  assert.deepEqual(listmonk.writes, []);
});

await expect(
  "reports every broken piece as a failure, read-only, and --fix repairs all of it",
  async () => {
    const aws = new FakeAws();
    aws.autoConfirm = false;
    aws.topics.set(TOPIC_ARN, [
      { subscriptionArn: "PendingConfirmation", protocol: "https", endpoint: WEBHOOK },
    ]);
    aws.addIdentity("mail.a.com", { bounceTopic: TOPIC_ARN, complaintTopic: TOPIC_ARN });
    aws.addIdentity("mail.trackyourtime.dev");
    aws.addIdentity("mail.b.com", { bounceTopic: TOPIC_ARN });
    aws.addIdentity("mail.pending.com", {}, false);
    const listmonk = new FakeListmonk();

    const rows = await checkSesBounceFeedback(doctorSource(aws, listmonk));
    assert.deepEqual(aws.writes, [], "doctor itself never writes");
    assert.deepEqual(listmonk.writes, []);
    assert.deepEqual(
      rows.map((r) => r.status),
      ["fail", "fail", "fail", "fail"],
    );
    const [identities, subscription, suppression, settings] = rows;
    assert.match(identities.detail ?? "", /2 of 3 verified/);
    assert.match(identities.detail ?? "", /mail\.trackyourtime\.dev \(Bounce \+ Complaint\)/);
    assert.match(identities.detail ?? "", /mail\.b\.com \(Complaint\)/);
    assert.ok(
      !(identities.detail ?? "").includes("mail.pending.com"),
      "unverified identities skipped",
    );
    assert.match(subscription.detail ?? "", /pending confirmation/);
    assert.match(suppression.detail ?? "", /BOUNCE \+ COMPLAINT/);
    assert.match(
      settings.detail ?? "",
      /bounce\.enabled, bounce\.webhooks_enabled, bounce\.ses_enabled/,
    );

    aws.autoConfirm = true; // Listmonk confirms once bounce.ses_enabled is on.
    for (const r of rows) {
      assert.ok(r.repair, `${r.name} offers a repair`);
      await r.repair.run();
    }

    aws.writes = [];
    listmonk.writes = [];
    const after = await checkSesBounceFeedback(doctorSource(aws, listmonk));
    assert.deepEqual(
      after.map((r) => r.status),
      ["ok", "ok", "ok", "ok"],
    );
    assert.equal(aws.identities.get("mail.b.com")?.complaintTopic, TOPIC_ARN);
    assert.equal(aws.identities.get("mail.pending.com")?.bounceTopic, null);
    assert.deepEqual(aws.writes, []);
  },
);

await expect(
  "repairs are idempotent: running one twice writes nothing the second time",
  async () => {
    const aws = new FakeAws();
    aws.addIdentity("mail.a.com");
    const listmonk = new FakeListmonk();
    const rows = await checkSesBounceFeedback(doctorSource(aws, listmonk));
    for (const r of rows) await r.repair?.run();
    const settingsWrites = listmonk.writes.length;
    const identityWrites = aws.writes.filter((w) => w.startsWith("setNotificationTopic")).length;
    for (const r of rows) await r.repair?.run();
    assert.equal(listmonk.writes.length, settingsWrites);
    assert.equal(
      aws.writes.filter((w) => w.startsWith("setNotificationTopic")).length,
      identityWrites,
    );
    assert.equal(aws.writes.filter((w) => w.startsWith("subscribe")).length, 1);
    assert.equal(aws.writes.filter((w) => w.startsWith("putSuppressedReasons")).length, 1);
  },
);

await expect("a topic deleted under the identities is a failure the repair recreates", async () => {
  const { aws, listmonk } = healthyAccount();
  aws.topics.clear();
  const rows = await checkSesBounceFeedback(doctorSource(aws, listmonk));
  const sub = rows.find((r) => r.name.includes("subscription"));
  assert.equal(sub?.status, "fail");
  assert.match(sub?.detail ?? "", /no longer exists/);
  await sub?.repair?.run();
  assert.deepEqual(
    aws.topics.get(TOPIC_ARN)?.map((s) => s.endpoint),
    [WEBHOOK],
  );
});

await expect("no identity routes to the topic: subscription row fails with a repair", async () => {
  const aws = new FakeAws();
  aws.addIdentity("mail.a.com");
  const rows = await checkSesBounceFeedback(doctorSource(aws, new FakeListmonk()));
  const sub = rows.find((r) => r.name.includes("subscription"));
  assert.equal(sub?.status, "fail");
  assert.match(sub?.detail ?? "", /can't locate it read-only/);
  assert.ok(sub?.repair);
});

await expect(
  "missing read permissions are warnings naming the action, never failures",
  async () => {
    const { aws, listmonk } = healthyAccount();
    aws.denied.add("getNotificationTopics");
    aws.denied.add("getSuppressedReasons");
    const rows = await checkSesBounceFeedback(doctorSource(aws, listmonk));
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
    assert.equal(byName["SES bounce feedback (identities)"].status, "warn");
    assert.match(byName["SES bounce feedback (identities)"].detail ?? "", /missing IAM permission/);
    assert.ok(
      (byName["SES bounce feedback (identities)"].hint ?? []).join(" ").includes("ses:GetAccount"),
    );
    assert.equal(byName["SES bounce feedback (SNS subscription)"].status, "skip");
    assert.equal(byName["SES bounce feedback (account suppression)"].status, "warn");
    assert.ok(rows.every((r) => r.status !== "fail"));
  },
);

await expect("a verified identity routed to another topic warns, doesn't fail", async () => {
  const { aws, listmonk } = healthyAccount();
  aws.addIdentity("mail.x.com", {
    bounceTopic: `arn:aws:sns:${REGION}:${ACCOUNT}:other`,
    complaintTopic: `arn:aws:sns:${REGION}:${ACCOUNT}:other`,
  });
  const rows = await checkSesBounceFeedback(doctorSource(aws, listmonk));
  assert.equal(rows[0].status, "warn");
  assert.match(rows[0].detail ?? "", /mail\.x\.com Bounce → other/);
});

await expect(
  "identities all on another topic on purpose: subscription row skips, no failure",
  async () => {
    const aws = new FakeAws();
    const other = `arn:aws:sns:${REGION}:${ACCOUNT}:other`;
    aws.addIdentity("mail.x.com", { bounceTopic: other, complaintTopic: other });
    aws.suppressed = ["BOUNCE", "COMPLAINT"];
    const listmonk = healthyAccount().listmonk;
    const rows = await checkSesBounceFeedback(doctorSource(aws, listmonk));
    assert.ok(rows.every((r) => r.status !== "fail"));
    assert.equal(rows.find((r) => r.name.includes("subscription"))?.status, "skip");
  },
);

console.log("\nbasic auth on the SNS endpoint:");

const CREDS: WebhookCredentials = {
  user: "0a1b2c3d4e5f60718293a4b5",
  password: "f".repeat(64),
};
const CRED_WEBHOOK = `https://${CREDS.user}:${CREDS.password}@listmonk.example.com/webhooks/service/ses`;
const MASKED_WEBHOOK = `https://${CREDS.user}:****@listmonk.example.com/webhooks/service/ses`;

function runWithCreds(aws: FakeAws, listmonk: FakeListmonk, identity: string) {
  return ensureSesFeedback({
    identity,
    listmonkUrl: LISTMONK_URL,
    webhookCredentials: CREDS,
    aws,
    listmonk,
    confirmTimeoutMs: 0,
  });
}

function assertNoPassword(lines: string[]) {
  for (const line of lines) {
    assert.ok(!line.includes(CREDS.password), `password leaked into: ${line}`);
  }
}

await expect("puts the credentials into the webhook URL and redacts them for output", () => {
  assert.equal(listmonkSesWebhookUrl(LISTMONK_URL, CREDS), CRED_WEBHOOK);
  assert.equal(listmonkSesWebhookUrl(LISTMONK_URL, null), WEBHOOK);
  assert.equal(redactEndpoint(CRED_WEBHOOK), MASKED_WEBHOOK);
  assert.equal(redactEndpoint(WEBHOOK), WEBHOOK);
});

await expect(
  "the credentialed endpoint counts as ours as listed and with the password masked",
  () => {
    const sub = (endpoint: string): SnsSubscription[] => [
      { subscriptionArn: `${TOPIC_ARN}:sub-1`, protocol: "https", endpoint },
    ];
    assert.equal(subscriptionState(sub(CRED_WEBHOOK), CRED_WEBHOOK), "confirmed");
    assert.equal(subscriptionState(sub(MASKED_WEBHOOK), CRED_WEBHOOK), "confirmed");
    assert.equal(subscriptionState(sub(WEBHOOK), CRED_WEBHOOK), "missing", "plain is not ours");
    assert.equal(subscriptionState(sub(CRED_WEBHOOK), WEBHOOK), "missing", "and the reverse");
    const otherUser = MASKED_WEBHOOK.replace(CREDS.user, "ffffffffffffffffffffffff");
    assert.equal(subscriptionState(sub(otherUser), CRED_WEBHOOK), "missing", "another user");
  },
);

await expect(
  "replaces the plain subscription once the credentialed one is confirmed, then goes quiet",
  async () => {
    const { aws, listmonk } = healthyAccount();
    aws.maskPasswords = true;
    const r = await runWithCreds(aws, listmonk, "mail.a.com");
    assert.deepEqual(r.warnings, []);
    assert.equal(r.subscription, "confirmed");
    assert.equal(r.credentialed, true);
    assert.equal(r.webhookUrl, MASKED_WEBHOOK);
    assert.deepEqual(r.supersededRemoved, [WEBHOOK]);
    assert.deepEqual(aws.writes, [`subscribe ${CRED_WEBHOOK}`, `unsubscribe ${TOPIC_ARN}:sub-1`]);
    assert.deepEqual(
      aws.topics.get(TOPIC_ARN)?.map((s) => s.endpoint),
      [CRED_WEBHOOK],
    );
    const lines = renderSesFeedbackLines(r).map((l) => l.text);
    assertNoPassword([...lines, JSON.stringify(r)]);
    assert.ok(lines.some((l) => l.includes("removed the older subscription")));
    assert.ok(lines.some((l) => l.includes("hatchkit ses webhook-auth")));

    // SNS lists the password masked; the second run still finds it.
    aws.writes = [];
    const again = await runWithCreds(aws, listmonk, "mail.a.com");
    assert.equal(again.subscription, "confirmed");
    assert.equal(again.subscribedThisRun, false);
    assert.deepEqual(aws.writes, []);
  },
);

await expect("keeps the plain subscription while the credentialed one is pending", async () => {
  const { aws, listmonk } = healthyAccount();
  aws.autoConfirm = false;
  const r = await runWithCreds(aws, listmonk, "mail.a.com");
  assert.equal(r.subscription, "pending");
  assert.deepEqual(r.supersededRemoved, []);
  assert.ok(!aws.writes.some((w) => w.startsWith("unsubscribe")));
  assert.ok(aws.topics.get(TOPIC_ARN)?.some((s) => s.endpoint === WEBHOOK));
  assertNoPassword(renderSesFeedbackLines(r).map((l) => l.text));
});

await expect(
  "a refused sns:Unsubscribe is a warning with the command, and the rest still runs",
  async () => {
    const { aws, listmonk } = healthyAccount();
    aws.denied.add("unsubscribe");
    aws.suppressed = [];
    const r = await runWithCreds(aws, listmonk, "mail.a.com");
    assert.equal(r.subscription, "confirmed");
    assert.ok(r.iamGap);
    assert.ok(r.warnings.some((w) => w.includes("sns:Unsubscribe")));
    assert.deepEqual(r.supersededLeft, [
      { subscriptionArn: `${TOPIC_ARN}:sub-1`, endpoint: WEBHOOK },
    ]);
    assert.deepEqual(r.suppressionAdded, ["BOUNCE", "COMPLAINT"]);
    const lines = renderSesFeedbackLines(r).map((l) => l.text);
    assert.ok(
      lines.some((l) =>
        l.includes(`aws sns unsubscribe --subscription-arn ${TOPIC_ARN}:sub-1 --region ${REGION}`),
      ),
    );
    assertNoPassword(lines);
  },
);

await expect(
  "doctor: a second subscription of the webhook warns, and --fix removes it",
  async () => {
    const { aws, listmonk } = healthyAccount();
    aws.maskPasswords = true;
    aws.topics.get(TOPIC_ARN)?.push({
      subscriptionArn: `${TOPIC_ARN}:sub-2`,
      protocol: "https",
      endpoint: CRED_WEBHOOK,
    });
    const src = { aws, listmonk, listmonkUrl: LISTMONK_URL, webhookCredentials: CREDS };
    const rows = await checkSesBounceFeedback(src);
    const sub = rows.find((r) => r.name.includes("subscription"));
    assert.equal(sub?.status, "warn");
    assert.match(sub?.detail ?? "", /twice/);
    assertNoPassword(
      rows.flatMap((r) => [r.detail ?? "", ...(r.hint ?? []), r.repair?.prompt ?? ""]),
    );
    assert.deepEqual(aws.writes, []);
    await sub?.repair?.run();
    assert.deepEqual(aws.writes, [`unsubscribe ${TOPIC_ARN}:sub-1`]);
    const after = await checkSesBounceFeedback(src);
    assert.deepEqual(
      after.map((r) => r.status),
      ["ok", "ok", "ok", "ok"],
    );
  },
);

await expect(
  "doctor --fix subscribes the credentialed endpoint and drops the plain one",
  async () => {
    const { aws, listmonk } = healthyAccount();
    const src = { aws, listmonk, listmonkUrl: LISTMONK_URL, webhookCredentials: CREDS };
    const rows = await checkSesBounceFeedback(src);
    const sub = rows.find((r) => r.name.includes("subscription"));
    assert.equal(sub?.status, "fail");
    assertNoPassword([sub?.detail ?? "", sub?.repair?.prompt ?? ""]);
    const msg = (await sub?.repair?.run()) ?? "";
    assertNoPassword([msg]);
    assert.deepEqual(
      aws.topics.get(TOPIC_ARN)?.map((s) => s.endpoint),
      [CRED_WEBHOOK],
    );
  },
);

await expect("Traefik labels: auth router above Listmonk's, bcrypt hash of the password", () => {
  const labels = traefikBasicAuthLabels({
    host: "listmonk.example.com",
    credentials: CREDS,
    service: "http-0-abc-listmonk",
  });
  const get = (suffix: string) =>
    labels.find((l) => l.toLowerCase().startsWith(`traefik.http.${suffix}=`.toLowerCase()));
  const rule = "Host(`listmonk.example.com`) && PathPrefix(`/webhooks/service`)";
  for (const r of ["listmonk-sns-https", "listmonk-sns-http"]) {
    assert.equal(get(`routers.${r}.rule`), `traefik.http.routers.${r}.rule=${rule}`);
    assert.equal(get(`routers.${r}.priority`), `traefik.http.routers.${r}.priority=1000`);
    assert.ok(get(`routers.${r}.middlewares`)?.endsWith("=listmonk-sns-auth"));
    assert.ok(get(`routers.${r}.service`)?.endsWith("=http-0-abc-listmonk"));
  }
  assert.ok(get("routers.listmonk-sns-https.tls.certresolver")?.endsWith("=letsencrypt"));
  assert.ok(get("routers.listmonk-sns-https.entryPoints")?.endsWith("=https"));
  assert.ok(get("routers.listmonk-sns-http.entryPoints")?.endsWith("=http"));
  assert.ok(get("middlewares.listmonk-sns-auth.basicauth.removeheader")?.endsWith("=true"));
  const users = get("middlewares.listmonk-sns-auth.basicauth.users") ?? "";
  const [user, hash] = users.split("=")[1].split(/:(.*)/s);
  assert.equal(user, CREDS.user);
  assert.match(hash, /^\$2y\$10\$/);
  assert.ok(bcrypt.compareSync(CREDS.password, hash), "hash matches the password");
  assertNoPassword(labels);

  // Coolify escapes the raw label for compose. Plain compose needs the
  // explicit flag; both must deliver the same bcrypt hash to Traefik.
  const raw = traefikBasicAuthLabels({
    host: "listmonk.example.com",
    credentials: CREDS,
    hash,
  });
  assert.ok(!raw.some((l) => l.includes(".service=")), "no service: container default");
  const compose = traefikBasicAuthLabels({
    host: "listmonk.example.com",
    credentials: CREDS,
    hash,
    escapeDollars: true,
  });
  assert.deepEqual(compose.map((label) => label.replaceAll("$$", "$")), raw);
  const composeUsers = compose.find((l) => l.includes(".basicauth.users=")) ?? "";
  assert.ok(composeUsers.includes(`=${CREDS.user}:$$2y$$10$$`), "compose escapes bcrypt delimiters");
  const composedHash = composeUsers.split("=")[1].split(/:(.*)/s)[1].replaceAll("$$", "$");
  assert.ok(bcrypt.compareSync(CREDS.password, composedHash), "compose preserves the password hash");
});

await expect("Coolify leaves scoped middleware off its generated site routers", () => {
  const labels = traefikBasicAuthLabels({
    host: "listmonk.example.com",
    credentials: CREDS,
    hash: "$2y$10$fixture",
  });
  // Coolify's fqdnLabelsForTraefik discovers middleware definitions with
  // this case-sensitive pattern, then adds them to the default routers.
  const discovered = (entries: string[]) =>
    entries.flatMap((label) => {
      const match = /traefik\.http\.middlewares\.(.*?)(\.|$)/.exec(label);
      return match ? [match[1]] : [];
    });
  assert.deepEqual(discovered(labels), []);
  assert.deepEqual(discovered(labels.map((label) => label.toLowerCase())), [
    "listmonk-sns-auth",
    "listmonk-sns-auth",
  ]);
  assert.equal(
    labels.filter((label) => /routers\..*\.middlewares=listmonk-sns-auth$/.test(label)).length,
    2,
    "both explicit webhook routers still attach the middleware",
  );
});

console.log("\nListmonk adapter:");

await expect(
  "PUTs one key to /api/settings/<key> with raw `true`, then waits for the reload",
  async () => {
    const realFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push(`${init?.method ?? "GET"} ${url.pathname} ${init?.body ?? ""}`.trim());
      return new Response(JSON.stringify({ data: true }), { status: 200 });
    }) as typeof fetch;
    try {
      const listmonk = createSesFeedbackListmonk({
        url: LISTMONK_URL,
        apiUser: "hatchkit",
        apiToken: "tok",
      });
      await listmonk.putSetting("bounce.ses_enabled", true);
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.deepEqual(calls, ["PUT /api/settings/bounce.ses_enabled true", "GET /api/health"]);
  },
);

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\nAll SES feedback tests passed.");
