/*
 * Download links, the way t3.codes does them (apps/marketing/src/lib/releases.ts): the page asks GitHub's
 * public API for the newest release and links its Apple silicon DMG. A release changes nothing on this site,
 * so the site never needs a deploy to ship a version. This is the site's one remote request. Each answer is
 * kept for the tab in sessionStorage, as t3.codes does, so a visit asks GitHub at most once per channel.
 *
 * Every Download button starts at /download, so the page works with no answer from GitHub.
 */
(function (root) {
  "use strict";

  var REPO = "ddmirolli/yeschef";
  var PAGE = "https://github.com/" + REPO + "/releases";
  var API = "https://api.github.com/repos/" + REPO + "/releases";
  var NIGHTLIES = PAGE + "?q=nightly&expanded=true";
  var PER_PAGE = 30; // Nightly reads one page of GitHub's newest releases (t3.codes reads 10)

  // The release's Apple silicon disk image. The release build names it Yes-Chef-<version>-arm64.dmg.
  function dmgOf(release) {
    var assets = (release && release.assets) || [];
    for (var i = 0; i < assets.length; i++) {
      var a = assets[i];
      if (a && /-arm64\.dmg$/.test(a.name || "") && a.browser_download_url) {
        return { url: a.browser_download_url, size: a.size || 0, name: a.name };
      }
    }
    return null;
  }

  // Nightly tags look like v0.2.1-nightly.20261110.1 (desktop/channels.mjs).
  function isNightly(tag) { return /-nightly\./.test(tag || ""); }

  // The newest published Nightly with a disk image, from GitHub's newest-first list.
  function pickNightly(list) {
    if (!Array.isArray(list)) return null;
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (r && !r.draft && isNightly(r.tag_name) && dmgOf(r)) return r;
    }
    return null;
  }

  // { state: "ok", release, dmg } | { state: "none" } (no such release yet) | { state: "error" } (GitHub didn't answer)
  // | { state: "older" } (a full page of releases and no Nightly in it: one may be older, so never say "none").
  function lookup(channel, fetchImpl, store) {
    var key = "yc.release." + channel;
    try {
      var kept = store && store.getItem(key);
      if (kept) {
        var release = JSON.parse(kept);
        var dmg = dmgOf(release);
        if (dmg) return Promise.resolve({ state: "ok", release: release, dmg: dmg });
      }
    } catch (e) {}
    var url = channel === "nightly" ? API + "?per_page=" + PER_PAGE : API + "/latest";
    return fetchImpl(url, { headers: { Accept: "application/vnd.github+json" } }).then(function (res) {
      if (res.status === 404) return { state: "none" };
      if (!res.ok) return { state: "error" };
      return res.json().then(function (body) {
        var release = channel === "nightly" ? pickNightly(body) : body;
        var dmg = dmgOf(release);
        if (!dmg) return channel === "nightly" && Array.isArray(body) && body.length >= PER_PAGE ? { state: "older" } : { state: "none" };
        try { if (store) store.setItem(key, JSON.stringify(release)); } catch (e) {}
        return { state: "ok", release: release, dmg: dmg };
      });
    }).catch(function () { return { state: "error" }; }); // a failed request or a body that fails to read
  }

  var api = { REPO: REPO, PAGE: PAGE, NIGHTLIES: NIGHTLIES, PER_PAGE: PER_PAGE, dmgOf: dmgOf, isNightly: isNightly, pickNightly: pickNightly, lookup: lookup };
  root.YCReleases = api;

  var doc = root.document;
  if (!doc || typeof root.fetch !== "function") return;
  var store = null;
  try { store = root.sessionStorage; } catch (e) {}
  function ask(channel) { return lookup(channel, root.fetch.bind(root), store); }
  function each(selector, fn) { Array.prototype.forEach.call(doc.querySelectorAll(selector), fn); }

  // Home page: each Download button takes the Stable DMG. The button has no line under it (Dan, 2026-11-10).
  if (doc.querySelector("[data-dl]")) {
    ask("stable").then(function (r) {
      if (r.state !== "ok") return;
      each("[data-dl]", function (a) { a.href = r.dmg.url; });
    });
  }

  // The /download page: Stable or Nightly (?channel=nightly), like t3.codes/download. Like the home page, it
  // shows no version, size or requirements (Dan, 2026-11-10): the line under the toggle speaks only when there
  // is no DMG to link.
  var page = doc.getElementById("download-page");
  if (!page) return;
  var label = doc.querySelector("[data-dl-version]");
  var card = doc.querySelector("[data-dl-card]");
  var notes = { stable: "No release yet.", nightly: "No Nightly yet." };

  function channelOf(search) { return new URLSearchParams(search).get("channel") === "nightly" ? "nightly" : "stable"; }
  function show(channel) {
    page.setAttribute("data-channel", channel);
    each("[data-channel-pick]", function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-channel-pick") === channel)); });
    label.hidden = true;
    label.textContent = "";
    card.href = PAGE;
    card.removeAttribute("aria-disabled");
    ask(channel).then(function (r) {
      if (page.getAttribute("data-channel") !== channel) return;
      if (r.state === "ok") { card.href = r.dmg.url; return; }
      label.hidden = false;
      if (r.state === "none") {
        label.textContent = notes[channel];
        card.removeAttribute("href");
        card.setAttribute("aria-disabled", "true");
      } else if (r.state === "older") {
        label.textContent = "Every Nightly is on GitHub Releases.";
        card.href = NIGHTLIES;
      } else {
        label.textContent = "GitHub didn't answer. Every build is on GitHub Releases.";
      }
    });
  }
  doc.addEventListener("click", function (event) {
    var b = event.target.closest && event.target.closest("[data-channel-pick]");
    if (!b) return;
    var channel = b.getAttribute("data-channel-pick");
    var url = new URL(root.location.href);
    if (channel === "nightly") url.searchParams.set("channel", "nightly"); else url.searchParams.delete("channel");
    root.history.replaceState(null, "", url);
    show(channel);
  });
  show(channelOf(root.location.search));
})(typeof window !== "undefined" ? window : globalThis);
