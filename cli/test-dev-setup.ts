import assert from "node:assert/strict";
import { isTailscaleIpv4, localDevDomainSafetyIssue } from "./src/dev-setup.js";

assert.equal(localDevDomainSafetyIssue("local.ricoslabs.com"), null);
assert.equal(localDevDomainSafetyIssue("*.local.ricoslabs.com"), null);
assert.match(localDevDomainSafetyIssue("ricoslabs.com") ?? "", /Unsafe local-dev domain/);
assert.match(localDevDomainSafetyIssue("dev.ricoslabs.com") ?? "", /Unsafe local-dev domain/);
assert.match(localDevDomainSafetyIssue("local.com") ?? "", /Unsafe local-dev domain/);

assert.equal(isTailscaleIpv4("100.64.0.0"), true);
assert.equal(isTailscaleIpv4("100.127.255.255"), true);
assert.equal(isTailscaleIpv4("100.128.0.0"), false);
assert.equal(isTailscaleIpv4("192.0.2.10"), false);
assert.equal(isTailscaleIpv4("fd7a:115c:a1e0::1"), false);

console.log("dev setup safety checks ok");
