/**
 * The menu bar surface: what this session touched last, and what is unsent.
 *
 * ============================================================
 * STAYING LOADED IS A DECISION, AND IT COSTS SOMETHING
 * ============================================================
 *
 * Raycast unloads a menu bar command once its first render settles, so a timer
 * inside it fires exactly once and the surface then shows whatever it drew at
 * mount, forever. The only thing that keeps it loaded is an unfinished load
 * state — `isLoading`.
 *
 * So `isLoading` is held while, and only while, there is live state to show.
 * Holding it always would burn battery on a surface with nothing to refresh;
 * dropping it always would show state that ended elsewhere minutes ago. The
 * manifest's `interval` covers the unloaded case, as does the person opening
 * the menu.
 *
 * `refreshMenuBar()` is deliberately not used as the mechanism. Raycast may
 * decline a background refresh, and it does not remount a command that is
 * still loaded — so a refresh call from another command is a nudge, never the
 * thing that keeps this accurate.
 */
import { Icon, MenuBarExtra, getPreferenceValues, open } from "@raycast/api";
import { pairNow } from "./components/pairing";
import { formatAggregate, formatLive, formatWhen, truncate } from "./lib/format";
import { webOrigin } from "./lib/preferences";
import { useItems } from "./lib/use-items";

export default function Command(): React.JSX.Element {
  const { showPending } = getPreferenceValues<Preferences.CurrentItem>();
  const view = useItems(20);
  const paired = view.session.status === "signed-in";
  const hasLive = paired && view.live !== null;

  const title = !paired
    ? "Not paired"
    : view.live === null
      ? formatAggregate(0, "item")
      : formatLive(view.live.title);

  const pendingSuffix = showPending && view.pending > 0 ? ` · ${view.pending} unsent` : "";

  return (
    <MenuBarExtra
      icon={Icon.BulletPoints}
      title={`${title}${pendingSuffix}`}
      // Held only while there is live state — see the header.
      isLoading={view.loading || hasLive}
    >
      {!paired && (
        <MenuBarExtra.Section title="Pair with the web app">
          <MenuBarExtra.Item
            title="Pair with the Web App"
            icon={Icon.Link}
            onAction={() => {
              void pairNow(view.reload);
            }}
          />
        </MenuBarExtra.Section>
      )}

      {paired && view.live !== null && (
        <MenuBarExtra.Section title="Current">
          <MenuBarExtra.Item
            // The live value, in the live format.
            title={formatLive(view.live.title)}
            subtitle={formatWhen(view.live.updatedAt)}
            onAction={() => {
              void open(webOrigin());
            }}
          />
        </MenuBarExtra.Section>
      )}

      {paired && (
        <MenuBarExtra.Section title="Recent">
          {view.items.slice(0, 8).map((item) => (
            <MenuBarExtra.Item
              key={item.id}
              // NOT formatLive: an aggregate or a plain row drawn in the live
              // format reads as still-live, and a person will act on it as if
              // it were the thing they are working on.
              title={truncate(item.title, 32)}
              subtitle={item.status}
              onAction={() => {
                void open(webOrigin());
              }}
            />
          ))}
        </MenuBarExtra.Section>
      )}

      <MenuBarExtra.Section title="Status">
        <MenuBarExtra.Item title={formatAggregate(view.items.length, "item")} icon={Icon.List} />
        {view.pending > 0 && (
          <MenuBarExtra.Item
            title={`${formatAggregate(view.pending, "change")} waiting to be sent`}
            icon={Icon.Clock}
            onAction={view.reload}
          />
        )}
        {view.fromCache && (
          <MenuBarExtra.Item title="Showing the last answer from the server" icon={Icon.Warning} />
        )}
      </MenuBarExtra.Section>
    </MenuBarExtra>
  );
}
