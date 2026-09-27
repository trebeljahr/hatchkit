/**
 * The form: fill in an item and send it, or queue it.
 *
 * The two length limits below are the ones the server's own validator
 * enforces. They are stated here rather than imported because the validator is
 * a schema object, and a launcher extension that copied it in would drag the
 * whole validation library into every command bundle for two numbers — which
 * the vendoring step refuses outright. A wrong number here is a form that
 * accepts what the server refuses, which the toast then reports; a copied
 * validation library is a slower launcher for everybody, forever.
 */
import { Action, ActionPanel, Form, Icon, Toast, popToRoot, showToast } from "@raycast/api";
import { useState } from "react";
import { PairAction } from "./components/pairing";
import { createItem, describeFailure } from "./lib/api";

const TITLE_MAX = 200;
const DESCRIPTION_MAX = 2000;

export default function Command(): React.JSX.Element {
  const [title, setTitle] = useState("");
  const [titleError, setTitleError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  async function submit(values: { title: string; description: string }): Promise<void> {
    if (values.title.trim() === "") {
      setTitleError("A title is required");
      return;
    }
    setBusy(true);
    try {
      const result = await createItem({
        title: values.title.trim().slice(0, TITLE_MAX),
        description:
          values.description.trim() === ""
            ? undefined
            : values.description.trim().slice(0, DESCRIPTION_MAX),
      });
      await showToast({
        style: Toast.Style.Success,
        title: result.sent ? "Created" : "Queued",
        message: result.sent ? values.title : "It will be sent when the server answers.",
      });
      await popToRoot();
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Not created",
        message: describeFailure(error),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Form
      isLoading={busy}
      actions={
        <ActionPanel>
          <Action.SubmitForm icon={Icon.Plus} title="Create Item" onSubmit={submit} />
          {/* Pairing is offered here too, for the person whose first command
              is this one. It runs from the action, never from a mount. */}
          <PairAction />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="title"
        title="Title"
        placeholder="What is it?"
        value={title}
        error={titleError}
        onChange={(next) => {
          setTitle(next);
          if (titleError !== undefined) setTitleError(undefined);
        }}
      />
      <Form.TextArea id="description" title="Description" placeholder="Optional" />
      <Form.Description
        title="Offline"
        text="With no answer from the server this is saved here and sent later, in the order you made your changes."
      />
    </Form>
  );
}
