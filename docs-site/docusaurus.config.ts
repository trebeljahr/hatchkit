import type { Config } from "@docusaurus/types";

const config: Config = {
  title: "Node Realtime Starter",
  tagline: "A stampable starter for multiplayer web games and SaaS apps",
  url: "https://docs.example.com",
  baseUrl: "/",
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
