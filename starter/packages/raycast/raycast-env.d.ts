/// <reference types="@raycast/api">

/* 🚧 🚧 🚧
 * This file is auto-generated from the extension's manifest.
 * Do not modify manually. Instead, update the `package.json` file.
 * 🚧 🚧 🚧 */

/* eslint-disable @typescript-eslint/ban-types */

type ExtensionPreferences = {
  /** API Origin - Where the API lives, e.g. https://example.com. Leave empty to use the origin this build was made for. */
  "apiOrigin"?: string,
  /** Web App Origin - Where the web app lives. Leave empty to use the origin this build was made for. */
  "webOrigin"?: string
}

/** Preferences accessible in all the extension's commands */
declare type Preferences = ExtensionPreferences

declare namespace Preferences {
  /** Preferences accessible in the `current-item` command */
  export type CurrentItem = ExtensionPreferences & {
  /** Menu Bar - Add the number of changes still waiting to be sent to the menu bar title. */
  "showPending": boolean
}
  /** Preferences accessible in the `capture-item` command */
  export type CaptureItem = ExtensionPreferences & {
  /** After Capturing - Open the new item in the web app once the server has confirmed it. */
  "openAfterCapture": boolean
}
  /** Preferences accessible in the `new-item` command */
  export type NewItem = ExtensionPreferences & {}
  /** Preferences accessible in the `list-items` command */
  export type ListItems = ExtensionPreferences & {
  /** Search Items - Leave archived items out of the list. */
  "hideArchived": boolean
}
  /** Preferences accessible in the `open-web-app` command */
  export type OpenWebApp = ExtensionPreferences & {}
}

declare namespace Arguments {
  /** Arguments passed to the `current-item` command */
  export type CurrentItem = {}
  /** Arguments passed to the `capture-item` command */
  export type CaptureItem = {
  /** Title */
  "title": string
}
  /** Arguments passed to the `new-item` command */
  export type NewItem = {}
  /** Arguments passed to the `list-items` command */
  export type ListItems = {}
  /** Arguments passed to the `open-web-app` command */
  export type OpenWebApp = {}
}

