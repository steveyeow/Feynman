import type { Metadata } from "next";
import LegalPage from "@/components/legal/LegalPage";

export const metadata: Metadata = {
  title: "Privacy Policy — Feynman",
  description: "How Feynman collects, uses, and protects your information.",
  alternates: { canonical: "/privacy" },
};

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy" date="Effective date: March 15, 2026">
      <p>
        This Privacy Policy describes how Feynman (“the Service”, “we”, “us”,
        “our”) collects, uses, and protects your information. We are committed to
        protecting your privacy and being transparent about our data practices.
      </p>

      <h2>1. Information We Collect</h2>

      <h3>1.1 Account Information</h3>
      <p>When you create an account, we collect:</p>
      <ul>
        <li><strong>Email address</strong> — used for authentication and account recovery.</li>
        <li><strong>Name and profile photo</strong> — if you sign in with Google, we receive these from your Google account.</li>
      </ul>
      <p>
        Authentication is handled by Supabase. We do not store your password
        directly; it is managed by Supabase Auth.
      </p>

      <h3>1.2 Usage Data</h3>
      <p>We collect data about how you use the Service to enforce quotas and improve the product:</p>
      <ul>
        <li>Number of chats, searches, and API calls (for quota management).</li>
        <li>Features used and pages visited.</li>
        <li>Timestamps of activity.</li>
      </ul>

      <h3>1.3 Content You Provide</h3>
      <ul>
        <li><strong>Uploaded files</strong> — PDF and TXT files you upload for AI analysis. These are processed and stored solely for your use.</li>
        <li><strong>Chat messages</strong> — your conversations with books and great minds.</li>
        <li><strong>Custom minds</strong> — text, URLs, or profiles you provide to create custom AI minds.</li>
      </ul>

      <h3>1.4 Payment Information</h3>
      <p>
        If you subscribe to Pro, payment processing is handled entirely by Stripe.
        We do not store your credit card number, CVV, or full card details. We
        receive and store only:
      </p>
      <ul>
        <li>Your Stripe customer ID and subscription ID.</li>
        <li>Subscription status (active, cancelled, etc.).</li>
      </ul>

      <h2>2. How We Use Your Information</h2>
      <table>
        <tbody>
          <tr>
            <th>Purpose</th>
            <th>Data Used</th>
          </tr>
          <tr>
            <td>Provide and operate the Service</td>
            <td>Account info, uploaded content, chat messages</td>
          </tr>
          <tr>
            <td>Process payments</td>
            <td>Stripe customer ID, subscription status</td>
          </tr>
          <tr>
            <td>Enforce usage quotas</td>
            <td>Usage counts per action type</td>
          </tr>
          <tr>
            <td>Improve AI mind responses</td>
            <td>Anonymized conversation traits (never specific chat content)</td>
          </tr>
          <tr>
            <td>Communicate with you</td>
            <td>Email address</td>
          </tr>
        </tbody>
      </table>

      <h2>3. How We Protect Your Data</h2>

      <h3>3.1 Chat Privacy</h3>
      <p>
        Your chat conversations are private to your account. When AI minds
        accumulate memory from conversations:
      </p>
      <ul>
        <li><strong>Private memories</strong> (full conversation summaries) are only visible to you.</li>
        <li><strong>Global traits</strong> (anonymized topic tags like “philosophy of mind” or “behavioral economics”) may be shared across users to improve mind quality. These never contain specific conversation content.</li>
      </ul>

      <h3>3.2 Uploaded Files</h3>
      <p>
        Your uploaded files are stored securely and are only accessible through
        your account. We do not share your uploaded content with other users or
        use it to train AI models.
      </p>

      <h3>3.3 Security Measures</h3>
      <ul>
        <li>All data in transit is encrypted via HTTPS/TLS.</li>
        <li>Authentication tokens are managed by Supabase with industry-standard JWT practices.</li>
        <li>Payment data is handled by Stripe, a PCI DSS Level 1 certified processor.</li>
      </ul>

      <h2>4. Third-Party Services</h2>
      <p>We use the following third-party services that may process your data:</p>
      <table>
        <tbody>
          <tr>
            <th>Service</th>
            <th>Purpose</th>
            <th>Their Privacy Policy</th>
          </tr>
          <tr>
            <td>Supabase</td>
            <td>Authentication, database</td>
            <td>
              <a href="https://supabase.com/privacy" target="_blank" rel="noopener noreferrer">
                supabase.com/privacy
              </a>
            </td>
          </tr>
          <tr>
            <td>Stripe</td>
            <td>Payment processing</td>
            <td>
              <a href="https://stripe.com/privacy" target="_blank" rel="noopener noreferrer">
                stripe.com/privacy
              </a>
            </td>
          </tr>
          <tr>
            <td>Google (Gemini API)</td>
            <td>AI model provider</td>
            <td>
              <a href="https://policies.google.com/privacy" target="_blank" rel="noopener noreferrer">
                policies.google.com/privacy
              </a>
            </td>
          </tr>
          <tr>
            <td>Vercel</td>
            <td>Hosting</td>
            <td>
              <a href="https://vercel.com/legal/privacy-policy" target="_blank" rel="noopener noreferrer">
                vercel.com/legal/privacy-policy
              </a>
            </td>
          </tr>
          <tr>
            <td>Open Library</td>
            <td>Book metadata</td>
            <td>
              <a href="https://archive.org/about/terms.php" target="_blank" rel="noopener noreferrer">
                archive.org/about/terms
              </a>
            </td>
          </tr>
          <tr>
            <td>Google Books API</td>
            <td>Book metadata</td>
            <td>
              <a href="https://policies.google.com/privacy" target="_blank" rel="noopener noreferrer">
                policies.google.com/privacy
              </a>
            </td>
          </tr>
        </tbody>
      </table>

      <h2>5. Data Retention</h2>
      <ul>
        <li><strong>Account data</strong> — retained as long as your account is active.</li>
        <li><strong>Chat history</strong> — retained as long as your account is active. You can delete individual sessions.</li>
        <li><strong>Uploaded files</strong> — retained as long as your account is active. You can delete them at any time.</li>
        <li><strong>Usage logs</strong> — retained for up to 90 days for quota enforcement and analytics.</li>
        <li>Upon account deletion, we will delete your personal data within 30 days, except where retention is required by law.</li>
      </ul>

      <h2>6. Your Rights</h2>
      <p>Depending on your jurisdiction, you may have the right to:</p>
      <ul>
        <li><strong>Access</strong> your personal data.</li>
        <li><strong>Correct</strong> inaccurate data.</li>
        <li><strong>Delete</strong> your account and associated data.</li>
        <li><strong>Export</strong> your data in a portable format.</li>
        <li><strong>Object to</strong> or restrict certain processing.</li>
      </ul>
      <p>
        To exercise these rights, contact us at{" "}
        <strong>shuqi.yeow@gmail.com</strong> or reach out on{" "}
        <a href="https://x.com/steve_yeow" target="_blank" rel="noopener noreferrer">
          Twitter/X
        </a>
        .
      </p>

      <h2>7. Cookies and Local Storage</h2>
      <p>
        The Service uses browser local storage to save UI preferences (theme,
        sidebar state) and session data. We do not use third-party tracking
        cookies or advertising cookies.
      </p>

      <h2>8. Children’s Privacy</h2>
      <p>
        The Service is not directed at children under 13. We do not knowingly
        collect personal information from children under 13. If we learn that we
        have collected data from a child under 13, we will delete it promptly.
      </p>

      <h2>9. International Data Transfers</h2>
      <p>
        Your data may be processed in the United States and other countries where
        our service providers operate. By using the Service, you consent to the
        transfer of your data to these locations.
      </p>

      <h2>10. Changes to This Policy</h2>
      <p>
        We may update this Privacy Policy from time to time. We will notify you of
        material changes by posting the updated policy with a new effective date.
        Your continued use of the Service after changes take effect constitutes
        acceptance.
      </p>

      <h2>11. Contact</h2>
      <p>
        If you have questions or concerns about this Privacy Policy, contact us at{" "}
        <strong>shuqi.yeow@gmail.com</strong> or reach out on{" "}
        <a href="https://x.com/steve_yeow" target="_blank" rel="noopener noreferrer">
          Twitter/X
        </a>
        .
      </p>
    </LegalPage>
  );
}
