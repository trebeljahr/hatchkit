"use client";

import Link from "next/link";
import { ML_SERVICES } from "@starter/shared/ml-types";

export default function PlaygroundIndexPage() {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {ML_SERVICES.map((svc) => (
        <Link
          key={svc.name}
          href={`/playground/${svc.name}`}
          className="group rounded-lg border p-6 transition-colors hover:border-primary/50 hover:bg-muted/30"
          data-testid={`playground-card-${svc.name}`}
        >
          <h3 className="font-semibold group-hover:text-primary">
            {svc.label}
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {svc.description}
          </p>
          <p className="mt-3 text-xs text-muted-foreground/60">
            Accepts: {svc.acceptedTypes.map((t) => t.split("/")[1]).join(", ")} · Max {svc.maxFileSizeMb} MB
          </p>
        </Link>
      ))}
    </div>
  );
}
