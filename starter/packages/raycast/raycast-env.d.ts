/// <reference types="@raycast/api">

/* eslint-disable @typescript-eslint/ban-types */

/**
 * COMMITTED, although Raycast's toolchain generates it.
 *
 * `ray develop` writes this file from the manifest's `preferences` and
 * `arguments`. A machine without that toolchain cannot produce it — which
 * includes CI and anybody who only runs the repository's aggregate typecheck —
 * and without it every `getPreferenceValues()` call is an error. So it is
 * checked in, and it has to be updated by hand (or by one `ray develop` run)
 * whenever the manifest's preferences or arguments change.
 */
declare namespace Preferences {
  /** Preferences accessible in all the extension's commands */
  type ExtensionPreferences = {
    /** API Origin - Where the API lives, e.g. https://example.com. Leave empty to use the origin this build was made for. */
    readonly apiOrigin?: string;
    /** Web App Origin - Where the web app lives. Leave empty to use the origin this build was made for. */
    readonly webOrigin?: string;
  };

  /** Preferences accessible in the `current-item` command */
  type CurrentItem = ExtensionPreferences & {
    /** Menu Bar - Add the number of changes still waiting to be sent to the menu bar title. */
    readonly showPending: boolean;
  };
  /** Preferences accessible in the `capture-item` command */
  type CaptureItem = ExtensionPreferences & {
    /** After Capturing - Open the new item in the web app once the server has confirmed it. */
    readonly openAfterCapture: boolean;
  };
  /** Preferences accessible in the `new-item` command */
  type NewItem = ExtensionPreferences;
  /** Preferences accessible in the `list-items` command */
  type ListItems = ExtensionPreferences & {
    /** Search Items - Leave archived items out of the list. */
    readonly hideArchived: boolean;
  };
  /** Preferences accessible in the `open-web-app` command */
  type OpenWebApp = ExtensionPreferences;
}

declare namespace Arguments {
  /** Arguments passed to the `current-item` command */
  type CurrentItem = {};
  /** Arguments passed to the `capture-item` command */
  type CaptureItem = {
    /** Title */
    readonly title: string;
  };
  /** Arguments passed to the `new-item` command */
  type NewItem = {};
  /** Arguments passed to the `list-items` command */
  type ListItems = {};
  /** Arguments passed to the `open-web-app` command */
  type OpenWebApp = {};
}
