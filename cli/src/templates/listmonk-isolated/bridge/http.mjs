import { createHash } from "node:crypto";
import { authenticated } from "../relay/message.mjs";
import { verifySns } from "./sns.mjs";
export function bridgeHandler(config, bridge, relay) {
  return async (req, res) => {
    if (req.url === "/send") return relay(req, res);
    const respond = (status) => {
      res.writeHead(status, { "Cache-Control": "no-store", "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: status === 200 }));
    };
    if (req.method === "GET" && req.url === "/health") {
      try {
        await bridge.health();
        return respond(200);
      } catch {
        return respond(503);
      }
    }
    if (req.method !== "POST") return respond(404);
    const feedback = req.url === "/feedback";
    if (!feedback && !["/prepare", "/confirm"].includes(req.url)) return respond(404);
    if (
      !feedback &&
      !authenticated(req.headers.authorization, {
        user: config.appUser,
        password: config.appPassword,
      })
    )
      return respond(401);
    try {
      const chunks = [];
      let size = 0;
      for await (const part of req) {
        size += part.length;
        if (size > 131072) return respond(413);
        chunks.push(part);
      }
      const raw = Buffer.concat(chunks),
        body = JSON.parse(raw.toString());
      if (feedback) {
        await verifySns(body, config.topic, config.region);
        if (body.Type === "SubscriptionConfirmation") {
          await bridge.target.query(
            "INSERT INTO hatchkit_newsletter_bridge.confirmations(topic,token) VALUES($1,$2) ON CONFLICT(topic) DO UPDATE SET token=excluded.token,at=now()",
            [body.TopicArn, body.Token],
          );
        } else {
          const event = JSON.parse(body.Message);
          if (
            event.mail?.source !== config.from ||
            event.mail?.sendingAccountId !== config.account ||
            event.mail?.tags?.["ses:configuration-set"]?.[0] !== config.configurationSet
          )
            throw Error("Foreign SES scope");
          await bridge.feedback(
            body,
            event,
            createHash("sha256").update(body.Message).digest("hex"),
          );
        }
      } else await bridge.prepare(body.token, body.role, req.url === "/confirm");
      respond(200);
    } catch {
      respond(feedback ? 503 : 409);
    }
  };
}
