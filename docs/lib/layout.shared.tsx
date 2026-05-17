import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: "hatchkit",
    },
    links: [
      {
        text: "Docs",
        url: "/docs",
        active: "nested-url",
      },
      {
        text: "Get started",
        url: "/docs/getting-started",
      },
      {
        text: "npm",
        url: "https://www.npmjs.com/package/hatchkit",
        external: true,
      },
    ],
    githubUrl: process.env.NEXT_PUBLIC_GITHUB_URL ?? "https://github.com/trebeljahr/hatchkit",
  };
}
