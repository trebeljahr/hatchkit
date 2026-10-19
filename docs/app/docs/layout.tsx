import { DocsLayout } from "fumadocs-ui/layouts/docs";
import Link from "next/link";
import type { ReactNode } from "react";
import { baseOptions } from "@/lib/layout.shared";
import { LEGAL_LINKS } from "@/lib/legal";
import { source } from "@/lib/source";

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout
      tree={source.getPageTree()}
      {...baseOptions()}
      sidebar={{
        // The docs pages have no page footer, so the legal pages sit here.
        footer: (
          <nav aria-label="Legal" className="flex flex-wrap gap-x-4 gap-y-1 px-2 pb-2 pt-1 text-xs text-fd-muted-foreground">
            {LEGAL_LINKS.map((link) => (
              <Link key={link.text} href={link.url} className="transition-colors hover:text-fd-foreground">
                {link.text}
              </Link>
            ))}
          </nav>
        ),
      }}
    >
      {children}
    </DocsLayout>
  );
}
