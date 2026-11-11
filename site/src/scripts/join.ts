// The /join page (step 3b): an invite link is https://yeschef.codes/join#<invite>. The invite stays in the fragment,
// which a browser never sends to a server, and goes only to the Yes Chef app as yeschef://join#<invite>.

/** The app link for a page address, or null when it holds no invite. */
export function appLink(href: string): string | null {
  const i = href.indexOf('#');
  const frag = i < 0 ? '' : href.slice(i + 1).trim();
  if (!frag || frag.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(frag)) return null;
  return `yeschef://join#${frag}`;
}

export function initializeJoin(): void {
  const open = document.querySelector<HTMLAnchorElement>('[data-join-open]');
  const missing = document.querySelector<HTMLElement>('[data-join-missing]');
  if (!open || !missing) return;
  const link = appLink(location.href);
  if (link) {
    open.href = link;
    open.hidden = false;
  } else {
    missing.hidden = false;
  }
}
