/**
 * The list, including the work that has not been sent yet.
 *
 * The rows come from `applyOverlay`, so an item created with no signal appears
 * here immediately and a deletion that is still queued does not. Without the
 * overlay the list would draw whatever the last successful read said — and the
 * last successful read happened before the person did any of it.
 *
 * Editing is gated on the server reporting the `items.update` capability. A
 * self-hosted server one release behind answers NOT_FOUND for a procedure it
 * has never heard of, which reads as "that item is gone"; asking first is the
 * difference between a hidden action and a misleading error.
 */
import {
  Action,
  ActionPanel,
  Color,
  Icon,
  List,
  Toast,
  confirmAlert,
  getPreferenceValues,
  open,
  showToast,
} from "@raycast/api";
import { useEffect, useState } from "react";
import { PairingEmptyView } from "./components/pairing";
import type { Item } from "./vendor";
import { describeFailure, removeItem, updateItem } from "./lib/api";
import { serverHas } from "./lib/capabilities";
import { formatAggregate, formatWhen } from "./lib/format";
import { apiOrigin, webOrigin } from "./lib/preferences";
import { useItems } from "./lib/use-items";

const STATUS_TINT: Record<Item["status"], Color> = {
  draft: Color.SecondaryText,
  published: Color.Green,
  archived: Color.Orange,
};

export default function Command(): React.JSX.Element {
  const { hideArchived } = getPreferenceValues<Preferences.ListItems>();
  const view = useItems(50);
  const [canEdit, setCanEdit] = useState(false);

  useEffect(() => {
    void serverHas(apiOrigin(), "items.update").then(setCanEdit);
  }, [view.session.status]);

  if (view.session.status !== "signed-in") {
    return (
      <List isLoading={view.loading}>
        <PairingEmptyView
          state={view.session.status === "other-server" ? "other-server" : "signed-out"}
          onDone={view.reload}
        />
      </List>
    );
  }

  const rows = hideArchived ? view.items.filter((item) => item.status !== "archived") : view.items;

  return (
    <List
      isLoading={view.loading}
      searchBarPlaceholder="Search items"
      navigationTitle={
        view.pending > 0
          ? `${formatAggregate(view.items.length, "item")} · ${view.pending} unsent`
          : formatAggregate(view.items.length, "item")
      }
    >
      {view.fromCache && (
        <List.Section title="Showing the last answer from the server">
          <List.Item
            icon={{ source: Icon.Warning, tintColor: Color.Yellow }}
            title={`Could not reach ${apiOrigin()}`}
            subtitle="Your changes are queued."
            actions={
              <ActionPanel>
                <Action title="Try Again" icon={Icon.ArrowClockwise} onAction={view.reload} />
              </ActionPanel>
            }
          />
        </List.Section>
      )}

      <List.EmptyView
        icon={Icon.BulletPoints}
        title="No items yet"
        description="Capture one with the hotkey, or create one from the New Item command."
        actions={
          <ActionPanel>
            <Action title="Reload" icon={Icon.ArrowClockwise} onAction={view.reload} />
          </ActionPanel>
        }
      />

      {rows.map((item) => (
        <List.Item
          key={item.id}
          icon={{ source: Icon.Circle, tintColor: STATUS_TINT[item.status] }}
          title={item.title}
          subtitle={item.description}
          accessories={[
            // A row this device invented and the server has never seen. It is
            // in the list because the overlay put it there.
            ...(item.id.startsWith("temp-")
              ? [{ tag: { value: "unsent", color: Color.Yellow } }]
              : []),
            { text: item.status },
            { text: formatWhen(item.updatedAt) },
          ]}
          actions={
            <ActionPanel>
              <Action
                title="Open in the Web App"
                icon={Icon.Globe}
                onAction={() => {
                  void open(webOrigin());
                }}
              />
              <Action title="Reload" icon={Icon.ArrowClockwise} onAction={view.reload} />
              {canEdit && item.status !== "published" && (
                <Action
                  title="Mark Published"
                  icon={Icon.Checkmark}
                  onAction={() => {
                    void act(() => updateItem({ id: item.id, status: "published" }), view.reload);
                  }}
                />
              )}
              {canEdit && item.status !== "archived" && (
                <Action
                  title="Archive"
                  icon={Icon.Tray}
                  onAction={() => {
                    void act(() => updateItem({ id: item.id, status: "archived" }), view.reload);
                  }}
                />
              )}
              <Action
                title="Delete"
                icon={Icon.Trash}
                style={Action.Style.Destructive}
                onAction={() => {
                  void (async () => {
                    const yes = await confirmAlert({
                      title: "Delete this item?",
                      message: item.title,
                      primaryAction: { title: "Delete" },
                    });
                    if (yes) await act(() => removeItem(item.id), view.reload);
                  })();
                }}
              />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}

/** Run a write and say what happened, in the words `api.ts` chose. */
async function act(run: () => Promise<unknown>, reload: () => void): Promise<void> {
  try {
    await run();
    reload();
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Not saved",
      message: describeFailure(error),
    });
  }
}
