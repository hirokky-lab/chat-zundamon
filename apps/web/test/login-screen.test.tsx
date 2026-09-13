import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AuthClient } from "../src/auth";
import { Login } from "../src/screens/Login";

function auth(overrides: Partial<AuthClient> = {}): AuthClient {
  return {
    getSession: async () => null,
    signInWithPassword: async (email) => ({ accessToken: "token", userId: "user-1", email }),
    requestOtp: async () => undefined,
    verifyOtp: async (email) => ({ accessToken: "token", userId: "user-1", email }),
    updatePassword: async () => undefined,
    signOut: async () => undefined,
    onSessionChange: () => () => undefined,
    ...overrides,
  };
}

describe("private YUI login", () => {
  it("starts Google login first without claiming authentication before OAuth returns", async () => {
    const signInWithGoogle = vi.fn(async () => undefined);
    const onAuthenticated = vi.fn();
    render(<Login authClient={auth({ signInWithGoogle })} onAuthenticated={onAuthenticated} />);
    expect(screen.getAllByRole("button")[0]).toHaveTextContent("Googleでログイン");
    await userEvent.setup().click(screen.getByRole("button", { name: "Googleでログイン" }));
    expect(signInWithGoogle).toHaveBeenCalledTimes(1);
    expect(onAuthenticated).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("パスワード")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("メールアドレス")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "ログインリンクを使う" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Googleでログイン" })).toBeDisabled();
  });

  it("keeps Google login retryable without exposing password or email routes", async () => {
    render(<Login authClient={auth({ signInWithGoogle: async () => { throw new Error("private provider detail"); } })} onAuthenticated={vi.fn()} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Googleでログイン" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Googleでログインできませんでした");
    expect(screen.queryByText("private provider detail")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("パスワード")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Googleでログイン" })).toBeEnabled();
  });

  it("logs in with a password inside the installed app", async () => {
    const session = { accessToken: "token", userId: "user-1", email: "owner@example.com" };
    const signInWithPassword = vi.fn(async () => session);
    const onAuthenticated = vi.fn();
    const user = userEvent.setup();
    render(<Login authClient={auth({ signInWithPassword })} onAuthenticated={onAuthenticated} />);

    await user.type(screen.getByLabelText("メールアドレス"), "owner@example.com");
    await user.type(screen.getByLabelText("パスワード"), "long-password");
    await user.click(screen.getByRole("button", { name: "ログイン" }));

    expect(signInWithPassword).toHaveBeenCalledWith("owner@example.com", "long-password");
    expect(onAuthenticated).toHaveBeenCalledWith(session);
  });

  it("requests a login link and shows generic delivery copy without revealing allowlist membership", async () => {
    const requestOtp = vi.fn(async () => undefined);
    const user = userEvent.setup();
    render(<Login authClient={auth({ requestOtp })} onAuthenticated={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "ログインリンクを使う" }));
    await user.type(screen.getByLabelText("メールアドレス"), "owner@example.com");
    await user.click(screen.getByRole("button", { name: "ログインリンクを受け取る" }));

    expect(await screen.findByText("ログインリンクを送信しました。メール内のリンクを開いてください。")).toBeVisible();
    expect(screen.queryByLabelText("確認コード")).not.toBeInTheDocument();
    expect(screen.queryByText(/許可|登録済み|対象外/)).not.toBeInTheDocument();
  });

  it("keeps a failed link request retryable without exposing upstream details", async () => {
    const requestOtp = vi.fn(async () => { throw new Error("upstream detail"); });
    const user = userEvent.setup();
    render(<Login authClient={auth({ requestOtp })} onAuthenticated={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "ログインリンクを使う" }));
    await user.type(screen.getByLabelText("メールアドレス"), "owner@example.com");
    await user.click(screen.getByRole("button", { name: "ログインリンクを受け取る" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("ログインリンクを送信できませんでした。もう一度お試しください。");
    expect(screen.queryByText("upstream detail")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "ログインリンクを受け取る" })).toBeEnabled();
  });
});
