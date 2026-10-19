import { DocsBody, DocsDescription, DocsTitle } from "fumadocs-ui/layouts/docs/page";
import Link from "next/link";
import type { ReactNode } from "react";
import {
  LEGAL_EMAIL,
  OPERATOR_ADDRESS,
  OPERATOR_NAME,
  PRIVACY_UPDATED_AT,
  legalMetadata,
} from "@/lib/legal";

export const metadata = legalMetadata({
  title: "Privacy",
  path: "/privacy",
  description:
    "Every server your browser contacts on hatchkit.trebeljahr.com, what each one receives, and your rights under the GDPR.",
});

const updatedOn = new Date(PRIVACY_UPDATED_AT).toLocaleDateString("en-US", {
  dateStyle: "long",
  timeZone: "UTC",
});

function Host({ children }: { children: ReactNode }) {
  return <code>{children}</code>;
}

function PrivacyEmail() {
  return <a href={`mailto:${LEGAL_EMAIL}`}>{LEGAL_EMAIL}</a>;
}

// Update this page, and PRIVACY_UPDATED_AT in lib/legal.ts, whenever the site
// starts or stops contacting a server (a script, a font, an image, an embed)
// or writes another entry to the browser's storage.
export default function PrivacyPage() {
  return (
    <article className="mx-auto w-full max-w-3xl flex-1 px-4 py-12 sm:px-6 md:py-16">
      <DocsTitle>Privacy</DocsTitle>
      <DocsDescription>Last updated: {updatedOn}</DocsDescription>
      <DocsBody>
        <p>
          This page lists every server your browser contacts when you open{" "}
          <Host>hatchkit.trebeljahr.com</Host>, and what each one receives. The site has no
          accounts, no forms and no newsletter. It sets no cookies.
        </p>

        <h2>Controller</h2>
        <p>
          The controller under the EU General Data Protection Regulation (GDPR) is the service
          provider named in the <Link href="/imprint">imprint</Link>: {OPERATOR_NAME},{" "}
          {OPERATOR_ADDRESS.join(", ")}. Email for privacy questions: <PrivacyEmail />.
        </p>

        <h2>Servers your browser contacts</h2>
        <ul>
          <li>
            <Host>hatchkit.trebeljahr.com</Host>: the site itself, served by Cloudflare. Pages,
            scripts, styles, the font and the page data that your browser fetches ahead of time all
            come from here.
          </li>
          <li>
            <Host>static.cloudflareinsights.com</Host>: the script of Cloudflare Web Analytics.
            Visitors in the EU, the EEA, the United Kingdom and Switzerland do not get it.
          </li>
          <li>
            <Host>plausible.trebeljahr.com</Host>: my own Plausible Analytics server.
          </li>
        </ul>
        <p>
          No other server receives a request from your browser. A link to another site, such as
          GitHub, npm or the donation page on ricos.site, contacts that site only when you click it.
          The Donate link in the page footer adds the address of the page you are on, so the
          donation page can send you back.
        </p>

        <h2>Hosting by Cloudflare</h2>
        <p>
          The site is a set of static files. Cloudflare, Inc., 101 Townsend St, San Francisco, CA
          94107, USA, serves them from its Worker <Host>hatchkit-docs</Host>. The Worker has no
          script of its own. It only hands out the files. No server code of mine runs when you load
          a page.
        </p>
        <p>
          Cloudflare receives your IP address, the address of the page, the user agent and the
          referrer of each request. It uses them to deliver the site and to protect it against
          abuse. I do not export or keep logs of these requests.
        </p>
        <p>
          The font, Inter, is a copy on <Host>hatchkit.trebeljahr.com</Host>. Your browser contacts
          no font service and no script host other than the ones listed above.
        </p>
        <p>Legal basis: Art. 6 (1) (f) GDPR (legitimate interest in delivering the site securely).</p>

        <h2>Version check</h2>
        <p>
          While a page is open, it asks the site whether a newer release of the docs exists. The
          request goes to <Host>hatchkit.trebeljahr.com/releases.json</Host>. It runs when the page
          loads, once a minute and each time you return to the tab. The address of each request
          carries the current time.
        </p>
        <p>
          When a newer release has replaced the one your page loaded, the page reloads itself. The
          next section names the one entry this can write to your browser.
        </p>

        <h2>Cloudflare Web Analytics</h2>
        <p>
          Cloudflare adds the script of{" "}
          <a href="https://developers.cloudflare.com/web-analytics/">Cloudflare Web Analytics</a> to
          each page. Your browser loads it from <Host>static.cloudflareinsights.com</Host>, and the
          script sends its report to <Host>hatchkit.trebeljahr.com/cdn-cgi/rum</Host>.
        </p>
        <p>
          The report holds the address of the page and the referrer, both without the part after{" "}
          <code>?</code>. It holds the type and version of your browser and the version of your
          operating system. It also holds the memory the page uses and a random ID for the page
          view. The timings of the page load include Largest Contentful Paint, Interaction to Next
          Paint and Cumulative Layout Shift. For the largest paint and the slowest interaction, the
          report names the element on the page, for example a link. Cloudflare shows me totals by
          page, country, browser and device type.
        </p>
        <p>
          The script sets no cookies and stores nothing on your device. It gives each page view a
          random ID and keeps no ID from one page view to the next. Cloudflare receives your IP
          address with the report, discards it at the nearest data center and does not store it.
        </p>
        <p>
          Cloudflare does not add the script for visitors who connect through a Cloudflare data
          center in the EU, the EEA, the United Kingdom or Switzerland. For all other visitors the
          legal basis is Art. 6 (1) (f) GDPR (legitimate interest in knowing how fast the pages
          load). You can object at any time, or block <Host>static.cloudflareinsights.com</Host>{" "}
          with a content blocker.
        </p>

        <h2>Plausible Analytics</h2>
        <p>
          I count visits with <a href="https://plausible.io/data-policy">Plausible Analytics</a>. It
          runs on my own server at <Host>plausible.trebeljahr.com</Host>, rented from Hetzner Online
          GmbH in Nuremberg, Germany. Requests to it pass through Cloudflare as described under
          Hosting.
        </p>
        <p>
          Your browser loads the Plausible script from <Host>plausible.trebeljahr.com</Host> and
          sends its events there. That server receives your IP address and user agent. I do not
          route these requests through <Host>hatchkit.trebeljahr.com</Host>, so a content blocker
          can stop them. The site works the same without them.
        </p>
        <p>
          Plausible sets no cookies and stores nothing on your device. The script reads one entry
          from your local storage, <Host>plausible_ignore</Host>, to learn whether you switched
          counting off for your browser. It never writes that entry. Your browser has it only if you
          set it.
        </p>
        <p>
          Plausible combines your IP address and user agent with a salt that changes every day, and
          stores only the resulting hash. It deletes the salt after 24 hours, so nobody can trace
          the hash back to you. It never stores the IP address.
        </p>
        <p>
          Plausible records the page address, the referrer, the browser, the operating system, the
          device type and the country. It also records clicks on links to other sites, with the
          address of the link, and clicks on links to file downloads. It measures how far you scroll
          and how long the page has your attention. The script loads only on{" "}
          <Host>hatchkit.trebeljahr.com</Host>, not on local or test copies of the site.
        </p>
        <p>
          The script sends the page address and the referrer in full, including the part after{" "}
          <code>?</code> and the part after <code>#</code>. On this site the part after{" "}
          <code>#</code> names the heading you jumped to. Each jump to another heading counts as a
          page view.
        </p>
        <p>
          Legal basis: Art. 6 (1) (f) GDPR (legitimate interest in knowing which pages people read).
          You can object at any time.
        </p>

        <h2>Data in your browser</h2>
        <p>
          The site writes up to three entries to your browser. None of them goes to a server, and
          you can delete them by clearing the site data in your browser.
        </p>
        <ul>
          <li>
            <Host>theme</Host> (local storage): your choice of the light or the dark theme. The site
            writes it when you click the theme button, and reads it on your next visit.
          </li>
          <li>
            <Host>{"docs-release-reload:<version>"}</Host> (session storage): the time of the last
            automatic reload. A page reloads itself when a newer release has replaced the one it
            loaded, or when one of its script files fails to load. The entry stops it from
            reloading more than once a minute. The site writes it only after such a reload, and the
            browser deletes it when you close the tab.
          </li>
          <li>
            <Host>donation-supported-at</Host> (local storage): the time you came back from the
            donation page on ricos.site. The site writes it only when the address has{" "}
            <code>?supported=1</code>. Nothing reads it yet.
          </li>
        </ul>
        <p>
          Legal basis for the first two entries: § 25 (2) No. 2 TDDDG. The first stores a choice you
          made by clicking the button. The second keeps a page you opened from reloading in a loop.
          The third records your return from the donation page, and nothing reads it yet.
        </p>

        <h2>Transfers outside the EU</h2>
        <p>
          Cloudflare, Inc. is established in the United States. It handles each request in a data
          center of its network, normally the one nearest to you. Access by U.S. authorities under
          U.S. law cannot be fully excluded. My Plausible server is in Germany.
        </p>

        <h2>Storage period</h2>
        <ul>
          <li>
            Plausible keeps its events with no time limit. It identifies a visitor only by the daily
            hash, which nobody can link to you once the salt is deleted after 24 hours.
          </li>
          <li>
            Cloudflare Web Analytics keeps totals by page, country, browser and device type.
            Cloudflare does not store the IP address.
          </li>
          <li>
            The entries in your browser stay there until you delete them. The session entry goes
            when you close the tab.
          </li>
        </ul>

        <h2>Your rights</h2>
        <p>Under the GDPR you have the right to:</p>
        <ul>
          <li>access the personal data held about you (Art. 15);</li>
          <li>have inaccurate data corrected (Art. 16);</li>
          <li>have your data deleted (Art. 17), unless a legal obligation requires me to keep it;</li>
          <li>restrict processing (Art. 18);</li>
          <li>receive your data in a portable format (Art. 20);</li>
          <li>
            object to processing based on legitimate interest (Art. 21), which includes both kinds
            of analytics above.
          </li>
        </ul>
        <p>
          To use any of these rights, email <PrivacyEmail />. You can also complain to a
          supervisory authority (Art. 77 GDPR). The authority responsible for me is the
          Landesbeauftragte für den Datenschutz und die Informationsfreiheit Baden-Württemberg.
        </p>
        <p>
          The site makes no automated decisions about you and builds no profile of you (Art. 22
          GDPR).
        </p>

        <h2>Changes</h2>
        <p>
          I update this page when the site starts or stops using a server or an entry in your
          browser. The date at the top shows the last change.
        </p>
      </DocsBody>
    </article>
  );
}
