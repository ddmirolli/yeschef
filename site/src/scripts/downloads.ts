import { builtAgo, builtOn, lookup, NIGHTLIES, PAGE, releasePage, type Channel, type ReleaseStore } from './releases.ts';

export function initializeDownloads(): void {
  let store: ReleaseStore | null = null;
  try { store = window.sessionStorage; } catch { /* Storage is optional. */ }
  const ask = (channel: Channel) => lookup(channel, window.fetch.bind(window), store);

  if (document.querySelector('[data-dl]')) {
    void ask('stable').then((result) => {
      if (result.state !== 'ok') return;
      for (const anchor of document.querySelectorAll<HTMLAnchorElement>('[data-dl]')) anchor.href = result.dmg.url;
    });
  }

  const page = document.getElementById('download-page');
  const label = document.querySelector<HTMLElement>('[data-dl-version]');
  const card = document.querySelector<HTMLAnchorElement>('[data-dl-card]');
  const built = document.querySelector<HTMLAnchorElement>('[data-dl-built]');
  if (!page || !label || !card) return;
  const notes: Record<Channel, string> = { stable: 'No release yet.', nightly: 'No Nightly yet.' };

  function show(channel: Channel): void {
    if (!page || !label || !card) return;
    page.setAttribute('data-channel', channel);
    for (const button of document.querySelectorAll('[data-channel-pick]')) {
      button.setAttribute('aria-pressed', String(button.getAttribute('data-channel-pick') === channel));
    }
    label.hidden = true;
    label.textContent = '';
    card.href = PAGE;
    card.removeAttribute('aria-disabled');
    // No link until there is a build time to show: a blank link would still take focus (PR-Agent r1 on #72).
    if (built) { built.textContent = '\u00a0'; built.removeAttribute('href'); }
    void ask(channel).then((result) => {
      if (page.getAttribute('data-channel') !== channel) return;
      if (result.state === 'ok') {
        card.href = result.dmg.url;
        // When the build was made, linking to that release (Dan, 2026-11-13).
        // Stable by its date, Nightly by its age (Dan, 2026-11-13).
        const age = channel === 'stable' ? builtOn(result.release.published_at) : builtAgo(result.release.published_at, Date.now());
        if (built && age) {
          const arrow = document.createElement('span');
          arrow.setAttribute('aria-hidden', 'true');
          arrow.textContent = ' \u2197';
          built.replaceChildren(age, arrow);
          built.href = releasePage(result.release) ?? PAGE;
        }
        return;
      }
      label.hidden = false;
      if (result.state === 'none') {
        label.textContent = notes[channel];
        card.removeAttribute('href');
        card.setAttribute('aria-disabled', 'true');
      } else if (result.state === 'older') {
        label.textContent = 'Every Nightly is on GitHub Releases.';
        card.href = NIGHTLIES;
      } else {
        label.textContent = "GitHub didn't answer. Every build is on GitHub Releases.";
      }
    });
  }

  document.addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest('[data-channel-pick]') : null;
    if (!button) return;
    const channel = button.getAttribute('data-channel-pick') === 'nightly' ? 'nightly' : 'stable';
    const url = new URL(location.href);
    if (channel === 'nightly') url.searchParams.set('channel', channel);
    else url.searchParams.delete('channel');
    history.replaceState(null, '', url);
    show(channel);
  });
  show(new URLSearchParams(location.search).get('channel') === 'nightly' ? 'nightly' : 'stable');
}
