"use client";
export default function PlatformError({reset}:{reset:()=>void}) {return <main className="platform-config"><h1>Workspace unavailable</h1><p>The platform connection could not load this page. Check its Convex URL and deployment, then try again.</p><button onClick={reset}>Try again</button><p><a href="/examples">Open local examples</a></p></main>;}
