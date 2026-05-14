import type { Config } from "@docusaurus/types";

const docsUrl = process.env.DOCS_SITE_URL ?? "https://docs.example.com";
const usesPlaceholderUrl = docsUrl === "https://docs.example.com";

const config: Config = {
  title: "Node Realtime Starter",
  tagline: "A stampable starter for multiplayer web games and SaaS apps",
  url: docsUrl,
  baseUrl: "/",
  noIndex: usesPlaceholderUrl,
  onBrokenLinks: "throw",
  onBrokenMarkdownLinks: "warn",
  favicon: "img/favicon.ico",

  presets: [
    [
      "classic",
      {
        docs: {
          routeBasePath: "/",
          sidebarPath: "./sidebars.ts",
        },
        blog: false,
      },
    ],
  ],

  themeConfig: {
    navbar: {
      title: "Node Realtime Starter",
      items: [
        { type: "docSidebar", sidebarId: "docs", position: "left", label: "Docs" },
      ],
    },
    colorMode: {
      respectPrefersColorScheme: true,
    },
  },
};

export default config;
