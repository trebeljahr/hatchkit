/**
 * Which host is this bundle running in?
 *
 * The same client build is served as a web app, wrapped in Electron and
 * wrapped in Capacitor. Those last two are "token shells": they authenticate
 * with a bearer token because they have no usable cookie jar for the API's
 * origin, and several sign-in methods therefore cannot work in them at all.
 *
 * Every function here is a synchronous read of a global the shell injects
 * before any app script runs. **Every one of them answers `false` during a
 * Node prerender.** Never branch a first render on them — the served HTML
 * would disagree with the first client render and hydration would tear. Read
 * them in an effect after mount instead, which is what the auth components do.
 */

type CapacitorGlobal = { isNativePlatform?: () => boolean };
type ElectronGlobal = { isDesktop?: boolean };

export function isCapacitor(): boolean {
  if (typeof window === "undefined") return false;
  const capacitor = (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
  return capacitor?.isNativePlatform?.() ?? false;
}

export function isElectron(): boolean {
  if (typeof window === "undefined") return false;
  const api = (window as unknown as { electronAPI?: ElectronGlobal }).electronAPI;
  return api?.isDesktop === true;
}

/**
 * True in any host that holds a bearer token rather than a cookie.
 *
 * What follows from it, and why several components ask:
 *  - An OAuth redirect cannot return to this origin, so the Google button is
 *    disabled with a note rather than hidden.
 *  - The two-factor challenge is a cookie this host can neither read nor
 *    send, so `/login` says so instead of showing a code field that would
 *    always answer "invalid".
 *  - A magic link opens in the system browser, not here, so the link arrives
 *    somewhere this process never sees.
 *
 * Email one-time codes are the exception: body in, session out, no cookie in
 * between. That is the method to offer here.
 */
export function isTokenShell(): boolean {
  return isCapacitor() || isElectron();
}
