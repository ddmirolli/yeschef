import { lookup, NIGHTLIES, PAGE, type Channel, type ReleaseStore } from './releases.ts';

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
    void ask(channel).then((result) => {
      if (page.getAttribute('data-channel') !== channel) return;
      if (result.state === 'ok') { card.href = result.dmg.url; return; }
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
