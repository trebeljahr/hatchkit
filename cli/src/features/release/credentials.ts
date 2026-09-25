/*
 * cli/src/features/release/credentials.ts — the catalog behind the
 * generated credentials doc.
 *
 * A channel knows the NAMES of the repo secrets it needs; it does not
 * know what any of them is or where a person goes to produce one. That
 * knowledge is here, in one table keyed by secret name, so adding a
 * store is adding rows rather than editing prose in three places.
 *
 * TWO THINGS THIS FILE DECIDES
 * ----------------------------
 *  1. {@link CredentialGroup.absentNote} — the sentence a person reads
 *     to find out what a missing secret actually costs them. It is the
 *     most load-bearing string in the feature: the whole point of the
 *     release pipeline is that an absent credential never turns into a
 *     quiet publish. Every note therefore describes one of exactly
 *     three outcomes — built but not uploaded, built unsigned and not
 *     uploaded, or the workflow fails — and says which, in words a
 *     reader can check without running anything.
 *
 *  2. {@link signingSecretsFor} — the split between "absent means the
 *     upload is skipped" and "absent means the artifact is unsigned".
 *     The `no-unsigned-publish` policy rule is built from the second
 *     set alone. Putting a store API key in it would block releases
 *     that are fine; leaving a signing key out of it would permit the
 *     one thing the rule exists to prevent.
 *
 * Derivation is a pure function of the channels list. A project whose
 * only channel is a web deploy declares no credentials and gets no
 * groups — an empty array is the correct answer, not a degenerate one.
 */

import type { CredentialGroup, CredentialSecret, ReleaseChannel } from "./types.js";

// ---------------------------------------------------------------------------
// Families
// ---------------------------------------------------------------------------

/** A set of secrets that come from one vendor relationship and fail
 *  together. The family — not the individual secret — is what decides
 *  whether absence means "unsigned" or "not uploaded", which vendor UI
 *  step no tool can do, and which destination goes unreached. */
type SecretFamily =
  /** Azure Trusted Signing: signs the Windows installer. */
  | "azure"
  /** Apple certificate + provisioning profile: signs the iOS archive. */
  | "apple-identity"
  /** Developer ID certificate: signs and notarizes a macOS desktop
   *  bundle. Distinct from `apple-identity`, which is an App Store
   *  distribution certificate — Apple will not let one do the other's
   *  job, and a project can hold either without the other. */
  | "apple-developer-id"
  /** App Store Connect API key: uploads an already-signed IPA. */
  | "apple-store-api"
  /** Upload keystore: signs the AAB. */
  | "android-keystore"
  /** Play service account: uploads an already-signed AAB. */
  | "play-api"
  /** butler credentials: uploads desktop builds to itch.io. */
  | "itch"
  /** Chrome Web Store API OAuth client. */
  | "chrome"
  /** addons.mozilla.org signing API credential. */
  | "amo"
  /** npm publish token. */
  | "npm";

interface FamilyRow {
  /** Where artifacts land when this family is present. `null` for a
   *  family that signs rather than uploads — naming a destination for
   *  a signing key would suggest the key alone gets it there. */
  destination: string | null;
  /** One-time steps the vendor forces through its own UI. Hatchkit
   *  cannot automate these and does not pretend it will. */
  manualSteps: string[];
}

