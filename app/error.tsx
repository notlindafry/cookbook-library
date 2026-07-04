"use client";

import { useEffect } from "react";

const SHORTLIST_KEY = "cookbook.shortlist";

/**
 * Route-level error boundary. Without one, any client-side exception drops the
 * user onto Next's bare "Application error" screen with no way back. This gives
 * them a friendly message plus real escape hatches: retry, clear locally-saved
 * data (the most common cause of a crash that recurs on every reload), or return
 * to the login page.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surface it for debugging without exposing details in the UI.
    console.error(error);
  }, [error]);

  function clearSavedAndReload() {
    try {
      localStorage.removeItem(SHORTLIST_KEY);
    } catch {
      /* storage unavailable; the reload alone may still recover */
    }
    window.location.href = "/";
  }

  return (
    <div className="login-wrap">
      <div className="login-card">
        <h1>Something went wrong</h1>
        <p className="login-sub">
          The page hit an unexpected error. You can try again, or head back to
          the login screen.
        </p>
        <div className="error-actions">
          <button type="button" onClick={() => reset()}>
            Try again
          </button>
          <button
            type="button"
            className="secondary"
            onClick={clearSavedAndReload}
          >
            Clear saved data &amp; reload
          </button>
          <a className="error-link" href="/login">
            Back to login
          </a>
        </div>
      </div>
    </div>
  );
}
