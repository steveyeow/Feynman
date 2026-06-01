import Link from "next/link";
import styles from "./legal.module.css";

/**
 * Shared layout for the legal reading pages (Terms / Privacy). A clean,
 * theme-aware centered column with a back link — mirrors production's standalone
 * /terms + /privacy (.legal) pages, restyled with the app's design tokens.
 */
export default function LegalPage({
  title,
  date,
  children,
}: {
  title: string;
  date: string;
  children: React.ReactNode;
}) {
  return (
    <div className={styles.page}>
      <div className={styles.container}>
        <Link href="/" className={styles.back}>
          ← Back to Feynman
        </Link>
        <h1 className={styles.title}>{title}</h1>
        <p className={styles.date}>{date}</p>
        {children}
      </div>
    </div>
  );
}