const FAMILIES: Record<SecretFamily, FamilyRow> = {
  azure: {
    destination: null,
    manualSteps: [
      "Finish Azure Trusted Signing identity validation. While the certificate profile is still Private Trust, installers warn under SmartScreen.",
    ],
  },
  "apple-identity": {
    destination: null,
    manualSteps: [
      "Confirm Apple identity validation at developer.apple.com. Until it clears, uploads succeed but distribution stalls.",
    ],
  },
  "apple-developer-id": {
    destination: null,
    manualSteps: [
      "Create a Developer ID Application certificate at developer.apple.com, Certificates. It is a different certificate from the App Store one, and a Developer ID build cannot be signed with an App Store certificate.",
    ],
  },
  "apple-store-api": {
    destination: "TestFlight",
    manualSteps: [
      "Fill listing copy, screenshots and age rating in App Store Connect before promoting a TestFlight build to the public.",
    ],
  },
  "android-keystore": {
    destination: null,
    // No vendor UI step: Hatchkit generates this keystore itself. The
    // one-time Play Console work hangs off `play-api`, where the first
    // manual upload actually happens.
    manualSteps: [],
  },
  "play-api": {
    destination: "Google Play",
    manualSteps: [
      "Create the app record in Google Play Console. The Edits API cannot create the first one.",
      "Upload the first signed AAB by hand. Play refuses API uploads until the distribution agreement is accepted once.",
      "Grant the service account Release manager on this app under Setup, API access. Uploads fail with 403 until you do.",
    ],
  },
  itch: {
    destination: "itch.io",
    manualSteps: [
      "Create the itch.io project page. butler pushes channels to a page that already exists; it cannot create one.",
    ],
  },
  chrome: {
    destination: "the Chrome Web Store",
    manualSteps: [
      "Pay the one-time Chrome Web Store developer registration fee.",
      "Submit the first version by hand in the Developer Dashboard. The API can only update an item that already exists.",
    ],
  },
  amo: {
    destination: "addons.mozilla.org",
    manualSteps: [
      "Create the first add-on listing on addons.mozilla.org by hand. The signing API updates an existing add-on; it does not create one.",
    ],
  },
  npm: {
    destination: "the npm registry",
    manualSteps: [],
  },
};

// ---------------------------------------------------------------------------
// The secret catalog
// ---------------------------------------------------------------------------

interface CatalogRow {
  family: SecretFamily;
  /** What the value is, in one line. Never an example value — these
   *  end up in a committed doc. */
  what: string;
  /** Where a person goes to produce it. A Hatchkit command whenever
   *  one produces the value, because that is the shorter true answer
   *  than the console page it wraps. */
  where: string;
}

/** One row per secret. A new store is a new block of rows and a new
 *  family; nothing else in this file changes. */
