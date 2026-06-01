import type { Metadata } from "next";
import LoginForm from "@/components/auth/LoginForm";

export const metadata: Metadata = {
  title: "Sign in — Feynman",
  robots: { index: false },
};

// Full-screen login — NO AppShell/Sidebar. The legacy app hid the chrome on
// this route (.app-layout.login-active .app-sidebar { display:none }); rendering
// the login outside the shell reproduces that clean, sidebar-less screen so we
// never show a signed-in sidebar next to a sign-in form.
export default function LoginPage() {
  return (
    <div className="login-page">
      <LoginForm />
    </div>
  );
}
