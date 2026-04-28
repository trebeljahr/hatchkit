"use client";

import { trpc } from "@/lib/trpc";

export default function SettingsPage() {
  const profileQuery = trpc.profile.get.useQuery();
  const updateMutation = trpc.profile.update.useMutation({
    onSuccess: () => {
      profileQuery.refetch();
    },
  });

  function handleThemeChange(theme: "light" | "dark" | "system") {
    updateMutation.mutate({ preferences: { theme } });
  }

  function handleNotificationToggle() {
    const current = profileQuery.data?.preferences.notifications ?? true;
    updateMutation.mutate({ preferences: { notifications: !current } });
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-muted-foreground">Manage your account settings</p>
      </div>

      <div className="max-w-md space-y-8">
        {/* Theme */}
        <div className="space-y-4">
          <h2 className="text-lg font-semibold">Appearance</h2>
          <div className="flex gap-2">
            {(["light", "dark", "system"] as const).map((theme) => (
              <button
                key={theme}
                onClick={() => handleThemeChange(theme)}
                className={`inline-flex h-10 items-center justify-center rounded-md border px-4 text-sm font-medium capitalize ${
                  profileQuery.data?.preferences.theme === theme
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-input hover:bg-accent"
                }`}
                data-testid={`theme-${theme}`}
              >
                {theme}
              </button>
            ))}
          </div>
        </div>

        {/* Notifications */}
        <div className="space-y-4">
          <h2 className="text-lg font-semibold">Notifications</h2>
          <label className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={profileQuery.data?.preferences.notifications ?? true}
              onChange={handleNotificationToggle}
              className="h-4 w-4 rounded border-input"
              data-testid="notifications-toggle"
            />
            <span className="text-sm">Enable email notifications</span>
          </label>
        </div>

        {/* Billing */}
        <div className="space-y-4">
          <h2 className="text-lg font-semibold">Billing</h2>
          <p className="text-sm text-muted-foreground">
            Manage your subscription and payment methods.
          </p>
          <button
            className="inline-flex h-10 items-center justify-center rounded-md border border-input px-4 text-sm font-medium hover:bg-accent"
            data-testid="manage-billing"
          >
            Manage billing
          </button>
        </div>

        {/* Danger zone */}
        <div className="space-y-4 rounded-md border border-destructive/30 p-4">
          <h2 className="text-lg font-semibold text-destructive">
            Danger Zone
          </h2>
          <p className="text-sm text-muted-foreground">
            Permanently delete your account and all associated data.
          </p>
          <button
            className="inline-flex h-10 items-center justify-center rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground hover:bg-destructive/90"
            data-testid="delete-account"
          >
            Delete account
          </button>
        </div>
      </div>
    </div>
  );
}
