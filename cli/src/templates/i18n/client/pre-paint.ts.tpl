/*
 * The script app/layout.tsx inlines into <head>, and why it lives here rather
 * than inline in that file: a layout module may only export what Next
 * recognises, so a constant declared there cannot be reached by a test. This
 * one runs before the first paint and nothing imports it at runtime.
 *
 * WHAT IT IS FOR. Every HTML file this project exports outside /<locale>/ is
 * prerendered in "__HATCHKIT_SOURCE_LOCALE__", and it has to be: hydration
 * must match the served DOM, so React's first render is in that language too
 * (i18n/store.ts explains why). A reader in __HATCHKIT_TARGET_LABEL_EN__
 * would therefore see the source language for as long as the JavaScript takes
 * to load — a flash of the wrong language on every hard navigation and every
 * cold launch. So this script resolves the language before anything paints,
 * writes `lang` and `data-locale` onto <html>, and marks the document
 * pending; globals.css hides `[data-locale-gate]` while that mark is present,
 * and <LocaleRoot> removes it in the same flush as the translated render.
 *
 * IT MUST RESOLVE IDENTICALLY TO i18n/store.ts. Same precedence, same
 * primary-subtag matching, same supported list, same storage keys — which are
 * spelled out as literals here because the script is a string with no imports.
 * pre-paint.test.ts runs this script and the store over the same matrix of
 * stored preferences and `navigator.languages` and fails on any row where
 * they disagree: a disagreement lifts the gate on the wrong language, or
 * waits for a switch that never comes.
 *
 * Three more things it is shaped around:
 *
 *  - It hides the GATE, not <body>. A prerendered /<locale>/ page is already
 *    in its final language and opts out (`data-locale-fixed`), so a visitor
 *    to it is never held on a blank screen waiting for JavaScript it does not
 *    need.
 *  - A failsafe removes the mark on its own after __HATCHKIT_GATE_MS__ ms. If
 *    the bundle never arrives — a blocked chunk, a half-finished deploy — a
 *    page in the source language is a far better failure than an invisible
 *    one.
 *  - It writes only to <html>. A script that mutates <body> before hydration
 *    makes <body>'s attributes disagree with the served markup, and the only
 *    cure is `suppressHydrationWarning` on <body>, which then silences every
 *    other body-level mismatch permanently.
 *
 * Built by a function because the pseudo-locale must not exist in production:
 * the condition below is a plain `process.env.NODE_ENV` comparison the bundler
 * folds, so a production build contains no trace of it.
 */

/** The supported languages, source first — the fallback order. */
const SUPPORTED = __HATCHKIT_ALL_LOCALES_JSON__;

/**
 * The pseudo-locale switch, or "" in a production build.
 *
 * A module-scope ternary on `process.env.NODE_ENV`, and that shape is the
 * point: the bundler inlines the value, the comparison folds to `false`, and
 * the minifier drops the branch — so the string below is not merely unused in
 * a production bundle, it is absent from it. Reading the same switch the same
 * way store.ts's `isPseudoActive()` does, and persisting what the query string
 * asked for so the choice survives the next navigation.
 */
export const PSEUDO_BRANCH: string =
  process.env.NODE_ENV !== "production"
    ? `var ps=false;try{var q=new URLSearchParams(location.search).get("locale");` +
      `if(q==="pseudo"){localStorage.setItem("locale-pseudo","1");ps=true;}` +
      `else if(q==="off"){localStorage.removeItem("locale-pseudo");}` +
      `else{ps=localStorage.getItem("locale-pseudo")==="1";}}catch(e){}` +
      `if(ps){r.setAttribute("data-pseudo-locale","");}`
    : "";

/** `pseudoBranch` is {@link PSEUDO_BRANCH}, or "" for the production shape —
 *  pre-paint.test.ts builds both and runs them. */
export function localeScript(pseudoBranch: string): string {
  return (
    `(function(){try{` +
    `var r=document.documentElement,S=${JSON.stringify(SUPPORTED)},` +
    `src="__HATCHKIT_SOURCE_LOCALE__",l=src;` +
    // A prerendered per-language page owns its language outright: pin it and
    // never gate it. <FixedLocale> pins the React tree by the same rule.
    `var seg=(location.pathname.split("/")[1]||"");` +
    `if(seg!==src&&S.indexOf(seg)>-1){r.lang=seg;r.setAttribute("data-locale",seg);return;}` +
    `var s=null;try{s=localStorage.getItem("locale-preference");}catch(e){}` +
    pseudoBranch +
    `if(s&&s!=="system"&&S.indexOf(s)>-1){l=s;}` +
    `else{var n=(navigator.languages&&navigator.languages.length)?navigator.languages:[navigator.language||""];` +
    `for(var i=0;i<n.length;i++){var p=String(n[i]).trim().toLowerCase().split(/[-_;]/)[0];` +
    `if(S.indexOf(p)>-1){l=p;break;}}}` +
    `r.lang=l;r.setAttribute("data-locale",l);` +
    // Exactly store.ts's shouldGateFirstPaint(). The pseudo-locale gates too:
    // its text is not the prerendered text either.
    `if(${pseudoBranch === "" ? "l!==src" : "l!==src||ps"}){` +
    `r.setAttribute("data-locale-pending","");` +
    `setTimeout(function(){r.removeAttribute("data-locale-pending");},__HATCHKIT_GATE_MS__);}` +
    `}catch(e){}})();`
  );
}

/** The script app/layout.tsx inlines, for the build it is part of. */
export const LOCALE_SCRIPT: string = localeScript(PSEUDO_BRANCH);
