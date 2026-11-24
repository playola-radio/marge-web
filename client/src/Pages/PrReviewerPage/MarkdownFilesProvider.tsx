import { useRef, type ReactNode } from "react";
import { MarkdownFilesContext, type Cache } from "./markdownFiles";

/** One markdown file cache per page load, keyed by (run, path). */
export default function MarkdownFilesProvider({
  children,
}: {
  children: ReactNode;
}) {
  const cache = useRef<Cache>(new Map());
  return (
    <MarkdownFilesContext.Provider value={cache.current}>
      {children}
    </MarkdownFilesContext.Provider>
  );
}
