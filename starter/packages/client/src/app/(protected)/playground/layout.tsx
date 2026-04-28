"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const services = [
  { href: "/playground/background-removal", label: "Background Removal" },
  { href: "/playground/3d-extraction", label: "3D Extraction" },
  { href: "/playground/subtitles", label: "Subtitles" },
  { href: "/playground/image-recognition", label: "Image Recognition" },
];

export default function PlaygroundLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">ML Playground</h1>
        <p className="text-muted-foreground">
          Test AI services with interactive demos
        </p>
      </div>

      <nav className="flex gap-1 overflow-x-auto rounded-lg border bg-muted/40 p-1">
        {services.map((svc) => {
          const isActive = pathname === svc.href;
          return (
            <Link
              key={svc.href}
              href={svc.href}
              className={`
                whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors
                ${isActive
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"}
              `}
            >
              {svc.label}
            </Link>
          );
        })}
      </nav>

      {children}
    </div>
  );
}
