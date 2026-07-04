"use client";

import { useEffect } from "react";

/**
 * Last-resort boundary for errors thrown in the root layout itself. It replaces
 * the whole document, so it must render its own <html>/<body> and can't rely on
 * globals.css — styles are inlined to match the app's dark theme.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "20px",
          background: "#1b1f1d",
          color: "#f2ecda",
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
        }}
      >
        <div
          style={{
            width: "100%",
            maxWidth: "380px",
            background: "#242a27",
            border: "1px solid #353d39",
            borderRadius: "16px",
            padding: "30px 26px",
            textAlign: "center",
          }}
        >
          <h1 style={{ fontSize: "28px", margin: "0 0 6px" }}>
            Something went wrong
          </h1>
          <p style={{ color: "#9aa39a", fontSize: "14px", margin: "0 0 20px" }}>
            The app hit an unexpected error. Try again, or return to the login
            screen.
          </p>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "10px",
            }}
          >
            <button
              type="button"
              onClick={() => reset()}
              style={{
                padding: "13px 15px",
                fontSize: "16px",
                fontWeight: 600,
                color: "#0f1411",
                background: "#4e9d68",
                border: "none",
                borderRadius: "12px",
                cursor: "pointer",
              }}
            >
              Try again
            </button>
            <a
              href="/login"
              style={{ color: "#61b97f", fontSize: "14px", marginTop: "4px" }}
            >
              Back to login
            </a>
          </div>
        </div>
      </body>
    </html>
  );
}
