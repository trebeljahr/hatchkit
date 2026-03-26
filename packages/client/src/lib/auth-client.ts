import { createAuthClient } from "better-auth/react";

const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000";

export const authClient = createAuthClient({
  baseURL: `${apiUrl}/api/auth`,
});

// Re-export commonly used methods
export const { signIn, signUp, signOut, useSession } = authClient;
