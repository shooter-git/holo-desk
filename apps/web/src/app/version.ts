import { useEffect, useState } from 'react';

let asked: Promise<string | null> | null = null;

/** This studio's version, as its host gives it: asked once, and again only if the host didn't answer. */
export function studioVersion(): Promise<string | null> {
  asked ??= fetch('/api/health')
    .then((r) => r.json() as Promise<{ version?: string }>)
    .then((h) => h.version ?? null)
    .catch(() => {
      asked = null;
      return null;
    });
  return asked;
}

/** The studio's version for a view to show (null until the host has said). */
export function useVersion(): string | null {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void studioVersion().then((v) => {
      if (live) setVersion(v);
    });
    return () => {
      live = false;
    };
  }, []);
  return version;
}
