import { themes as prismThemes } from "prism-react-renderer";
import type { Config } from "@docusaurus/types";
import type * as Preset from "@docusaurus/preset-classic";

const config: Config = {
  title: "hatchkit",
  tagline: "Interactive CLI for scaffolding full-stack projects with composable ML services.",
  favicon: "img/favicon.ico",

  // Set the production url of your site here. Combined with baseUrl this is the
  // canonical URL where the site is served.
  url: "https://trebeljahr.github.io",
  baseUrl: "/hatchkit/",

  // GitHub pages deployment config — only used by the `docusaurus deploy`
  // command, but it's also surfaced by the editUrl below.
  organizationName: "trebeljahr",
  projectName: "hatchkit",
  trailingSlash: false,

  onBrokenLinks: "warn",
  onBrokenMarkdownLinks: "warn",

  i18n: {
    defaultLocale: "en",
    locales: ["en"],
  },

  presets: [
    [
      "classic",
      {
        docs: {
          // Treat the docs/ subfolder as the root of the site — `routeBasePath: "/"`
          // means landing on the index URL renders intro.md / index.md.
          sidebarPath: "./sidebars.ts",
          routeBasePath: "/",
          editUrl: "https://github.com/trebeljahr/hatchkit/edit/main/docs/",
        },
        blog: false,
        theme: {
          customCss: "./src/css/custom.css",
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    image: "img/social-card.png",
    colorMode: {
      defaultMode: "dark",
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: "hatchkit",
      logo: {
        alt: "hatchkit logo",
        src: "img/logo.svg",
      },
      items: [
        {
          type: "docSidebar",
          sidebarId: "docsSidebar",
          position: "left",
          label: "Docs",
        },
        {
          href: "https://www.npmjs.com/package/hatchkit",
          label: "npm",
          position: "right",
        },
        {
          href: "https://github.com/trebeljahr/hatchkit",
          label: "GitHub",
          position: "right",
        },
      ],
    },
    footer: {
      style: "dark",
      links: [
        {
          title: "Docs",
          items: [
            { label: "Getting Started", to: "/getting-started" },
            { label: "Commands", to: "/commands" },
            { label: "ML services", to: "/ml-services" },
          ],
        },
        {
          title: "Project",
          items: [
            { label: "GitHub", href: "https://github.com/trebeljahr/hatchkit" },
            { label: "npm", href: "https://www.npmjs.com/package/hatchkit" },
          ],
        },
      ],
      copyright: `MIT-licensed. Source on <a href="https://github.com/trebeljahr/hatchkit">GitHub</a>.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ["bash", "json", "yaml", "toml", "diff"],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
