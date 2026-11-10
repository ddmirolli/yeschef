// The site's /join page (step 3b): an invite link is https://yeschef.codes/join#<invite>. The invite stays in the
// fragment, which a browser never sends to a server, and goes only to the Yes Chef app as yeschef://join#<invite>.
(function (root) {
  /** The app link for a page address, or null when it holds no invite. */
  function appLink(href) {
    var i = String(href || '').indexOf('#');
    var frag = i < 0 ? '' : String(href).slice(i + 1).trim();
    if (!frag || frag.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(frag)) return null;
    return 'yeschef://join#' + frag;
  }
  root.YCJoin = { appLink: appLink };
  if (typeof document === 'undefined') return;
  var link = appLink(location.href);
  var open = document.querySelector('[data-join-open]');
  var missing = document.querySelector('[data-join-missing]');
  if (link) { open.href = link; open.hidden = false; } else { missing.hidden = false; }
})(globalThis);
