#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// Steam App ID used when the `steam` cargo feature is enabled.
/// Replace with your real App ID from partner.steamgames.com.
/// 480 is Valve's public test app (Spacewar) — safe for local testing.
#[cfg(feature = "steam")]
const STEAM_APP_ID: u32 = 480;

fn main() {
    // Steamworks must initialize before the window opens so the Steam
    // overlay can hook the renderer. This is a no-op unless the binary
    // was built with `--features steam`. A Steam build also needs the
    // Steamworks SDK redistributable shipped next to the binary
    // (steam_api64.dll / libsteam_api.dylib / libsteam_api.so) — see
    // https://partner.steamgames.com/doc/sdk and src-tauri/README.md.
    #[cfg(feature = "steam")]
    let _steam_client = steamworks::Client::init_app(STEAM_APP_ID)
        .expect("failed to init Steamworks — is Steam running and steam_appid.txt present?");

    tauri::Builder::default()
        .setup(|_app| Ok(()))
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
