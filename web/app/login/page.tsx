import type { Metadata } from "next";
import AppShell from "@/components/shell/AppShell";
import LoginForm from "@/components/auth/LoginForm";

export const metadata: Metadata = {
  title: "Sign in — Feynman",
  robots: { index: false },
};

export default function LoginPage() {
  return (
    <AppShell>
      <div className="login-page-wrap">
        <LoginForm />
      </div>
    </AppShell>
  );
}
