// ricos.site/donate sends people back here with `?supported=1` after a
// payment. Record when that happened and drop the parameter from the URL.
// Nothing reads the timestamp yet: a future inline ask stays quiet for
// 90 days after it.
export const SUPPORTED_AT_KEY = "donation-supported-at";

type SupportedParamWindow = Pick<Window, "location" | "history" | "localStorage">;

export function consumeSupportedParam(win: SupportedParamWindow): boolean {
  const url = new URL(win.location.href);
  if (url.searchParams.get("supported") !== "1") return false;

  try {
    win.localStorage.setItem(SUPPORTED_AT_KEY, String(Date.now()));
  } catch {
    // Storage can be blocked (private mode, disabled site data).
  }

  url.searchParams.delete("supported");
  win.history.replaceState(win.history.state, "", url.pathname + url.search + url.hash);
  return true;
}
