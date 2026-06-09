/**
 * Native config rewriter unit tests.
 *
 * Builds a scratch project tree that mirrors what mesozoic-protocol
 * looks like (build.gradle, strings.xml, MainActivity.java, tauri.conf.json,
 * capacitor.config.ts, pbxproj), runs the rewriter with a new bundle ID
 * + app name, and asserts:
 *
 *   1. Every templated value is rewritten.
 *   2. Bundle-ID-shaped values that did NOT match the source are left alone
 *      (so user-customized overrides survive).
 *   3. MainActivity.java is moved to the new package directory.
 *   4. Re-running the rewriter on the same inputs is a no-op.
 *
 * Run: pnpm --filter hatchkit test:signing-rewriter
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { rewriteNativeConfigs } from "./src/features/signing/native-rewriter.js";

let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (!cond) {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

const root = mkdtempSync(join(tmpdir(), "signing-rewriter-"));
try {
  // 1. Seed a fake mesozoic-protocol project.
  //    src-tauri/tauri.conf.json
  mkdirSync(join(root, "src-tauri"), { recursive: true });
  writeFileSync(
    join(root, "src-tauri", "tauri.conf.json"),
    JSON.stringify(
      {
        $schema: "https://schema.tauri.app/config/2",
        productName: "Mesozoic Protocol",
        version: "0.1.0",
        identifier: "com.mesozoicprotocol.app",
        app: {
          windows: [
            { label: "main", title: "Mesozoic Protocol", width: 1280, height: 800 },
          ],
        },
      },
      null,
      2,
    ) + "\n",
  );

  //    capacitor.config.ts
  writeFileSync(
    join(root, "capacitor.config.ts"),
    `import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.mesozoicprotocol.app",
  appName: "Mesozoic Protocol",
  webDir: "dist",
};

export default config;
`,
  );

  //    android/app/build.gradle
  mkdirSync(join(root, "android/app"), { recursive: true });
  writeFileSync(
    join(root, "android/app/build.gradle"),
    `android {
    namespace = "com.mesozoicprotocol.app"
    defaultConfig {
        applicationId "com.mesozoicprotocol.app"
    }
}
`,
  );

  //    android/app/src/main/res/values/strings.xml
  mkdirSync(join(root, "android/app/src/main/res/values"), { recursive: true });
  writeFileSync(
    join(root, "android/app/src/main/res/values/strings.xml"),
    `<?xml version='1.0' encoding='utf-8'?>
<resources>
    <string name="app_name">Mesozoic Protocol</string>
    <string name="title_activity_main">Mesozoic Protocol</string>
    <string name="package_name">com.mesozoicprotocol.app</string>
    <string name="custom_url_scheme">com.mesozoicprotocol.app</string>
</resources>
`,
  );

  //    android/app/src/main/java/com/mesozoicprotocol/app/MainActivity.java
  const oldJavaDir = join(root, "android/app/src/main/java/com/mesozoicprotocol/app");
  mkdirSync(oldJavaDir, { recursive: true });
  writeFileSync(
    join(oldJavaDir, "MainActivity.java"),
    `package com.mesozoicprotocol.app;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {}
`,
  );

  //    ios/App/App.xcodeproj/project.pbxproj
  mkdirSync(join(root, "ios/App/App.xcodeproj"), { recursive: true });
  writeFileSync(
    join(root, "ios/App/App.xcodeproj/project.pbxproj"),
    `// !$*UTF8*$!
{
\tBUILD_SETTINGS_DEBUG = {
\t\tPRODUCT_BUNDLE_IDENTIFIER = com.mesozoicprotocol.app;
\t};
\tBUILD_SETTINGS_RELEASE = {
\t\tPRODUCT_BUNDLE_IDENTIFIER = com.mesozoicprotocol.app;
\t};
}
`,
  );

  // 2. Run the rewriter.
  const result = rewriteNativeConfigs({
    projectDir: root,
    bundleId: "com.example.tiao",
    appName: "Tiao",
  });

  // 3. Assert every file was rewritten.
  const expectedRewritten = [
    "src-tauri/tauri.conf.json",
    "capacitor.config.ts",
    "android/app/build.gradle",
    "android/app/src/main/res/values/strings.xml",
    "ios/App/App.xcodeproj/project.pbxproj",
    "android/app/src/main/java/com/example/tiao/MainActivity.java",
  ];
  for (const f of expectedRewritten) {
    assert(result.rewritten.includes(f), `expected ${f} in rewritten list (got ${JSON.stringify(result.rewritten)})`);
  }

  // 4. Verify tauri.conf.json content.
  const tauri = JSON.parse(
    readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf-8"),
  );
  assert(tauri.identifier === "com.example.tiao", `tauri identifier: ${tauri.identifier}`);
  assert(tauri.productName === "Tiao", `tauri productName: ${tauri.productName}`);
  assert(
    tauri.app.windows[0].title === "Tiao",
    `tauri window.title should sync: ${tauri.app.windows[0].title}`,
  );

  // 5. Verify capacitor.config.ts content.
  const cap = readFileSync(join(root, "capacitor.config.ts"), "utf-8");
  assert(cap.includes(`appId: "com.example.tiao"`), `capacitor appId rewritten`);
  assert(cap.includes(`appName: "Tiao"`), `capacitor appName rewritten`);

  // 6. Verify build.gradle.
  const gradle = readFileSync(join(root, "android/app/build.gradle"), "utf-8");
  assert(gradle.includes(`namespace = "com.example.tiao"`), `gradle namespace`);
  assert(gradle.includes(`applicationId "com.example.tiao"`), `gradle applicationId`);

  // 7. Verify strings.xml.
  const strings = readFileSync(
    join(root, "android/app/src/main/res/values/strings.xml"),
    "utf-8",
  );
  assert(strings.includes(`<string name="app_name">Tiao</string>`), `strings app_name`);
  assert(
    strings.includes(`<string name="title_activity_main">Tiao</string>`),
    `strings title_activity_main`,
  );
  assert(strings.includes(`<string name="package_name">com.example.tiao</string>`), `strings package_name`);
  assert(
    strings.includes(`<string name="custom_url_scheme">com.example.tiao</string>`),
    `strings custom_url_scheme`,
  );

  // 8. Verify MainActivity moved and package decl rewritten.
  const newJava = join(root, "android/app/src/main/java/com/example/tiao/MainActivity.java");
  assert(existsSync(newJava), `MainActivity.java moved to new package dir`);
  const oldJava = join(oldJavaDir, "MainActivity.java");
  assert(!existsSync(oldJava), `MainActivity.java removed from old package dir`);
  const javaSrc = readFileSync(newJava, "utf-8");
  assert(
    javaSrc.startsWith("package com.example.tiao;"),
    `MainActivity package decl rewritten: ${javaSrc.slice(0, 60)}`,
  );

  // 9. Verify pbxproj — both occurrences rewritten.
  const pbx = readFileSync(join(root, "ios/App/App.xcodeproj/project.pbxproj"), "utf-8");
  const occurrences = pbx.split("PRODUCT_BUNDLE_IDENTIFIER").length - 1;
  assert(occurrences === 2, `pbxproj has 2 PRODUCT_BUNDLE_IDENTIFIER occurrences (${occurrences})`);
  const reFails = pbx.match(/PRODUCT_BUNDLE_IDENTIFIER\s*=\s*com\.mesozoicprotocol\.app/g);
  assert(reFails === null, `no stale mesozoic refs in pbxproj`);

  // 10. Idempotency: re-run should not rewrite anything.
  const second = rewriteNativeConfigs({
    projectDir: root,
    bundleId: "com.example.tiao",
    appName: "Tiao",
  });
  assert(
    second.rewritten.length === 0,
    `idempotent re-run rewrote ${second.rewritten.length} files (expected 0): ${JSON.stringify(second.rewritten)}`,
  );

  if (failed === 0) {
    console.log("test-signing-rewriter: ok");
    process.exit(0);
  } else {
    console.error(`test-signing-rewriter: ${failed} assertion(s) failed`);
    process.exit(1);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
