import { createClient } from "@supabase/supabase-js";

export type AuthSession = {
  accessToken: string;
  userId: string;
  email: string;
};

export type AuthClient = {
  getSession(): Promise<AuthSession | null>;
  signInWithGoogle?(): Promise<void>;
  signInWithPassword(email: string, password: string): Promise<AuthSession>;
  requestOtp(email: string): Promise<void>;
  verifyOtp(email: string, token: string): Promise<AuthSession>;
  updatePassword(password: string): Promise<void>;
  signOut(): Promise<void>;
  onSessionChange(listener: (session: AuthSession | null) => void): () => void;
};

type SupabaseSession = {
  access_token: string;
  user: { id: string; email?: string };
};

type SupabaseAuthLike = {
  auth: {
    signInWithOAuth?(input: { provider: "google"; options: { redirectTo: string } }): Promise<{ data: unknown; error: unknown }>;
    getSession(): Promise<{ data: { session: SupabaseSession | null }; error: unknown }>;
    signInWithPassword(input: { email: string; password: string }): Promise<{ data: { session: SupabaseSession | null }; error: unknown }>;
    signInWithOtp(input: { email: string; options: { shouldCreateUser: false } }): Promise<{ data: unknown; error: unknown }>;
    verifyOtp(input: { email: string; token: string; type: "email" }): Promise<{ data: { session: SupabaseSession | null }; error: unknown }>;
    updateUser(input: { password: string }): Promise<{ data: unknown; error: unknown }>;
    signOut(): Promise<{ error: unknown }>;
    onAuthStateChange(listener: (event: string, session: SupabaseSession | null) => void): {
      data: { subscription: { unsubscribe(): void } };
    };
  };
};

function safeSession(session: SupabaseSession | null): AuthSession | null {
  const email = session?.user.email?.trim().toLowerCase();
  if (!session?.access_token || !session.user.id || !email) return null;
  return { accessToken: session.access_token, userId: session.user.id, email };
}

function authFailure(): Error {
  return new Error("Authentication failed");
}

export function createSupabaseAuthClient(client: SupabaseAuthLike): AuthClient {
  return {
    ...(client.auth.signInWithOAuth ? {
      async signInWithGoogle() {
        try {
          const result = await client.auth.signInWithOAuth!({
            provider: "google",
            options: { redirectTo: `${window.location.origin}/` },
          });
          if (result.error) throw authFailure();
        } catch {
          throw authFailure();
        }
      },
    } : {}),
    async getSession() {
      const result = await client.auth.getSession();
      if (result.error) throw authFailure();
      return safeSession(result.data.session);
    },
    async signInWithPassword(email, password) {
      const normalizedEmail = email.trim().toLowerCase();
      const result = await client.auth.signInWithPassword({ email: normalizedEmail, password });
      const session = result.error ? null : safeSession(result.data.session);
      if (!session) throw authFailure();
      return session;
    },
    async requestOtp(email) {
      const result = await client.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
      if (result.error) throw authFailure();
    },
    async verifyOtp(email, token) {
      const result = await client.auth.verifyOtp({ email, token, type: "email" });
      const session = result.error ? null : safeSession(result.data.session);
      if (!session) throw authFailure();
      return session;
    },
    async updatePassword(password) {
      const result = await client.auth.updateUser({ password });
      if (result.error) throw authFailure();
    },
    async signOut() {
      const result = await client.auth.signOut();
      if (result.error) throw authFailure();
    },
    onSessionChange(listener) {
      const { data } = client.auth.onAuthStateChange((_event, session) => listener(safeSession(session)));
      return () => data.subscription.unsubscribe();
    },
  };
}

export function createBrowserAuthClient(url: string, publishableKey: string, options: {googleEnabled?: boolean} = {}): AuthClient {
  const client = createClient(url, publishableKey, {
    auth: {
      flowType: "pkce",
      storageKey: "zundamon-ai-auth",
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: true,
    },
  });
  const adapter = createSupabaseAuthClient(client as unknown as SupabaseAuthLike);
  if (options.googleEnabled === false) delete adapter.signInWithGoogle;
  return adapter;
}