const SECRETS: Record<string, CatalogRow> = {
  // --- Azure Trusted Signing (Windows) -------------------------------------
  AZURE_TENANT_ID: {
    family: "azure",
    what: "Azure AD tenant the code-signing service principal belongs to.",
    where: "`hatchkit signing org-init`, Azure section.",
  },
  AZURE_CLIENT_ID: {
    family: "azure",
    what: "App (client) ID of the service principal that signs.",
    where: "`hatchkit signing org-init`, Azure section. Created by `az ad sp create-for-rbac`.",
  },
  AZURE_CLIENT_SECRET: {
    family: "azure",
    what: "Secret for that service principal.",
    where:
      "`hatchkit signing org-init` stores it in the macOS keychain; `hatchkit signing` pushes it from there.",
  },
  AZURE_TS_ACCOUNT: {
    family: "azure",
    what: "Name of the Trusted Signing (Microsoft.CodeSigning) account.",
    where: "Azure Portal, Trusted Signing accounts. Recorded by `hatchkit signing org-init`.",
  },
  AZURE_TS_PROFILE: {
    family: "azure",
    what: "Certificate profile on that account: Public Trust, or Private Trust while review runs.",
    where: "Azure Portal, the Trusted Signing account's certificate profiles.",
  },
  AZURE_TS_ENDPOINT: {
    family: "azure",
    what: "Regional signing endpoint, in the form https://<region>.codesigning.azure.net.",
    where: "Shown on the Trusted Signing account overview.",
  },

  // --- Apple (iOS) ---------------------------------------------------------
  APPLE_TEAM_ID: {
    family: "apple-identity",
    what: "Ten-character Apple Developer team identifier.",
    where: "developer.apple.com, Membership. Recorded by `hatchkit signing org-init`.",
  },
  APPLE_CERT_P12_BASE64: {
    family: "apple-identity",
    what: "Base64 of the Apple Distribution .p12 the runner imports into a temporary keychain.",
    where: "`hatchkit signing` encodes the .p12 named in the org config.",
  },
  APPLE_CERT_P12_PASSWORD: {
    family: "apple-identity",
    what: "Password that opens that .p12.",
    where: "`hatchkit signing org-init` stores it in the macOS keychain.",
  },
  APPLE_PROVISIONING_PROFILE_B64: {
    family: "apple-identity",
    what: "Base64 of the App Store provisioning profile for this app's bundle ID.",
    where:
      "`hatchkit signing` creates or reuses the profile through the App Store Connect API and encodes it.",
  },
  APPLE_PROVISIONING_PROFILE_NAME: {
    family: "apple-identity",
    what: "Profile name. The build matches it exactly, so a renamed profile breaks the archive.",
    where: "`hatchkit signing`. Also listed in App Store Connect, Profiles.",
  },
  APPLE_KEYCHAIN_PASSWORD: {
    family: "apple-identity",
    what: "Password for the throwaway keychain the runner creates. Used only for that run.",
    where: "`hatchkit signing` generates one.",
  },
  APPLE_DEVELOPER_ID_CERT_BASE64: {
    family: "apple-developer-id",
    what: "Base64 of the Developer ID Application .p12 that signs the macOS bundle.",
    where:
      "Export the certificate from Keychain Access as .p12, then `base64 -i cert.p12`. The certificate itself is issued at developer.apple.com, Certificates.",
  },
  APPLE_DEVELOPER_ID_CERT_PASSWORD: {
    family: "apple-developer-id",
    what: "Password that opens that .p12.",
    where: "The password set when exporting the certificate from Keychain Access.",
  },
  APPLE_DEVELOPER_ID_IDENTITY: {
    family: "apple-developer-id",
    what: 'Signing identity name, in the form "Developer ID Application: Name (TEAMID)". The build matches it exactly.',
    where: "`security find-identity -v -p codesigning`, after importing the .p12.",
  },
  APPSTORE_API_KEY_ID: {
    family: "apple-store-api",
    what: "Ten-character App Store Connect API key id.",
    where:
      "App Store Connect, Users and Access, Integrations, Keys. Recorded by `hatchkit signing org-init`.",
  },
  APPSTORE_API_ISSUER_ID: {
    family: "apple-store-api",
    what: "Issuer UUID that the API key belongs to.",
    where: "App Store Connect, Users and Access, Integrations. One issuer per team.",
  },
  APPSTORE_API_KEY_P8_BASE64: {
    family: "apple-store-api",
    what: "Base64 of the AuthKey_<KEY_ID>.p8. Apple serves the file once, at creation.",
    where: "`hatchkit signing` encodes the .p8 named in the org config.",
  },

  // --- Google (Android) ----------------------------------------------------
  ANDROID_KEYSTORE_BASE64: {
    family: "android-keystore",
    what: "Base64 of the upload keystore that signs the AAB.",
    where:
      "`hatchkit signing` generates it with keytool. Replacing it locks Play uploads until Google resets the key, so back up the original.",
  },
  ANDROID_KEYSTORE_PASSWORD: {
    family: "android-keystore",
    what: "Store password for that keystore.",
    where: "`hatchkit signing` generates it and pushes it without writing it to disk.",
  },
  ANDROID_KEY_ALIAS: {
    family: "android-keystore",
    what: "Alias of the signing key inside the keystore.",
    where: "`hatchkit signing` sets it to `upload` when it generates the keystore.",
  },
  ANDROID_KEY_PASSWORD: {
    family: "android-keystore",
    what: "Password for that alias.",
    where: "`hatchkit signing` generates it alongside the store password.",
  },
  PLAY_SERVICE_ACCOUNT_JSON: {
    family: "play-api",
    what: "The whole Google Cloud service account JSON that uploads to a Play track.",
    where:
      "console.cloud.google.com, IAM, Service Accounts. Then grant it Release manager in Play Console, Setup, API access.",
  },

  // --- itch.io -------------------------------------------------------------
  ITCH_API_KEY: {
    family: "itch",
    what: "butler API key that pushes desktop builds.",
    where: "itch.io, Settings, API keys.",
  },
  ITCH_USER: {
    family: "itch",
    what: "Account or organisation that owns the project page.",
    where: "The first path segment of the itch.io page URL.",
  },
  ITCH_GAME: {
    family: "itch",
    what: "Project slug butler pushes channels to.",
    where: "The second path segment of the itch.io page URL.",
  },

  // --- Chrome Web Store ----------------------------------------------------
  CHROME_EXTENSION_ID: {
    family: "chrome",
    what: "Item id of the published extension, 32 lowercase letters.",
    where: "Chrome Web Store Developer Dashboard, on the item page.",
  },
  CHROME_CLIENT_ID: {
    family: "chrome",
    what: "OAuth client the Chrome Web Store API upload runs as.",
    where:
      "console.cloud.google.com, APIs and Services, Credentials, with the Chrome Web Store API enabled.",
  },
  CHROME_CLIENT_SECRET: {
    family: "chrome",
    what: "Secret for that OAuth client.",
    where: "Shown with the client in console.cloud.google.com, APIs and Services, Credentials.",
  },
  CHROME_REFRESH_TOKEN: {
    family: "chrome",
    what: "Long-lived refresh token for that client, scoped to chromewebstore.",
    where:
      "A one-time browser consent for the client. Google issues the refresh token on the first authorisation only.",
  },

  // --- Firefox AMO ---------------------------------------------------------
  AMO_JWT_ISSUER: {
    family: "amo",
    what: "addons.mozilla.org API key, used as the JWT issuer.",
    where: "addons.mozilla.org, Developer Hub, Manage API Keys.",
  },
  AMO_JWT_SECRET: {
    family: "amo",
    what: "The matching API secret. Shown once, at creation.",
    where: "addons.mozilla.org, Developer Hub, Manage API Keys.",
  },

  // --- npm -----------------------------------------------------------------
  NPM_TOKEN: {
    family: "npm",
    what: "Automation access token with publish rights on the package.",
    where: "npmjs.com, Access Tokens. An automation token bypasses the 2FA publish prompt.",
  },
};

