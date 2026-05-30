import HomeOrLanding from "@/components/landing/HomeOrLanding";

/**
 * Route entry for `/`. Stays a server component; the client gate decides
 * whether an anonymous first-time visitor sees the marketing LANDING or the
 * app HOME (the previous contents of this file, now in components/home/HomePage).
 */
export default function Page() {
  return <HomeOrLanding />;
}
