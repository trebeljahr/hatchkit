import { ProjectDonateLink } from "./project-donate-link";
const links = [
  { text: "GitHub", url: "https://github.com/trebeljahr/hatchkit" },
  { text: "npm", url: "https://www.npmjs.com/package/hatchkit" },
  { text: "Donate", url: "https://ricos.site/donate/hatchkit" },
];

export function SiteFooter() {
  return (
    <footer className="border-t border-fd-border py-6 text-sm text-fd-muted-foreground">
      <nav aria-label="Footer" className="flex flex-wrap justify-center gap-x-6 gap-y-2">
        {links.map((link) => (
          link.text === "Donate" ? (
            <ProjectDonateLink key={link.text} href={link.url} className="transition-colors hover:text-fd-foreground">{link.text}</ProjectDonateLink>
          ) : (
          <a key={link.text} href={link.url} className="transition-colors hover:text-fd-foreground">
            {link.text}
          </a>
          )
        ))}
      </nav>
    </footer>
  );
}
