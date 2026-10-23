// ==========================================================================
// Modals: open URL, subtitle search (OpenSubtitles.org in the browser),
// licenses & credits.
// ==========================================================================

import { openUrl } from "../core/tauri.js";
import { isHlsUrl, isImageFile, isValidMediaUrl, nameFromUrl } from "../media/classify.js";

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
    if (!isValidMediaUrl(url)) {
      app.toast("Geçerli bir http(s) URL girin");
      return;
    }
    if (isHlsUrl(url) && !app.engine.mpvAvailable && !video.canPlayType("application/vnd.apple.mpegurl")) {
      app.toast("⚠️ HLS (.m3u8) akışları bu sürümde desteklenmiyor");
      return;
    }
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
    const cleanName = cleanMovieName(currentFilename.textContent);
    inputSubQuery.value = cleanName === "Video Bekleniyor" ? "" : cleanName;
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
      app.toast("⚠️ Tarayıcı açılamadı");
      return false;
    }
  }

  async function openOnlineSubtitleSearch() {
    const query = inputSubQuery.value.trim();
    if (!query) {
      app.toast("Lütfen bir film veya dizi adı girin");
      inputSubQuery.focus();
      return;
    }
    if (await openExternalUrl(buildSubtitleSearchUrl(query, selectSubLang.value))) {
      app.toast("Arama tarayıcıda açıldı. İndirdiğiniz altyazıyı yükleyin.");
    }
  }

  function renderSubtitleSearch() {
    const card = document.createElement("div");
    card.className = "sub-result-card";

    const info = document.createElement("div");
    const title = document.createElement("div");
    title.className = "sub-card-title";
    title.textContent = "İndirdiğiniz altyazıyı uygulayın";
    const meta = document.createElement("div");
    meta.className = "sub-card-meta";
    meta.textContent = ".srt / .vtt • UTF-8 veya Windows-1254 (Türkçe) kodlama desteklenir";
    info.append(title, meta);

    const btnLoad = document.createElement("button");
    btnLoad.className = "btn-primary btn-sm";
    btnLoad.textContent = "Dosyadan Yükle";
    btnLoad.addEventListener("click", () => subFileInput.click());

    card.append(info, btnLoad);
    subSearchResults.replaceChildren(card);
  }

  // ------------------------------------------------------------------------
  // Licenses & credits
  // ------------------------------------------------------------------------
  btnOpenLicenses?.addEventListener("click", async () => {
    licensesModal.classList.add("active");
    try {
      licensesText.textContent = await (await fetch("legal/THIRD_PARTY_NOTICES.txt")).text();
    } catch (e) {
      licensesText.textContent = "Lisans dosyası okunamadı.";
    }
  });
  btnCloseLicenses?.addEventListener("click", () => licensesModal.classList.remove("active"));
}
