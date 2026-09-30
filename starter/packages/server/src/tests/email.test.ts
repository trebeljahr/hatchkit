/**
 * The Listmonk `/api/tx` body every account email is sent with.
 *
 * Verification, password reset and invitation mail all go through
 * `sendEmail`, and none of their recipients is a newsletter subscriber.
 * Listmonk's default recipient mode answers 400 for exactly those people,
 * and `sendEmail`'s callers only log the error — so a wrong body shows up as
 * a new account that never receives its verification link, not as a
 * failing request.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { listmonkTxBody } from "../services/email.js";

const listmonk = {
  LISTMONK_FROM: "",
  LISTMONK_FROM_EMAIL: "noreply@mail.example.com",
  LISTMONK_TX_TEMPLATE_ID: "1",
};

describe("listmonkTxBody", () => {
  const params = { to: "new@example.com", subject: "Verify", text: "a < b" };

  test("sends to people who are not newsletter subscribers", () => {
    const body = listmonkTxBody(params, listmonk);
    assert.equal(body.subscriber_mode, "external");
    assert.equal(body.subscriber_email, "new@example.com");
  });

  test("prefers the display-name sender and names the template", () => {
    const body = listmonkTxBody(params, {
      ...listmonk,
      LISTMONK_FROM: "Example <noreply@mail.example.com>",
    });
    assert.equal(body.from_email, "Example <noreply@mail.example.com>");
    assert.equal(body.template_id, 1);
  });

  test("selects the dedicated messenger only when configured", () => {
    assert.equal(listmonkTxBody(params, listmonk).messenger, undefined);
    assert.equal(listmonkTxBody(params, { ...listmonk, LISTMONK_MESSENGER: "project-ses" }).messenger, "project-ses");
  });

  test("escapes a plain-text body and passes HTML through", () => {
    assert.deepEqual(listmonkTxBody(params, listmonk).data, {
      subject: "Verify",
      body: "<pre>a &lt; b</pre>",
    });
    assert.deepEqual(listmonkTxBody({ ...params, html: "<p>hi</p>" }, listmonk).data, {
      subject: "Verify",
      body: "<p>hi</p>",
    });
  });
});