// ---------------------------------------------------------------------------
// Signing subsets
// ---------------------------------------------------------------------------

/** Per channel, the families whose absence leaves an UNSIGNED artifact
 *  rather than an unpublished one. Keyed by channel id because the same
 *  family can be a signing requirement on one channel and an upload
 *  convenience on another; the channel is the only thing that settles
 *  it. A channel absent from this table signs nothing. */
const SIGNING_FAMILIES_BY_CHANNEL: Record<string, readonly SecretFamily[]> = {
  mobile: ["apple-identity", "android-keystore"],
  "desktop-electron": ["azure", "apple-developer-id"],
};

/**
 * The secrets whose absence means the channel's artifact would be
 * unsigned. Store API keys are deliberately NOT in here: without them
 * the upload step does not run, which is already safe.
 *
 * Returns `[]` for an unknown channel id, and for every channel that
 * ships nothing a user installs — a web deploy or a container image has
 * no signature to be missing.
 */
export function signingSecretsFor(channelId: string): string[] {
  const families = SIGNING_FAMILIES_BY_CHANNEL[channelId];
  if (!families || families.length === 0) return [];
  // Catalog order, not family order, so the list reads the same way it
  // does in the generated doc and in a policy failure message.
  return Object.entries(SECRETS)
    .filter(([, row]) => families.includes(row.family))
    .map(([name]) => name);
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/**
 * One {@link CredentialGroup} per channel that needs secrets, in
 * channel order. Channels needing none — a web deploy that runs on the
 * workflow's own `GITHUB_TOKEN` — produce no group at all, so the
 * generated doc for a web-only project is empty rather than padded.
 */
export function deriveCredentials(channels: readonly ReleaseChannel[]): CredentialGroup[] {
  const groups: CredentialGroup[] = [];
  for (const channel of channels) {
    const names = unique(channel.credentials);
    if (names.length === 0) continue;
    const families = familiesOf(names);
    groups.push({
      channelId: channel.id,
      label: channel.label,
      secrets: names.map(describeSecret),
      absent: channel.absent,
      absentNote: buildAbsentNote(channel, names, families),
      manualSteps: manualStepsFor(families),
    });
  }
  return groups;
}

/** A secret the catalog does not know still gets a row. Dropping it
 *  would hide a requirement, and a vague row a reader can act on beats
 *  a missing one they cannot see. */
function describeSecret(name: string): CredentialSecret {
  const row = SECRETS[name];
  if (row) return { name, what: row.what, where: row.where };
  return {
    name,
    what: "Required by this channel's workflow.",
    where: `Set it as a repo secret: \`gh secret set ${name}\`.`,
  };
}

/** Families present among a channel's secrets, in catalog order and
 *  deduped, so downstream prose lists destinations and manual steps in
 *  a stable order across regenerations. */
function familiesOf(names: readonly string[]): SecretFamily[] {
  const present = new Set<SecretFamily>();
  for (const name of names) {
    const row = SECRETS[name];
    if (row) present.add(row.family);
  }
  return (Object.keys(FAMILIES) as SecretFamily[]).filter((f) => present.has(f));
}

function manualStepsFor(families: readonly SecretFamily[]): string[] {
  return unique(families.flatMap((f) => FAMILIES[f].manualSteps));
}

/** Where the artifacts go when the secrets ARE present. `null` when
 *  every family here signs rather than uploads, or when the catalog
 *  knows none of the channel's secrets. */
function destinationPhrase(families: readonly SecretFamily[]): string | null {
  const destinations = unique(
    families.map((f) => FAMILIES[f].destination).filter((d): d is string => d !== null),
  );
  if (destinations.length === 0) return null;
  const last = destinations[destinations.length - 1];
  if (destinations.length === 1) return last ?? null;
  return `${destinations.slice(0, -1).join(", ")} or ${last}`;
}

/**
 * The consequence sentence. Three shapes, one per AbsentBehaviour, and
 * every one of them names an outcome a reader can
 * verify from the workflow run itself: an artifact attached to the run,
 * an artifact attached and marked unsigned, or a red run. None of them
 * can be read as "it published anyway".
 */
function buildAbsentNote(
  channel: ReleaseChannel,
  names: readonly string[],
  families: readonly SecretFamily[],
): string {
  const destination = destinationPhrase(families);
  const reach = destination ?? "anywhere a person can install it from";

  if (channel.absent === "fail") {
    return (
      `${channel.label} has no degraded mode: with any of these missing the workflow fails and ` +
      `the tag produces no ${channel.label} artifact. Nothing reaches ${reach}.`
    );
  }

  const signing = signingSecretsFor(channel.id).filter((name) => names.includes(name));
  const uploadOnly = names.filter((name) => !signing.includes(name));

  if (channel.absent === "unsigned" && signing.length > 0) {
    const unsignedPart =
      `Without ${signing.join(", ")} the ${channel.label} artifact is built unsigned, stays ` +
      `attached to the workflow run, and is not uploaded to ${reach}.`;
    if (uploadOnly.length === 0) return unsignedPart;
    return (
      `${unsignedPart} Without ${uploadOnly.join(", ")} the artifact is signed but the upload ` +
      `step does not run, so it still never reaches ${reach}.`
    );
  }

  return (
    `Missing any of these skips the upload step: the ${channel.label} build is still produced ` +
    `and attached to the workflow run, and it does not reach ${reach}. The run stays green, ` +
    `and the status table reports the upload as skipped rather than as done.`
  );
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
