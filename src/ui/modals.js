// ==========================================================================
// Modals: open URL, subtitle search (OpenSubtitles.org in the browser),
// licenses & credits.
// ==========================================================================

import { t } from "../core/i18n.js";
import { openUrl } from "../core/tauri.js";
import { isHlsUrl, isImageFile, nameFromUrl } from "../media/classify.js";
import { hasSecret, parseStreamUrl } from "../media/net-logic.js";

export const OPENSUBS_LANG = { tr: "tur", en: "eng", de: "ger", fr: "fre" };

/** "Movie.Name.2010.1080p.x264.mkv" -> "Movie Name 2010" (search query from a file name). */
export function cleanMovieName(fileName) {
  return (fileName || "")
    .replace(/\.(mp4|mkv|avi|mov|webm|m4v)$/i, "")
    .replace(/(\b(1080p|720p|2160p|4k|bluray|web-dl|webrip|x264|x265|hevc|aac)\b)/gi, "")
    .replace(/[\._\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildSubtitleSearchUrl(query, lang) {
  const langId = OPENSUBS_LANG[lang] || "all";
  return `https://www.opensubtitles.org/tr/search2/sublanguageid-${langId}/moviename-${encodeURIComponent(query)}`;
}

/**
 * app: { dom, toast, loader }  (resolved lazily)
 */
export function createModals(app) {
  const { dom } = app;
  const {
    video, currentFilename, urlModal, inputUrl, btnOpenUrl, btnCancelUrl, btnConfirmUrl,
    btnSearchSubtitles, subtitleSearchModal, btnCloseSubModal, inputSubQuery, selectSubLang, btnDoSubSearch,
    subSearchResults, subFileInput, licensesModal, licensesText, btnOpenLicenses, btnCloseLicenses,
  } = dom;

  // ------------------------------------------------------------------------
  // URL modal
  // ------------------------------------------------------------------------
  btnOpenUrl.addEventListener("click", () => {
    urlModal.classList.add("active");
    inputUrl.focus();
  });

  btnCancelUrl.addEventListener("click", () => {
    urlModal.classList.remove("active");
  });

  function confirmUrl() {
    const url = inputUrl.value.trim();
    // http(s) only (L04: same list as src-tauri/src/net.rs)
    if (!parseStreamUrl(url)) {
      app.toast(t("ui.url.invalid"));
      return;
    }
    if (isHlsUrl(url) && !app.engine.mpvAvailable && !video.canPlayType("application/vnd.apple.mpegurl")) {
      app.toast(t("ui.url.hlsUnsupported"));
      return;
    }
    if (hasSecret(url)) app.toast(t("ui.url.secretNotSaved"));
    app.loader.openUrlItem({ url, name: nameFromUrl(url), isImage: isImageFile(url) });
    urlModal.classList.remove("active");
    inputUrl.value = "";
  }

  btnConfirmUrl.addEventListener("click", confirmUrl);
  inputUrl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") confirmUrl();
  });

  // ------------------------------------------------------------------------
  // Subtitle search (opens OpenSubtitles.org; user loads the downloaded file)
  // ------------------------------------------------------------------------
  btnSearchSubtitles.addEventListener("click", () => {
    // the title shows a file name only while media is open (otherwise it carries an i18n key)
    inputSubQuery.value = currentFilename.dataset.i18n ? "" : cleanMovieName(currentFilename.textContent);
    subtitleSearchModal.classList.add("active");
    renderSubtitleSearch();
    inputSubQuery.focus();
  });

  btnCloseSubModal.addEventListener("click", () => {
    subtitleSearchModal.classList.remove("active");
  });

  btnDoSubSearch.addEventListener("click", openOnlineSubtitleSearch);
  inputSubQuery.addEventListener("keydown", (e) => {
    if (e.key === "Enter") openOnlineSubtitleSearch();
  });

  async function openExternalUrl(url) {
    try {
      await openUrl(url);
      return true;
    } catch (e) {
      console.warn("openUrl", e);
      app.toast(t("ui.subsSearch.browserFailed"));
      return false;
    }
  }

  async function openOnlineSubtitleSearch() {
    const query = inputSubQuery.value.trim();
    if (!query) {
      app.toast(t("ui.subsSearch.enterName"));
      inputSubQuery.focus();
      return;
    }
    if (await openExternalUrl(buildSubtitleSearchUrl(query, selectSubLang.value))) {
      app.toast(t("ui.subsSearch.opened"));
    }
  }

  function renderSubtitleSearch() {
    const card = document.createElement("div");
    card.className = "sub-result-card";

    const info = document.createElement("div");
    const title = document.createElement("div");
    title.className = "sub-card-title";
    title.dataset.i18n = "ui.subsSearch.applyTitle";
    title.textContent = t("ui.subsSearch.applyTitle");
    const meta = document.createElement("div");
    meta.className = "sub-card-meta";
    meta.dataset.i18n = "ui.subsSearch.applyMeta";
    meta.textContent = t("ui.subsSearch.applyMeta");
    info.append(title, meta);

    const btnLoad = document.createElement("button");
    btnLoad.className = "btn-primary btn-sm";
    btnLoad.dataset.i18n = "ui.subsSearch.loadFile";
    btnLoad.textContent = t("ui.subsSearch.loadFile");
    btnLoad.addEventListener("click", () => subFileInput.click());

    card.append(info, btnLoad);
    subSearchResults.replaceChildren(card);
  }

  // ------------------------------------------------------------------------
  // Licenses & credits
  // ------------------------------------------------------------------------
  btnOpenLicenses?.addEventListener("click", async () => {
    licensesModal.classList.add("active");
    licensesText.textContent = t("ui.licenses.loading");
    try {
      licensesText.textContent = await (await fetch("legal/THIRD_PARTY_NOTICES.txt")).text();
    } catch (e) {
      licensesText.textContent = t("ui.licenses.readFailed");
    }

  });
  btnCloseLicenses?.addEventListener("click", () => licensesModal.classList.remove("active"));
}
