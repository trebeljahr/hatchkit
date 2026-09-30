import { createVerify } from "node:crypto";
/** Exact SNS host, no redirects, bounded cert fetch, signature before payload use. */
export async function verifySns(envelope, topic, region, getCertificate = fetch) {
  if (
    !envelope ||
    envelope.TopicArn !== topic ||
    !["Notification", "SubscriptionConfirmation"].includes(envelope.Type) ||
    !["1", "2"].includes(envelope.SignatureVersion)
  )
    throw Error("Foreign SNS envelope");
  const url = new URL(envelope.SigningCertURL);
  if (
    url.protocol !== "https:" ||
    url.hostname !== `sns.${region}.amazonaws.com` ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/SimpleNotificationService-[a-zA-Z0-9]+\.pem$/.test(url.pathname)
  )
    throw Error("Invalid SNS certificate origin");
  const response = await getCertificate(url.href, {
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw Error("Certificate unavailable");
  const bytes = [];
  let size = 0;
  for await (const part of response.body) {
    size += part.length;
    if (size > 65536) throw Error("Certificate too large");
    bytes.push(Buffer.from(part));
  }
  const fields =
    envelope.Type === "Notification"
      ? [
          "Message",
          "MessageId",
          ...(envelope.Subject === undefined ? [] : ["Subject"]),
          "Timestamp",
          "TopicArn",
          "Type",
        ]
      : ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"];
  if (
    fields.some((k) => typeof envelope[k] !== "string") ||
    !Number.isFinite(Date.parse(envelope.Timestamp))
  )
    throw Error("Malformed SNS envelope");
  const canonical = fields.map((k) => `${k}\n${envelope[k]}\n`).join("");
  if (
    !createVerify(envelope.SignatureVersion === "2" ? "RSA-SHA256" : "RSA-SHA1")
      .update(canonical)
      .verify(Buffer.concat(bytes), envelope.Signature, "base64")
  )
    throw Error("Invalid SNS signature");
  return envelope;
}
