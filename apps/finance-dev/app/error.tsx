"use client";

export default function FinanceError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <main><h1>Finance development</h1><p role="alert">
    Could not load the saved finance case. Check the connection and confirm the finance functions are deployed.
  </p><button onClick={reset}>Retry loading</button></main>;
}
