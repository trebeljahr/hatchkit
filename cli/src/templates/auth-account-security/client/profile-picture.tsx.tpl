"use client";

/**
 * Add, replace or remove a profile picture.
 *
 * The chosen file is squared and shrunk in the browser (`lib/avatar-image.ts`)
 * and sent as base64. What is rendered is `user.image` from the session — the
 * same value every other client will show — so after any change the session is
 * re-read with the cookie cache disabled. Without that the cache serves the
 * OLD user for up to five minutes and the picture appears not to have changed.
 */

import * as React from "react";
import { AVATAR_REFUSALS } from "__HATCHKIT_SHARED_SCOPE__/shared";
import { authClient, refreshSession } from "@/lib/auth-client";
import { PrepareAvatarError, prepareAvatar } from "@/lib/avatar-image";
import { trpc } from "@/lib/trpc";

/** "Ada Lovelace" then "AL"; "ada@example.com" then "A". */
export const initialsOf = (name?: string | null, email?: string | null): string =>
  (name?.trim() || email || "?")
    .split(/\s+/)
    .map((part) => part.charAt(0))
    .join("")
    .slice(0, 2)
    .toUpperCase();

export function avatarFailureMessage(error: unknown): string {
  if (error instanceof PrepareAvatarError) {
    switch (error.reason) {
      case "not-an-image":
      case "unreadable":
        return "That file is not an image we can read.";
      case "source-too-large":
      case "too-large":
        return "That image is too large.";
    }
  }
  const code = (error as { message?: string } | undefined)?.message ?? "";
  if (code === AVATAR_REFUSALS.UNSUPPORTED_IMAGE) return "That file is not an image we can read.";
  if (code === AVATAR_REFUSALS.TOO_LARGE) return "That image is too large.";
  if (code === AVATAR_REFUSALS.INVALID_DATA) return "That upload was not readable.";
  return "Could not save the picture.";
}

const ACCEPT = "image/jpeg,image/png,image/webp,image/*";

export function ProfilePicture({
  avatarClassName = "size-16",
}: {
  avatarClassName?: string;
}): React.JSX.Element {
  const session = authClient.useSession();
  const user = session.data?.user;

  const inputRef = React.useRef<HTMLInputElement>(null);
  const [preparing, setPreparing] = React.useState(false);
  const [error, setError] = React.useState("");

  const setAvatar = trpc.profile.setAvatar.useMutation();
  const removeAvatarMutation = trpc.profile.removeAvatar.useMutation();
  const busy = preparing || setAvatar.isPending || removeAvatarMutation.isPending;

  async function upload(file: File): Promise<void> {
    setError("");
    setPreparing(true);
    try {
      const prepared = await prepareAvatar(file);
      setPreparing(false);
      // Only the bytes go over the wire. The server decides the content type
      // from them; a declared one would be a claim, not a fact.
      await setAvatar.mutateAsync({ data: prepared.base64 });
      await refreshSession();
    } catch (failure) {
      setError(avatarFailureMessage(failure));
    } finally {
      setPreparing(false);
    }
  }

  async function remove(): Promise<void> {
    setError("");
    try {
      await removeAvatarMutation.mutateAsync();
      await refreshSession();
    } catch (failure) {
      setError(avatarFailureMessage(failure));
    }
  }

  return (
    <div className="space-y-3" data-testid="profile-picture">
      <div className="flex items-center gap-4">
        {user?.image ? (
          <img
            src={user.image}
            alt=""
            className={`${avatarClassName} rounded-full object-cover`}
            data-testid="profile-picture-image"
          />
        ) : (
          <div
            className={`${avatarClassName} flex items-center justify-center rounded-full bg-muted text-sm font-medium`}
            aria-hidden="true"
          >
            {initialsOf(user?.name, user?.email)}
          </div>
        )}

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={busy}
            className="inline-flex h-10 items-center justify-center rounded-md border border-input px-4 text-sm font-medium hover:bg-accent disabled:opacity-50"
            data-testid="profile-picture-upload"
          >
            {busy ? "Working..." : user?.image ? "Replace" : "Add picture"}
          </button>
          {user?.image && (
            <button
              type="button"
              onClick={remove}
              disabled={busy}
              className="inline-flex h-10 items-center justify-center rounded-md px-4 text-sm font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
              data-testid="profile-picture-remove"
            >
              Remove
            </button>
          )}
        </div>
      </div>

      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="hidden"
        data-testid="profile-picture-input"
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Reset so choosing the same file again fires `change` again.
          event.target.value = "";
          if (file) void upload(file);
        }}
      />
    </div>
  );
}
