// ==UserScript==
// @name            TELAS (TEikyo Life & Academic Support)
// @namespace       https://telas.manjuu.net
// @version         1.0
// @description     在 LMS 加入一括下载：左侧导航和每张课程卡片（★ 旁边）的下载按钮打开右侧面板，按学期选课、批量下载文件和讲义视频，可打包 ZIP。纯本地运行：用你自己的浏览器和登录会话，作者收不到任何数据。支持 Tampermonkey / Violentmonkey（桌面）和 iOS / macOS Safari 的 Userscripts。
// @description:zh-CN 在 LMS 加入一括下载：左侧导航和每张课程卡片（★ 旁边）的下载按钮打开右侧面板，按学期选课、批量下载文件和讲义视频，可打包 ZIP。纯本地运行：用你自己的浏览器和登录会话，作者收不到任何数据。支持 Tampermonkey / Violentmonkey（桌面）和 iOS / macOS Safari 的 Userscripts。
// @description:ja  LMS に一括ダウンロードを追加：左メニューと各コースカード（★ の隣）のダウンロードボタンから右側のパネルを開き、学期・コースを選んで教材と講義ビデオをまとめて保存（ZIP 可）。すべてあなたのブラウザ内で、あなた自身のログインセッションを使って動作し、作者にデータが送られることは一切ありません。Tampermonkey / Violentmonkey（PC）と iOS / macOS Safari の Userscripts に対応。
// @description:en  Adds bulk download to the LMS: a left-menu item and a download button on every course card (next to the ★) open a side panel where you pick a term and course and save its materials and lecture videos, optionally as a ZIP. Runs entirely in your own browser with your own login session; no data is ever sent to the author. Works with Tampermonkey / Violentmonkey (desktop) and Userscripts for iOS / macOS Safari.
// @author          TELAS
// @match           https://lms2017.teikyo-u.ac.jp/*
// @match           https://vlib.ita.teikyo-u.ac.jp/Mediasite/*
// @match           https://telas.manjuu.net/*
// @icon            https://telas.manjuu.net/favicon.ico?v=cc9cf74
// @homepageURL     https://telas.manjuu.net
// @updateURL       https://telas.manjuu.net/teikyo-bb.user.js
// @downloadURL     https://telas.manjuu.net/teikyo-bb.user.js
// @grant           GM_xmlhttpRequest
// @grant           GM.xmlHttpRequest
// @connect         teikyo-u.ac.jp
// @connect         blackboard.com
// @connect         self
// @connect         telas.manjuu.net
// @inject-into     content
// @run-at          document-start
// @noframes
// ==/UserScript==
//
// ⚠ userscript/teikyo-bb.user.js 是用 build.mjs 从 src/ 生成的（入口 src/main.user.js + src/modules/*.js）。
//   改代码请改 src/ 下的源文件；直接改 userscript/teikyo-bb.user.js 的内容会在下次构建时被覆盖。

/*
 * 兼容性说明（同一份脚本跑在两类管理器上）：
 * - Tampermonkey / Violentmonkey 认 GM_* 和 GM.*；iOS/macOS Safari 的 Userscripts 只认 GM.*（且只在
 *   @inject-into content 下提供 GM API），所以两套 @grant 都写上，代码里两种都探测。@connect 只有
 *   Tampermonkey 用，其余管理器忽略。
 * - Userscripts 的 GM.xmlHttpRequest 由扩展后台发请求，是否带上 Blackboard 的登录 Cookie 取决于 Safari，
 *   拿不准：取回的若是登录页 HTML 就判失败，再退回同源 fetch；仍失败的文件在树里给「↗ 手动打开」链接。
 * - iOS Safari 连续触发多个下载体验很差（逐个弹确认、可能被拦），所以 iOS 上默认打包成一个 ZIP，
 *   打包完再让用户点一下「保存」（保存需要用户手势）。
 */

/*
 * 下载为什么要用 GM_xmlhttpRequest：/bbcswebdav/ 文件地址会 302 跳到另一个域
 *（alt-*.blackboard.com → *.files.blackboard.com 的签名地址），浏览器里普通 fetch 跨域被 CORS
 * 挡住、读不到内容（全部失败）；而且最终响应是 inline，普通 <a download> 跨域时会直接在浏览器里打开
 * 而不是下载。GM_xmlhttpRequest 不受 CORS 限制，取到 blob 再本地另存。
 */

(async function () {
  "use strict";

  // ---------------------------------------------------------------- 全局常量（必须最先 include）
  // TELAS 网站（GitHub Pages）上脚本只当「桥」：替网页向 LMS 发只读请求。此时 ORIGIN 指向 LMS。
  // 正式地址 telas.manjuu.net（Cloudflare Pages）；github.io 是备用地址
  const ON_SITE = location.hostname === "telas.manjuu.net" ||
    (location.hostname === "manjuu08.github.io" && location.pathname.startsWith("/telas-site/"));
  const LMS = "https://lms2017.teikyo-u.ac.jp";
  const ORIGIN = ON_SITE ? LMS : location.origin;
  const API = (p) => ORIGIN + p;
  const NAV_ID = "bbdl-nav";
  const PANEL_ID = "bbdl-panel";
  const LS_THEME = "bbdl.theme";
  const LS_TERM = "bbdl.term";
  const LS_LANG = "bbdl.lang";
  const LS_ZIP = "bbdl.zip";
  const LS_ARCHIVED = "bbdl.archived";
  // iPadOS 默认报桌面 UA（MacIntel），靠触点数区分
  const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  // ---------------------------------------------------------------- 多语言（默认日语）
  const T = {
    ja: {
      card_dl: "{0} の教材を一括ダウンロード", card_missing: "このコースは一覧にありません（アーカイブ済みなら「アーカイブ済みコースも表示」をオンに）",
      nav: "一括ダウンロード", title: "一括ダウンロード", sub_dl: "教材",
      theme: "テーマ", theme_light: "テーマ：ライト", theme_dark: "テーマ：ダーク",
      lang: "言語", close: "閉じる",
      pick: "学期とコースを選択", loading: "コースを読み込み中…",
      load_fail: "コースの読み込みに失敗：{0}（ログイン状態を確認）",
      count: "全 {0} コース", other: "その他",
      pick_course: "— コースを選択 —", scan: "スキャン", select_all: "すべて選択", download: "選択をダウンロード",
      scanning: "スキャン中…", found: "ファイル {0} 件", plus_videos: "（講義ビデオ {0} 件は🎬）",
      no_sel: "ファイルが選択されていません", downloading: "ダウンロード中 {0}/{1}：{2}",
      done: "完了：成功 {0}、失敗 {1}", done_err: "完了：成功 {0}、失敗 {1}（{2}）",
      vlink_title: "新しいタブで開く。ページ右下にダウンロードボタンが出ます",
      e_http: "HTTP {0}", e_net: "通信エラー", e_timeout: "タイムアウト", e_empty: "空のファイル",
      v_btn: "📥 ビデオをダウンロード (MP4)", v_tip: "ビデオをダウンロード (MP4)", v_resolving: "直リンク取得中…", v_started: "ダウンロード開始 ✓",
      v_fail: "失敗：{0}", v_no_mp4: "MP4 ストリームなし（HLS のみ、または権限なし）",
      v_not_play: "再生ページではありません", v_http: "GetPlayerOptions HTTP {0}",
      zip: "ZIP にまとめる", zipping: "ZIP 作成中…（{0} 件）", zip_save: "💾 ZIP を保存",
      zip_ready: "ZIP の準備完了：成功 {0}、失敗 {1}。「ZIP を保存」をタップ", zip_saved: "ZIP を保存しました：成功 {0}、失敗 {1}",
      e_login: "ログインページが返されました（Cookie が送られていない可能性）", manual: "新しいタブで開いて手動で保存", open_tab: "新しいタブで開く", copy_link: "リンクをコピー", link_copied: "リンクをコピーしました",

      site_upd: "TELAS を更新（telas.manjuu.net）",
      update_available: "新しいバージョン {0} があります（クリックで更新）",

      f_term: "学期", f_course: "コース",
      dl_sec_course: "コースを選択", dl_desc: "コースを選ぶと教材を自動でスキャンします。講義ビデオ🎬は新しいタブで開きます。", dl_sec_files: "ファイル", dl_empty: "コースを選ぶと、ここにファイルが表示されます",

      nw_show_archived: "アーカイブ済みコースも表示",
      nw_open: "LMS で開く",
      scan_cached: "キャッシュから表示（再スキャンで更新）",
    },
    en: {
      card_dl: "Bulk download materials of {0}", card_missing: "This course isn't in the list (if it is archived, turn on \"Include archived courses\")",
      nav: "Bulk Download", title: "Bulk Download", sub_dl: "Course materials",
      theme: "Theme", theme_light: "Theme: Light", theme_dark: "Theme: Dark",
      lang: "Language", close: "Close",
      pick: "Pick a term and course", loading: "Loading courses…",
      load_fail: "Failed to load courses: {0} (check you are logged in)",
      count: "{0} courses", other: "Other",
      pick_course: "— Select a course —", scan: "Scan", select_all: "Select all", download: "Download selected",
      scanning: "Scanning…", found: "{0} files", plus_videos: "({0} lecture videos, see 🎬)",
      no_sel: "No files selected", downloading: "Downloading {0}/{1}: {2}",
      done: "Done: {0} ok, {1} failed", done_err: "Done: {0} ok, {1} failed ({2})",
      vlink_title: "Opens in a new tab; a download button appears bottom-right",
      e_http: "HTTP {0}", e_net: "Network error", e_timeout: "Timeout", e_empty: "Empty file",
      v_btn: "📥 Download video (MP4)", v_tip: "Download video (MP4)", v_resolving: "Getting direct link…", v_started: "Download started ✓",
      v_fail: "Failed: {0}", v_no_mp4: "No MP4 stream (HLS only, or no access)",
      v_not_play: "Not a play page", v_http: "GetPlayerOptions HTTP {0}",
      zip: "Pack as ZIP", zipping: "Building ZIP… ({0} files)", zip_save: "💾 Save ZIP",
      zip_ready: "ZIP ready: {0} ok, {1} failed. Tap “Save ZIP”", zip_saved: "ZIP saved: {0} ok, {1} failed",
      e_login: "Got the login page instead (cookies may not have been sent)", manual: "Open in a new tab and save manually", open_tab: "Open in a new tab", copy_link: "Copy link", link_copied: "Link copied",

      site_upd: "Update TELAS (telas.manjuu.net)",
      update_available: "Version {0} is available (click to update)",

      f_term: "Term", f_course: "Course",
      dl_sec_course: "Choose a course", dl_desc: "Picking a course scans its materials automatically. Lecture videos 🎬 open in a new tab.", dl_sec_files: "Files", dl_empty: "Pick a course to list its files here",

      nw_show_archived: "Include archived courses",
      nw_open: "Open in LMS",
      scan_cached: "Showing cached scan (rescan to refresh)",
    },
    zh: {
      card_dl: "批量下载 {0} 的资料", card_missing: "列表里没有这门课程（如果已归档，请勾选「显示已归档课程」）",
      nav: "批量下载", title: "批量下载", sub_dl: "课程资料",
      theme: "主题", theme_light: "主题：浅色", theme_dark: "主题：深色",
      lang: "语言", close: "关闭",
      pick: "选择学期和课程", loading: "加载课程中…",
      load_fail: "加载课程失败：{0}（确认已登录）",
      count: "共 {0} 门课", other: "其他",
      pick_course: "— 选择课程 —", scan: "扫描", select_all: "全选", download: "下载选中",
      scanning: "扫描中…", found: "找到 {0} 个文件", plus_videos: "（另有 {0} 个讲义视频，见🎬）",
      no_sel: "没有选中任何文件", downloading: "下载中 {0}/{1}：{2}",
      done: "完成：成功 {0}，失败 {1}", done_err: "完成：成功 {0}，失败 {1}（{2}）",
      vlink_title: "在新标签打开视频；页面右下角会出现下载按钮",
      e_http: "HTTP {0}", e_net: "网络错误", e_timeout: "超时", e_empty: "空文件",
      v_btn: "📥 下载视频 (MP4)", v_tip: "下载视频 (MP4)", v_resolving: "获取直链中…", v_started: "已开始下载 ✓",
      v_fail: "失败：{0}", v_no_mp4: "没有 MP4 流（可能是仅 HLS 或无权限）",
      v_not_play: "不是播放页", v_http: "GetPlayerOptions HTTP {0}",
      zip: "打包成 ZIP", zipping: "正在打包 ZIP…（{0} 个）", zip_save: "💾 保存 ZIP",
      zip_ready: "ZIP 已就绪：成功 {0}，失败 {1}。点「保存 ZIP」", zip_saved: "ZIP 已保存：成功 {0}，失败 {1}",
      e_login: "返回的是登录页（可能没带上 Cookie）", manual: "在新标签打开，手动保存", open_tab: "在新标签打开", copy_link: "复制链接", link_copied: "已复制链接",

      site_upd: "更新 TELAS（telas.manjuu.net）",
      update_available: "有新版本 {0}（点击更新）",

      f_term: "学期", f_course: "课程",
      dl_sec_course: "选择课程", dl_desc: "选择课程后会自动扫描资料。讲义视频🎬在新标签页打开。", dl_sec_files: "文件", dl_empty: "选择课程后，文件会列在这里",

      nw_show_archived: "显示已归档课程",
      nw_open: "在 LMS 打开",
      scan_cached: "显示缓存（重新扫描可更新）",
    },
  };
  let lang = "ja";

  // ---------------------------------------------------------------- 工具
  const esc = (s) => (s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const t = (k, ...a) => {
    let s = (T[lang] && T[lang][k]) != null ? T[lang][k] : (T.ja[k] != null ? T.ja[k] : k);
    a.forEach((v, i) => (s = s.replace("{" + i + "}", v)));
    return s;
  };
  // 「.」「..」だけの名前はパスの上の階層を指すので _ に（LMS のフォルダ名がそのままパス・ZIP の中の名前になる）
  const sanitize = (s) => (s || "").replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim().replace(/^\.+$/, "_");
  const fmtSize = (n) => {
    n = Number(n);
    if (!isFinite(n) || n <= 0) return "";
    const u = ["B", "KB", "MB", "GB"];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i ? n.toFixed(1) : String(n)) + " " + u[i];
  };
  const store = {
    get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch (e) { return d; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} },
  };
  lang = store.get(LS_LANG, "ja"); // 默认日语
  if (!T[lang]) lang = "ja";
  // 语言是全局的：下载面板、答题面板和自动登录设置共用一个 bbdl.lang，任一处切换都广播给所有已打开的界面
  const langHooks = new Set();
  function setLang(l) {
    lang = T[l] ? l : "ja";
    store.set(LS_LANG, lang);
    langHooks.forEach((f) => { try { f(); } catch (e) { console.warn(e); } });
  }

  // ---- 学期识别 ----
  const TERM_RE = /(20\d{2})\s*(?:年度|年)?\s*(前期|後期|后期|通年|集中|春学期|秋学期|春|秋)/;
  const NORMALIZE = { "后期": "後期", "春学期": "前期", "春": "前期", "秋学期": "後期", "秋": "後期" };
  const TERM_ORDER = { "後期": 0, "集中": 1, "前期": 2, "通年": 3 };
  function termOf(name) {
    const m = TERM_RE.exec(name || "");
    if (!m) return ["", (name || "").trim()];
    const season = NORMALIZE[m[2]] || m[2];
    const rest = (name.slice(0, m.index) + name.slice(m.index + m[0].length))
      .replace(/^[\s　\-_・:：/]+|[\s　\-_・:：/]+$/g, "");
    return [m[1] + season, rest || name.trim()];
  }
  function sortKey(t) {
    const m = /^(\d{4})(.*)$/.exec(t || "");
    if (!m) return [9999, 9, String(t || "")]; // 「every year」など年が取れない学期は末尾へ
    return [-parseInt(m[1], 10), TERM_ORDER[m[2]] ?? 9, m[2]];
  }
  function groupCourses(courses) {
    const groups = {};
    for (const c of courses) {
      // 学期は API の course.term.name を優先。無い場合だけ従来どおりコース名から推定する。
      const [reTerm, short] = termOf(c.name);
      const term = c.term || reTerm;
      (groups[term] = groups[term] || []).push({ id: c.id, name: c.name, short });
    }
    let terms = Object.keys(groups).filter((t) => t !== "");
    terms.sort((a, b) => {
      const ka = sortKey(a), kb = sortKey(b);
      return ka[0] - kb[0] || ka[1] - kb[1] || String(ka[2]).localeCompare(kb[2]);
    });
    if ("" in groups) terms.push("");
    for (const t of terms) groups[t].sort((a, b) => a.short.localeCompare(b.short, "ja"));
    return terms.map((t) => [t, groups[t]]);
  }

  // ---------------------------------------------------------------- 数据层
  async function getJSON(url) {
    if (ON_SITE) return gmJSON(url);
    const r = await fetch(url, { credentials: "include", headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }

  function extractFiles(html) {
    const out = [];
    if (!html) return out;
    const doc = new DOMParser().parseFromString(html, "text/html");
    for (const a of doc.querySelectorAll('a[href*="/bbcswebdav/"]')) {
      const href = a.getAttribute("href") || "";
      if (!href) continue;
      let name = "";
      const bbfile = a.getAttribute("data-bbfile");
      if (bbfile) {
        try {
          const info = JSON.parse(bbfile);
          name = info.fileName || info.linkName || info.displayName || "";
        } catch (e) {}
      }
      if (!name) name = (a.textContent || "").trim();
      if (name && name.includes(".")) out.push({ type: "file", name, url: href.replace(ORIGIN, "") });
    }
    return out;
  }

  // 判断 BLTI 条目是不是 Mediasite 讲义视频。只看 customParams.presentationId 不够：
  // 别的 LTI 工具也可能带同名字段，会误报成「講義ビデオ」。所以三个信号里至少认一个：
  //   1) linkRef / handler 指向 Mediasite 的 Building Block（scsk-BbMediaSiteLink）；
  //   2) 工具地址或 toolId 里出现 mediasite / vlib；
  //   3) presentationId 配合 linkRef 里的 forward.jsp?conType=Presentation。
  // 只认得出明确是 Mediasite 的才算视频，认不出的当普通内容忽略。
  function isMediasiteVideo(blti, item) {
    if (!blti) return false;
    const cp = blti.customParams || {};
    if (!cp.presentationId) return false;
    const linkRef = String((item && item.linkRef) || "");
    const toolRef = String(
      blti.launchUrl || blti.url || blti.toolUrl || blti.tool_id || blti.toolId ||
      blti.providerId || blti.providerUrl || ""
    );
    const hay = `${linkRef} ${toolRef} ${JSON.stringify(blti.customParams || {})}`;
    if (/mediasite|vlib\.ita|BbMediaSiteLink/i.test(hay)) return true;
    // linkRef 明确指向 Mediasite 的旧式 Building Block：forward.jsp?conType=Presentation
    if (/forward\.jsp/i.test(linkRef) && /conType=Presentation/i.test(linkRef)) return true;
    return false;
  }

  // 返回嵌套节点：
  //   {type:'folder',name,children} / {type:'file',name,url,folder,size,mime}
  //   {type:'video',name,launch,folder} / {type:'link',name,url,folder}
  // 内容の「説明」（description。例：フォルダの「10月22日（木）より公開予定です。」）。HTML が入っていても文字だけにする
  function descOf(item) {
    const raw = String((item && item.description) || "");
    if (!raw.trim()) return "";
    const txt = /[<&]/.test(raw)
      ? (new DOMParser().parseFromString(raw.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li)>/gi, "\n"), "text/html").body.textContent || "")
      : raw;
    return txt.replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
  }
  async function scanTree(cid, contentId, folderPath, log) {
    const nodes = [];
    const seen = new Set(); // 同一层里正文链接和附件可能指向同一个文件
    let data;
    try {
      data = await getJSON(API(`/learn/api/v1/courses/${cid}/contents/${contentId}/children?@view=Summary&limit=1000`));
    } catch (e) {
      return nodes;
    }
    const addFile = (file, folder, desc) => {
      if (!file || !file.fileName) return;
      const url = String(file.permanentUrl || "").replace(ORIGIN, "");
      if (!url || seen.has(url)) return;
      seen.add(url);
      nodes.push({ type: "file", name: file.fileName, url, folder, size: file.fileSize, mime: file.mimeType, desc: desc || "" });
    };
    for (const item of data.results || []) {
      const title = item.title || "";
      const desc = descOf(item);
      const detail = item.contentDetail || {};
      const handler = item.contentHandler || "";
      const has = (k) => k in detail || handler === k;

      if (has("resource/x-bb-file")) {
        addFile((detail["resource/x-bb-file"] || {}).file, folderPath, desc);
      } else if (has("resource/x-bb-folder") || has("resource/x-bb-lesson")) {
        // lesson（章节）也当文件夹递归
        log(`📁 ${folderPath}${title}`);
        const children = await scanTree(cid, item.id, folderPath + sanitize(title) + " / ", log);
        // 中身が無くても説明があるフォルダは出す（「○月○日より公開予定」のようなお知らせが分かるように）
        if (children.length || desc) nodes.push({ type: "folder", name: title, children, desc });
      } else if (has("resource/x-bb-document")) {
        // 文档的附件（attachments[].file）和正文里的 /bbcswebdav/ 链接都要收
        const doc = detail["resource/x-bb-document"] || {};
        for (const at of (doc.attachments || [])) addFile((at || {}).file, folderPath, desc);
        for (const f of extractFiles((item.body || {}).rawText || "")) {
          if (seen.has(f.url)) continue;
          seen.add(f.url);
          nodes.push({ ...f, folder: folderPath });
        }
      } else if (has("resource/x-bb-asmt-test-link")) {
        const asmt = (((detail["resource/x-bb-asmt-test-link"] || {}).test || {}).assessment || {});
        for (const f of extractFiles((asmt.instructions || {}).rawText || "")) {
          if (seen.has(f.url)) continue;
          seen.add(f.url);
          nodes.push({ ...f, folder: folderPath });
        }
      } else if (has("resource/x-bb-blti-link")) {
        const blti = detail["resource/x-bb-blti-link"] || {};
        if (isMediasiteVideo(blti, item)) {
          nodes.push({ type: "video", name: sanitize(title) + ".mp4", folder: folderPath, desc,
            launch: `/webapps/blackboard/execute/blti/launchLink?course_id=${cid}&content_id=${item.id}` });
        } else {
          // Mediasite 以外の LTI ツールはリンクとして残す
          const url = blti.launchLink || blti.launchUrl || "";
          if (url) nodes.push({ type: "link", name: title || t("nw_open"), url, folder: folderPath, desc });
        }
      } else if (has("resource/x-bb-externallink")) {
        const ext = detail["resource/x-bb-externallink"] || {};
        const url = ext.url || ext.href || "";
        if (url) nodes.push({ type: "link", name: title || url, url, folder: folderPath, desc });
      }
    }
    return nodes;
  }

  async function getCourses() {
    const me = await getJSON(API("/learn/api/v1/users/me"));
    const data = await getJSON(
      API(`/learn/api/v1/users/${me.id}/memberships?expand=course.effectiveAvailability,course.term,courseRole&includeCount=true&limit=10000`)
    );
    const showArchived = store.get(LS_ARCHIVED, "0") === "1";
    const courses = [];
    for (const m of data.results || []) {
      const c = m.course || {};
      if (!c.id || !c.name) continue;
      // effectiveAvailability=false はアーカイブ/受講不可。既定ではノイズなので隠す（設定で表示可）
      if (!showArchived && c.effectiveAvailability === false) continue;
      courses.push({
        id: c.id,
        name: c.name,
        term: (c.term && c.term.name) || "",
        available: c.effectiveAvailability !== false,
      });
    }
    return courses;
  }

  // GM 跨域请求：Tampermonkey/Violentmonkey 有 GM_xmlhttpRequest，Userscripts(Safari) 只有 GM.xmlHttpRequest
  function gmXhr() {
    if (typeof GM_xmlhttpRequest === "function") return GM_xmlhttpRequest;
    if (typeof GM !== "undefined" && GM && typeof GM.xmlHttpRequest === "function") return GM.xmlHttpRequest;
    return null;
  }
  // 各管理器回传的 response 形态不一（Blob / ArrayBuffer / 字节数组），统一成 Blob；跨 realm 时 instanceof 不可靠，按形状判断
  function toBlob(r) {
    if (!r) return null;
    if (typeof r.arrayBuffer === "function" && typeof r.size === "number") return r;
    if (r.byteLength != null) return new Blob([r]);
    if (Array.isArray(r)) return new Blob([new Uint8Array(r)]);
    return null;
  }
  function gmGet(gm, url) {
    return new Promise((resolve, reject) => {
      const ret = gm({
        method: "GET",
        url,
        responseType: "blob",
        anonymous: false, // 带上浏览器的 cookie（Tampermonkey 认；Userscripts 忽略）
        onload: (res) => {
          const blob = toBlob(res.response);
          (res.status >= 200 && res.status < 300 && blob) ? resolve(blob) : reject(new Error(t("e_http", res.status)));
        },
        onerror: () => reject(new Error(t("e_net"))),
        ontimeout: () => reject(new Error(t("e_timeout"))),
      });
      // Userscripts 的 GM.xmlHttpRequest 还会返回 Promise，失败已由回调处理，这里吞掉免得报未处理的 rejection
      if (ret && typeof ret.catch === "function") ret.catch(() => {});
    });
  }
  // 没带上登录 Cookie 时服务器会 200 返回登录页 HTML，不能当成文件存下来
  async function checkBlob(blob, name) {
    if (!blob || !blob.size) throw new Error(t("e_empty"));
    if (!/\.html?$/i.test(name || "")) {
      const head = await blob.slice(0, 1024).text().catch(() => "");
      if (/^\s*(<!doctype html|<html)/i.test(head)) throw new Error(t("e_login"));
    }
    return blob;
  }
  // 先走 GM 请求（不受 CORS 限制，能跟随跨域跳转），失败再退回同源 fetch；都失败报第一个错误
  async function fetchBlob(url, name) {
    const errs = [];
    const gm = gmXhr();
    if (gm) {
      try { return await checkBlob(await gmGet(gm, url), name); } catch (e) { errs.push(e); }
    }
    try {
      const r = await fetch(url, { credentials: "include" });
      if (!r.ok) throw new Error(t("e_http", r.status));
      return await checkBlob(await r.blob(), name);
    } catch (e) { errs.push(e); }
    throw errs[0];
  }

  const absUrl = (u) => (u.startsWith("http") ? u : ORIGIN + u);

  function saveBlob(blob, fname) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = fname;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    // iOS 的下载确认框可能停留较久，晚一点再回收
    setTimeout(() => URL.revokeObjectURL(a.href), 120000);
  }

  async function downloadOne(f) {
    const blob = await fetchBlob(absUrl(f.url), f.name);
    // 只用原文件名，不加文件夹前缀；重名时浏览器会自动在后面加 (1)
    saveBlob(blob, sanitize(f.name));
  }

  // ---- 极简 ZIP 打包（仅 store、不压缩；文件名 UTF-8 标志位，日文名在 Windows/macOS/iOS 都不乱码）----
  const CRC_TABLE = (() => {
    const tb = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      tb[n] = c >>> 0;
    }
    return tb;
  })();
  function crc32(u8) {
    let c = 0xffffffff;
    for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  // entries: [{ path: "文件夹/子文件夹/文件名.pdf", blob }]
  async function buildZip(entries) {
    const enc = new TextEncoder();
    const d = new Date();
    const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const body = [], central = [];
    let offset = 0;
    for (const { path, blob } of entries) {
      const name = enc.encode(path);
      const crc = crc32(new Uint8Array(await blob.arrayBuffer())); // 只为算 CRC，内容本身仍用 blob 拼接，省内存
      const size = blob.size;
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
      lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true);
      lh.setUint32(14, crc, true); lh.setUint32(18, size, true); lh.setUint32(22, size, true);
      lh.setUint16(26, name.length, true);
      body.push(lh, name, blob);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
      ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true);
      ch.setUint32(16, crc, true); ch.setUint32(20, size, true); ch.setUint32(24, size, true);
      ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
      central.push(ch, name);
      offset += 30 + name.length + size;
    }
    const cdSize = central.reduce((n, p) => n + p.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    return new Blob([...body, ...central, end], { type: "application/zip" });
  }
  // ZIP 内结构：<课程名>/<Blackboard 里的文件夹路径>/<文件名>。
  // scanTree 已经把路径记在 f.folder（形如「授業資料 / 第1回 / 」）里，这里保留下来，
  // 同一路径下重名时加 (2)、(3)…
  function zipPath(f, used, dir) {
    const base = sanitize(f.name) || "file";
    const sub = String(f.folder || "").split("/").map((s) => sanitize(s)).filter(Boolean).join("/");
    const d = [dir, sub].filter(Boolean).join("/");
    let p = (d ? d + "/" : "") + base, n = 1;
    while (used.has(p.toLowerCase())) {
      n++;
      const m = /^(.*?)(\.[^.\/]*)?$/.exec(base);
      p = (d ? d + "/" : "") + m[1] + ` (${n})` + (m[2] || "");
    }
    used.add(p.toLowerCase());
    return p;
  }
  // 右上角「更新」按钮：两段弧形箭头绕成一圈
  const SYNC_ICON =
    '<svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">' +
    '<path d="M5.94 15.5A7 7 0 0 1 13.81 5.24M18.06 8.5A7 7 0 0 1 10.19 18.76" fill="none" stroke="currentColor" stroke-width="3.4"/>' +
    '<path fill="currentColor" d="M13.04 8.14 14.59 2.34 18.6 6.53zM10.96 15.86 9.41 21.66 5.4 17.47z"/></svg>';
  // ---------------------------------------------------------------- 下载面板
  const DL_ICON =
    '<svg viewBox="0 0 16 16" width="16" height="16" focusable="false" aria-hidden="true">' +
    '<path fill="currentColor" d="M8 1a1 1 0 0 1 1 1v6.586l1.293-1.293a1 1 0 1 1 1.414 1.414l-3 3a1 1 0 0 1-1.414 0l-3-3a1 1 0 1 1 1.414-1.414L7 8.586V2a1 1 0 0 1 1-1z"/>' +
    '<path fill="currentColor" d="M2 11a1 1 0 0 1 1 1v1h10v-1a1 1 0 1 1 2 0v2a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1v-2a1 1 0 0 1 1-1z"/></svg>';

  const P = `#${PANEL_ID}`;
  const el = (tag, attrs = {}, html) => {
    const n = document.createElement(tag);
    Object.assign(n, attrs);
    if (html != null) n.innerHTML = html;
    return n;
  };

  // ---------------------------------------------------------------- 面板外壳（照 Blackboard Ultra 原生 peek 面板）
  // 所有面板共用同一套外壳和控件样式，只注入一次。
  // 照「プロフィール › 通知設定」面板：白底标题区（小字上标 + 细体大标题）、
  // 关闭钮是伸出面板左缘 30px 的蓝色方块（下面带折角）、页面整体变暗、页脚两颗等宽按钮。
  // 手机/窄屏（≤640px）整屏接管，关闭钮收回到标题区右上角。
  const ARROW = (c) => `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' fill='none' stroke='${c}' stroke-width='1.6'/%3E%3C/svg%3E")`;
  const SHELL_CSS = `
    .bbtool-shell{
      --bg:#fff; --fg:#262626; --muted:#666; --line:#dcdcdc; --rule:#4a4a4a; --ctl:#767676;
      --acc:#3b4fa8; --acc-deep:#26336f; --link:#3b4fa8; --check:#1d8a3c; --danger:#c8102e;
      --btn:#262626; --btn-fg:#fff; --btn2:#e3e3e3; --btn2-fg:#262626; --ok:#1d7a34;
      --arrow:${ARROW("%23262626")};
      --h:44px; --w:560px; --pad:38px;
      --font:"Noto Sans JP","Hiragino Kaku Gothic ProN","Hiragino Sans","Yu Gothic UI",Meiryo,"Microsoft YaHei",system-ui,sans-serif;
    }
    .bbtool-shell[data-theme="dark"]{
      --bg:#1e1f23; --fg:#ececec; --muted:#a6a6a6; --line:#393a40; --rule:#76777d; --ctl:#8a8b90;
      --link:#a9b8f2; --check:#3fbf63; --danger:#ff6b6b; --ok:#5fd07c;
      --btn:#ececec; --btn-fg:#1e1f23; --btn2:#393a40; --btn2-fg:#ececec;
      --arrow:${ARROW("%23ececec")};
    }
    .bbtool-shell, .bbtool-shell *{box-sizing:border-box!important}
    .bbtool-shell{position:fixed!important; top:0; right:0; bottom:0; left:auto; z-index:2147483000;
      width:min(var(--w), calc(100vw - 40px)); display:none; flex-direction:column;
      background:var(--bg); color:var(--fg); box-shadow:-8px 0 28px rgba(0,0,0,.28);
      font:15px/1.6 var(--font); text-align:left; letter-spacing:.01em; margin:0; transform:none}
    .bbtool-shell.open{display:flex; animation:bbtool-in .22s cubic-bezier(.2,.7,.2,1)}
    @keyframes bbtool-in{from{transform:translateX(32px); opacity:0} to{transform:none; opacity:1}}
    @media (prefers-reduced-motion:reduce){.bbtool-shell.open{animation:none}}
    .bbtool-overlay{position:fixed!important; inset:0; z-index:2147482999; background:rgba(0,0,0,.55); display:none}
    .bbtool-overlay.show{display:block}

    /* 关闭钮：伸出左缘的蓝色方块 + 折角 */
    .bbtool-shell .bbtool-close{position:absolute!important; left:-30px; top:38px; z-index:2;
      width:50px!important; height:50px!important; margin:0!important; padding:0!important; border:0!important; border-radius:0!important;
      background:var(--acc)!important; color:#fff!important; cursor:pointer; display:flex!important; align-items:center; justify-content:center;
      box-shadow:none!important}
    .bbtool-shell .bbtool-close::after{content:""; position:absolute; left:0; top:100%; width:0; height:0;
      border-top:14px solid var(--acc-deep); border-left:30px solid transparent}
    .bbtool-shell .bbtool-close:hover{background:#4b5fba!important}
    .bbtool-shell .bbtool-close svg{width:24px; height:24px; display:block}

    .bbtool-shell .bbtool-header{flex:0 0 auto; display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:center; gap:0 16px;
      padding:28px var(--pad) 22px; border-bottom:1px solid var(--line)}
    .bbtool-shell .bbtool-headtext{display:contents}
    .bbtool-shell .bbtool-sub{grid-column:1; grid-row:1; margin:0; font-size:14px; line-height:1.4; color:var(--fg)}
    .bbtool-shell .bbtool-header h1{grid-column:1 / -1; grid-row:2; margin:6px 0 0!important; padding:0!important; font:300 30px/1.25 var(--font)!important;
      color:var(--fg)!important; letter-spacing:.02em; border:0!important; white-space:nowrap; overflow:hidden; text-overflow:ellipsis}
    .bbtool-shell .bbtool-headtools{grid-column:2; grid-row:1; display:flex; align-items:center; gap:6px}
    .bbtool-shell .bbtool-headtools select.bbtool-theme{width:136px!important} /* 选项文字随语言变长短，固定宽度免得整排跟着动 */
    .bbtool-shell .bbtool-headtools select{height:30px!important; min-height:30px!important; width:auto!important;
      padding:0 26px 0 8px!important; font-size:12px!important; background-position:right 8px center!important}
    .bbtool-shell .bbtool-gh{flex:0 0 auto; display:inline-flex; align-items:center; justify-content:center; width:30px; height:30px; position:relative;
      color:var(--fg)!important; opacity:.7; text-decoration:none!important; border-radius:50%}
    .bbtool-shell .bbtool-gh:hover, .bbtool-shell .bbtool-gh:focus-visible{opacity:1}
    .bbtool-shell .bbtool-gh svg{width:20px; height:20px; display:block}

    .bbtool-shell .bbtool-body{flex:1 1 auto; min-height:0; overflow:auto; padding:26px var(--pad) 32px; overscroll-behavior:contain}
    .bbtool-shell .bbtool-footer{flex:0 0 auto; display:flex; flex-direction:column; gap:10px;
      padding:12px var(--pad) 18px; border-top:1px solid var(--line); background:var(--bg)}
    .bbtool-shell .bbtool-status{min-height:20px; font-size:13px; line-height:20px; color:var(--muted);
      white-space:nowrap; overflow:hidden; text-overflow:ellipsis}
    .bbtool-shell .bbtool-actions{display:grid; grid-auto-flow:column; grid-auto-columns:minmax(0,1fr); gap:10px}
    .bbtool-shell .bbtool-actions .btn{height:46px!important; min-height:46px!important; width:100%}

    /* 分区：粗标题 + 说明 + 细分隔线（同「ストリーム通知」） */
    .bbtool-shell .sec{margin:0 0 24px; padding:0 0 24px; border-bottom:1px solid var(--line)}
    .bbtool-shell .sec:last-child{margin-bottom:0; padding-bottom:0; border-bottom:0}
    .bbtool-shell .sec > h2{margin:0 0 4px!important; padding:0!important; font:700 18px/1.4 var(--font)!important; color:var(--fg)!important; border:0!important}
    .bbtool-shell .desc{margin:0 0 22px; font-size:13px; line-height:1.6; color:var(--muted)}
    .bbtool-shell .sec > h2 + .row{margin-top:22px} /* 给压在边框上的小标签留出位置 */
    .bbtool-shell .row{display:flex; flex-wrap:wrap; gap:10px; align-items:center; margin:0 0 18px}
    .bbtool-shell .row:last-child{margin-bottom:0}

    /* 描边输入框 + 压在边框上的小标签（同课程页「学期」「フィルタ」） */
    .bbtool-shell .fld{position:relative; flex:1 1 200px; min-width:0; margin:0}
    .bbtool-shell .fld > span{position:absolute; top:-9px; left:9px; z-index:1; padding:0 4px; background:var(--bg);
      font-size:12px; line-height:16px; color:var(--fg); pointer-events:none; white-space:nowrap}
    .bbtool-shell select, .bbtool-shell input[type=text], .bbtool-shell input[type=password],
    .bbtool-shell input[type=number], .bbtool-shell input[type=url], .bbtool-shell textarea{
      width:100%!important; margin:0!important; font:inherit!important; font-size:14px!important; color:var(--fg)!important;
      background-color:var(--bg)!important; border:1px solid var(--ctl)!important; border-radius:2px!important;
      box-shadow:none!important; outline:none; -webkit-appearance:none; appearance:none}
    .bbtool-shell select, .bbtool-shell input[type=text], .bbtool-shell input[type=password],
    .bbtool-shell input[type=number], .bbtool-shell input[type=url]{height:var(--h)!important; min-height:var(--h)!important;
      padding:0 12px!important; line-height:normal!important}
    .bbtool-shell select{padding-right:34px!important; cursor:pointer;
      background-image:var(--arrow)!important; background-repeat:no-repeat!important; background-position:right 12px center!important}
    .bbtool-shell textarea{min-height:150px; padding:10px 12px!important; font-size:13px!important; line-height:1.65!important; resize:vertical}
    .bbtool-shell select:hover, .bbtool-shell input:hover, .bbtool-shell textarea:hover{border-color:var(--fg)!important}
    .bbtool-shell select:focus-visible, .bbtool-shell input:focus-visible, .bbtool-shell textarea:focus-visible,
    .bbtool-shell .btn:focus-visible, .bbtool-shell .bbtool-close:focus-visible{outline:2px solid var(--acc)!important; outline-offset:2px}
    .bbtool-shell[data-theme="dark"] select:focus-visible, .bbtool-shell[data-theme="dark"] input:focus-visible,
    .bbtool-shell[data-theme="dark"] textarea:focus-visible, .bbtool-shell[data-theme="dark"] .btn:focus-visible{outline-color:var(--link)!important}

    /* 按钮：主按钮深色实心，次按钮浅灰（同原生「保存」「キャンセル」） */
    .bbtool-shell .btn{flex:0 0 auto; display:inline-flex!important; align-items:center; justify-content:center;
      height:var(--h)!important; min-height:var(--h)!important; margin:0!important; padding:0 18px!important;
      font:500 14px/1 var(--font)!important; white-space:nowrap; text-transform:none; letter-spacing:.02em;
      border:1px solid var(--btn)!important; border-radius:2px!important; background:var(--btn)!important; color:var(--btn-fg)!important;
      box-shadow:none!important; cursor:pointer}
    .bbtool-shell .btn:hover{filter:brightness(1.18)}
    .bbtool-shell[data-theme="dark"] .btn:hover{filter:brightness(.9)}
    .bbtool-shell .btn.sec{background:var(--btn2)!important; border-color:var(--btn2)!important; color:var(--btn2-fg)!important}
    .bbtool-shell .btn.line{background:transparent!important; border-color:var(--ctl)!important; color:var(--fg)!important}
    .bbtool-shell .btn.danger{background:transparent!important; border-color:var(--danger)!important; color:var(--danger)!important}
    .bbtool-shell .btn:disabled{opacity:.45; cursor:default; filter:none}

    /* 复选框：原生绿色勾选 */
    .bbtool-shell label{display:inline-flex!important; align-items:center; gap:10px; margin:0!important; padding:0!important;
      cursor:pointer; color:var(--fg)!important; font-weight:500}
    .bbtool-shell input[type=checkbox]{appearance:auto!important; -webkit-appearance:checkbox!important; position:static!important;
      opacity:1!important; visibility:visible!important; clip:auto!important; display:inline-block!important; transform:none!important;
      width:18px!important; height:18px!important; min-width:18px!important; margin:0!important; padding:0!important;
      flex:0 0 auto; accent-color:var(--check); pointer-events:auto!important; cursor:pointer}
    .bbtool-shell a{color:var(--link)!important}
    .bbtool-shell .muted{color:var(--muted)}

    /* 手机/窄屏：照原生手机版（深色顶栏 + 左上角 × + 居中标题；分区标题下灰线；灰底页脚一颗整宽主按钮） */
    @media (max-width:640px){
      .bbtool-shell{--pad:20px; --foot:#f4f4f4; width:100vw; box-shadow:none}
      .bbtool-shell[data-theme="dark"]{--foot:#26272c}
      .bbtool-shell.open{animation-name:bbtool-up}
      .bbtool-shell .bbtool-close{left:6px; right:auto; top:calc(env(safe-area-inset-top) + 6px); width:48px!important; height:48px!important;
        background:transparent!important; color:#fff!important}
      .bbtool-shell .bbtool-close:hover{background:rgba(255,255,255,.12)!important}
      .bbtool-shell .bbtool-close::after{display:none}
      .bbtool-shell .bbtool-close svg{width:26px; height:26px}
      .bbtool-shell .bbtool-close:focus-visible{outline-color:#fff!important; outline-offset:-4px}
      .bbtool-shell .bbtool-header{display:flex; flex-wrap:wrap; padding:0; gap:0; border-bottom:1px solid var(--line)}
      .bbtool-shell .bbtool-headtext{flex:1 1 100%; display:flex; align-items:center; justify-content:center;
        min-height:calc(60px + env(safe-area-inset-top)); padding:env(safe-area-inset-top) 64px 0; background:#262626}
      .bbtool-shell .bbtool-sub{display:none}
      .bbtool-shell .bbtool-header h1{margin:0!important; font:700 18px/1.3 var(--font)!important; color:#fff!important; text-align:center}
      .bbtool-shell .bbtool-headtools{flex:1 1 100%; justify-content:flex-end; margin:0; padding:10px var(--pad)}
      .bbtool-shell .bbtool-body{padding:24px var(--pad) 32px}
      .bbtool-shell .sec{border-bottom:0; margin-bottom:12px}
      .bbtool-shell .sec > h2{font-size:20px!important; padding:0 0 18px!important; margin:0 0 20px!important;
        border-bottom:1px solid var(--line)!important}
      .bbtool-shell .sec > h2 + .row{margin-top:30px}
      .bbtool-shell .bbtool-footer{background:var(--foot); padding:16px 32px max(20px, env(safe-area-inset-bottom))}
      .bbtool-shell .bbtool-status:empty{display:none}
      .bbtool-shell .bbtool-actions .m-hide{display:none!important}
      .bbtool-shell .bbtool-actions .btn{height:48px!important; min-height:48px!important}
      .bbtool-shell .row > .btn{flex:1 1 auto}
      .bbtool-shell .row:not(:has(.fld)) > .btn{flex:1 1 0; min-width:0}
    }
    @keyframes bbtool-up{from{transform:translateY(24px); opacity:0} to{transform:none; opacity:1}}
    @media (pointer:coarse){
      .bbtool-shell{--h:46px}
      .bbtool-shell select, .bbtool-shell input:not([type=checkbox]):not([type=radio]), .bbtool-shell textarea{font-size:16px!important}
      .bbtool-shell input[type=checkbox]{width:22px!important; height:22px!important; min-width:22px!important}
    }
  `;

  // 文件树（行间细线，文件夹缩进）：下载面板的文件、答题面板的课件共用；其余是下载面板专用
  const dlStyle = `
    .bbtool-shell .tree-head{display:flex; flex-wrap:wrap; align-items:center; gap:10px 16px; padding:0 0 12px; border-bottom:1px solid var(--rule)}
    .bbtool-shell .tree-head label:last-child{margin-left:auto!important}
    .bbtool-shell .tree-head label > span{white-space:nowrap}
    .bbtool-shell ul.tree, .bbtool-shell ul.tree ul{list-style:none!important; margin:0!important; padding:0!important; text-indent:0!important}
    .bbtool-shell ul.tree ul{padding-left:28px!important}
    .bbtool-shell ul.tree li{margin:0!important; padding:0!important; border-top:1px solid var(--line)}
    .bbtool-shell ul.tree > li:first-child{border-top:0}
    .bbtool-shell ul.tree li::before, .bbtool-shell ul.tree li::marker{content:none!important}
    .bbtool-shell ul.tree .item{display:flex; align-items:center; gap:6px; min-height:44px; padding:6px 0}
    .bbtool-shell ul.tree .item > label{flex:1 1 auto; min-width:0; font-weight:400}
    .bbtool-shell ul.tree .item > label > span{overflow:hidden; display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2;
      line-clamp:2; white-space:normal; overflow-wrap:anywhere}
    .bbtool-shell ul.tree .dir > label{font-weight:700}
    .bbtool-shell ul.tree .vid, .bbtool-shell ul.tree .lnk{padding-left:28px}
    .bbtool-shell ul.tree .bbdl-desc{margin:-4px 0 8px 28px; font-size:12px; line-height:1.6; color:var(--muted); white-space:pre-wrap; overflow-wrap:anywhere}
    .bbtool-shell ul.tree details.bbdl-desc summary{cursor:pointer; list-style:none}
    .bbtool-shell ul.tree details.bbdl-desc summary::-webkit-details-marker{display:none}
    .bbtool-shell ul.tree details.bbdl-desc summary::before{content:"▸ "}
    .bbtool-shell ul.tree details.bbdl-desc[open] summary{font-size:0} /* 開いたら先頭の要約は隠し、▾ だけ残す（押すと閉じる） */
    .bbtool-shell ul.tree details.bbdl-desc[open] summary::before{content:"▾"; font-size:12px}
    ${P} .bbdl-open, ${P} .bbdl-manual{flex:0 0 auto; text-decoration:none; padding:4px 6px; font-size:14px}
    ${P} .bbdl-open{opacity:.5; display:inline-flex; color:var(--fg)}
    ${P} .bbdl-open:hover, ${P} .bbdl-open:focus-visible{opacity:1}
    ${P} .bbdl-open svg{width:16px; height:16px; display:block}
    ${P} .bbdl-menu{position:absolute; z-index:10; min-width:140px; padding:4px 0; margin:0; list-style:none;
      background:var(--bg); color:var(--fg); border:1px solid var(--line); border-radius:6px; box-shadow:0 4px 16px rgba(0,0,0,.2)}
    ${P} .bbdl-menu button{display:block; width:100%; padding:8px 14px; border:0; background:none; color:inherit;
      font:inherit; font-size:14px; text-align:left; cursor:pointer}
    ${P} .bbdl-menu button:hover, ${P} .bbdl-menu button:focus-visible{background:var(--line)}
    ${P} .empty{padding:28px 0; color:var(--muted); font-size:13px; text-align:center}
  `;

  let stylesInjected = false;
  function ensureStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    document.head.appendChild(el("style", { id: "bbtool-style" }, SHELL_CSS + dlStyle));
  }

  // 主题存在 bbdl.theme。默认浅色，和 LMS 本身一致。
  function curTheme() {
    const v = store.get(LS_THEME, "light");
    return v === "dark" ? "dark" : "light";
  }
  function setTheme(m) {
    m = m === "dark" ? "dark" : "light";
    store.set(LS_THEME, m);
    document.querySelectorAll(".bbtool-shell").forEach((p) => { p.dataset.theme = m; });
    document.querySelectorAll(".bbtool-shell .bbtool-theme").forEach((s) => { s.value = m; });
  }

  const CLOSE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M5 5l14 14M19 5L5 19" stroke="currentColor" stroke-width="2" stroke-linecap="square" fill="none"/></svg>';

  // footerHtml 里：.bbtool-status 放状态文字，.bbtool-actions 放按钮；带 .bbtool-dismiss 的按钮关闭面板。
  // 标题区右上角统一放 语言 / 主题 两个下拉框，由这里接线，各面板不用再各写一遍。
  function mountShell(panel, { sub, titleId, closeId, bodyHtml, footerHtml, onClose }) {
    ensureStyles();
    panel.className = "bbtool-shell";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", titleId);
    panel.dataset.theme = curTheme();
    panel.innerHTML = `
      <button class="bbtool-close" id="${closeId}" type="button">${CLOSE_SVG}</button>
      <div class="bbtool-header">
        <div class="bbtool-headtext">
          <p class="bbtool-sub" id="${sub.id}"></p>
          <h1 id="${titleId}"></h1>
        </div>
        <div class="bbtool-headtools">
          <select class="bbtool-lang">
            <option value="ja">日本語</option><option value="en">English</option><option value="zh">中文</option>
          </select>
          <select class="bbtool-theme"><option value="light"></option><option value="dark"></option></select>
          <a class="bbtool-gh" href="${UPDATE_URL}" target="_blank" rel="noopener">${SYNC_ICON}</a>
        </div>
      </div>
      <div class="bbtool-body">${bodyHtml}</div>
      <div class="bbtool-footer">${footerHtml}</div>`;
    const overlay = el("div", { className: "bbtool-overlay" });
    panel.__overlay = overlay;
    // 一律挂在 <body> 下：挂进 Blackboard 的布局元素里时，祖先的 transform/contain 会让 position:fixed 跟着偏移
    document.body.appendChild(overlay);
    document.body.appendChild(panel);
    panel.__close = onClose || (() => setShellOpen(panel, false));
    const doClose = () => panel.__close();
    overlay.addEventListener("click", doClose);
    panel.querySelector(`#${closeId}`).addEventListener("click", doClose);
    panel.querySelectorAll(".bbtool-dismiss").forEach((b) => b.addEventListener("click", doClose));
    panel.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); doClose(); } });

    const langSel = panel.querySelector(".bbtool-lang");
    const themeSel = panel.querySelector(".bbtool-theme");
    langSel.value = lang;
    langSel.onchange = () => setLang(langSel.value);
    themeSel.value = panel.dataset.theme;
    themeSel.onchange = () => setTheme(themeSel.value);
    const hook = () => {
      langSel.value = lang;
      langSel.title = langSel.ariaLabel = t("lang");
      themeSel.title = themeSel.ariaLabel = t("theme");
      themeSel.options[0].textContent = t("theme_light");
      themeSel.options[1].textContent = t("theme_dark");
      const site = panel.querySelector(".bbtool-gh");
      site.title = site.ariaLabel = updateVer ? t("update_available", updateVer) : t("site_upd");
      const x = panel.querySelector(`#${closeId}`);
      x.title = x.ariaLabel = t("close");
      panel.querySelectorAll(".bbtool-dismiss[data-k]").forEach((b) => { b.textContent = t(b.dataset.k); });
    };
    hook();
    langHooks.add(hook);
    panel.__langHook = hook;
    markUpdate(); // 有新版时立刻给更新按钮加红点，不用等导航那边每 1.5 秒的补齐
    return panel;
  }
  // 同一时间只开一个面板；页面一律变暗（和原生 peek 面板一样）
  function setShellOpen(panel, open) {
    if (!panel) return;
    if (open) {
      document.querySelectorAll(".bbtool-shell.open").forEach((p) => { if (p !== panel && p.__close) p.__close(); });
      panel.dataset.theme = curTheme();
    }
    panel.classList.toggle("open", open);
    const ov = panel.__overlay;
    if (ov) ov.classList.toggle("show", open);
    if (open) { const x = panel.querySelector(".bbtool-close"); if (x) try { x.focus({ preventScroll: true }); } catch (e) {} }
    syncNavActive(); // 開いているパネルの入口を「選択中」の見た目に
  }

  // 文件旁「在新标签打开」的图标：缺了右上角的方框 + 斜向右上的箭头
  const OPEN_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
    `<path d="M11 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/><path d="M14 4h6v6"/><path d="M20 4 11 13"/></svg>`;
  let dlPanel = null;
  let dlFiles = []; // 只放可下载的文件（file 节点），下标对应树里的 data-i
  // 内容树扫描结果缓存：切换课程再切回来时不用重新递归几百个文件夹。手动「スキャン」会强制刷新。
  const scanCache = new Map();
  const SCAN_TTL = 10 * 60 * 1000;

  function buildDlPanel() {
    if (document.getElementById(PANEL_ID)) return;
    dlPanel = el("div", { id: PANEL_ID });
    mountShell(dlPanel, {
      sub: { id: "bbdl-sub" },
      titleId: "bbdl-title",
      closeId: "bbdl-x",
      bodyHtml: `
        <section class="sec">
          <h2 id="bbdl-h-course"></h2>
          <p class="desc" id="bbdl-d-course"></p>
          <div class="row">
            <label class="fld"><span id="bbdl-f-term"></span><select id="bbdl-term"><option>…</option></select></label>
          </div>
          <div class="row">
            <label class="fld"><span id="bbdl-f-course"></span><select id="bbdl-course"><option value=""></option></select></label>
            <button class="btn line" id="bbdl-scan" type="button"></button>
          </div>
          <div class="row">
            <label><input type="checkbox" id="bbdl-archived"><span id="bbdl-archived-label"></span></label>
          </div>
        </section>
        <section class="sec">
          <h2 id="bbdl-h-files"></h2>
          <div class="tree-head">
            <label><input type="checkbox" id="bbdl-all" checked><span id="bbdl-all-label"></span></label>
            <label><input type="checkbox" id="bbdl-zip"><span id="bbdl-zip-label"></span></label>
          </div>
          <ul class="tree" id="bbdl-list"></ul>
          <p class="empty" id="bbdl-empty"></p>
        </section>`,
      footerHtml: `<div class="bbtool-status" id="bbdl-status" role="status"></div>
        <div class="bbtool-actions">
          <button class="btn sec bbtool-dismiss m-hide" data-k="close" type="button"></button>
          <button class="btn" id="bbdl-go" type="button"></button>
        </div>`,
    });

    const $ = (s) => dlPanel.querySelector(s);
    const status = (txt) => ($("#bbdl-status").textContent = txt);
    const listRoot = $("#bbdl-list");
    let grouped = []; // [[term, [course...]], ...]
    let pendingZip = null; // iOS：打好的 ZIP 等用户点一下再保存（保存需要用户手势）

    // 把静态文案按当前语言刷新
    function fillTermOptions() {
      const termSel = $("#bbdl-term");
      if (termSel.dataset.loaded !== "1") return;
      const cur = termSel.value;
      termSel.innerHTML = grouped
        .map(([tm, cs]) => `<option value="${tm}">${tm ? esc(tm) : t("other")}（${cs.length}）</option>`)
        .join("");
      // 只恢复真实存在的学期；首次加载时 cur 是占位符「…」，不能拿来设值（会把下拉框置空、课程列表跟着变空）
      if (cur && grouped.some(([tm]) => tm === cur)) termSel.value = cur;
    }
    function applyLang() {
      $("#bbdl-sub").textContent = t("sub_dl");
      $("#bbdl-title").textContent = t("title");
      $("#bbdl-h-course").textContent = t("dl_sec_course");
      $("#bbdl-d-course").textContent = t("dl_desc");
      $("#bbdl-f-term").textContent = t("f_term");
      $("#bbdl-f-course").textContent = t("f_course");
      $("#bbdl-h-files").textContent = t("dl_sec_files");
      $("#bbdl-empty").textContent = t("dl_empty");
      $("#bbdl-scan").textContent = t("scan");
      $("#bbdl-archived-label").textContent = t("nw_show_archived");
      $("#bbdl-all-label").textContent = t("select_all");
      $("#bbdl-zip-label").textContent = t("zip");
      $("#bbdl-go").textContent = pendingZip ? t("zip_save") : t("download");
      const cs = $("#bbdl-course");
      if (cs.options[0]) cs.options[0].textContent = t("pick_course");
      fillTermOptions();
    }

    // 语言/主题下拉框由 mountShell 统一接线；这里只刷新本面板的文案
    langHooks.add(applyLang);

    applyLang();
    status(t("pick"));
    syncEmpty();

    // ZIP 打包：iOS 默认开（连续多个下载在 iOS 上体验很差），桌面默认关；记住用户选择
    const zipCb = $("#bbdl-zip");
    zipCb.checked = store.get(LS_ZIP, IS_IOS ? "1" : "0") === "1";
    zipCb.onchange = () => store.set(LS_ZIP, zipCb.checked ? "1" : "0");

    // 已归档/受講不可のコースを出すか。設定はダウンロード・答题・公告パネル共通。
    const archCb = $("#bbdl-archived");
    archCb.checked = store.get(LS_ARCHIVED, "0") === "1";
    archCb.onchange = () => {
      store.set(LS_ARCHIVED, archCb.checked ? "1" : "0");
      $("#bbdl-term").dataset.loaded = "";
      listRoot.innerHTML = "";
      dlFiles = [];
      syncEmpty();
      loadCourses();
    };

    // 每次扫描拿一个序号。扫描要请求很多次接口，比较慢；途中又点了「スキャン」、换了课程或学期时，
    // 旧扫描晚到的结果直接丢掉。不这样做的话，两次扫描都会把结果追加进同一个列表：文件夹和文件出现两次，
    // dlFiles 也被追加两遍、勾选框的序号错位；换课程时旧课程的文件还会混进新课程的列表。
    let scanSeq = 0;

    async function loadCourses() {
      if ($("#bbdl-term").dataset.loaded === "1") return;
      try {
        status(t("loading"));
        grouped = groupCourses(await getCourses());
        $("#bbdl-term").dataset.loaded = "1";
        fillTermOptions();
        const saved = store.get(LS_TERM, "");
        if (saved && grouped.some(([tm]) => tm === saved)) $("#bbdl-term").value = saved;
        fillCourses();
        status(t("count", grouped.reduce((n, [, cs]) => n + cs.length, 0)));
      } catch (e) {
        status(t("load_fail", e.message));
      }
    }
    function fillCourses() {
      scanSeq++; // 列表要被清空了：进行中的扫描作废
      const term = $("#bbdl-term").value;
      const cs = (grouped.find(([tm]) => tm === term) || [null, []])[1];
      $("#bbdl-course").innerHTML =
        `<option value="">${t("pick_course")}</option>` +
        cs.map((c) => `<option value="${c.id}">${esc(c.short)}</option>`).join("");
      listRoot.innerHTML = "";
      syncEmpty();
      status(t("pick")); // 课程选择被重置了；也盖掉作废扫描留下的「スキャン中…」（加载课程时随后会被课程数覆盖）
    }
    // 树为空时显示提示，有内容时隐藏
    function syncEmpty() { $("#bbdl-empty").hidden = !!listRoot.children.length; }
    $("#bbdl-term").onchange = () => { store.set(LS_TERM, $("#bbdl-term").value); fillCourses(); };

    // 説明：短ければそのまま、長い（60 字超か複数行）ときは先頭だけ出して押すと全部開く
    function descHtml(desc) {
      if (!desc) return "";
      if (desc.length <= 60 && !desc.includes("\n")) return `<div class="bbdl-desc">${esc(desc)}</div>`;
      const head = desc.split("\n")[0].slice(0, 60);
      return `<details class="bbdl-desc"><summary>${esc(head)}…</summary><div>${esc(desc)}</div></details>`;
    }
    // 文件树渲染
    function renderNodes(nodes, container) {
      for (const node of nodes) {
        const li = document.createElement("li");
        if (node.type === "folder") {
          li.className = "dir";
          li.innerHTML = `<div class="item"><label><input type="checkbox" class="bbdl-dir" checked><span>📁 ${esc(node.name)}</span></label></div>` + descHtml(node.desc);
          const ul = document.createElement("ul");
          renderNodes(node.children, ul);
          li.appendChild(ul);
        } else if (node.type === "video") {
          li.innerHTML = `<div class="item vid">🎬 <a href="${ORIGIN + node.launch}" target="_blank" rel="noopener" title="${esc(t("vlink_title"))}">${esc(node.name)}</a></div>` + descHtml(node.desc);
        } else if (node.type === "link") {
          li.innerHTML = `<div class="item lnk">🔗 <a href="${esc(absUrl(node.url))}" target="_blank" rel="noopener">${esc(node.name)}</a></div>` + descHtml(node.desc);
        } else {
          const i = dlFiles.length;
          dlFiles.push(node);
          const size = node.size ? ` <span class="muted">(${esc(fmtSize(node.size))})</span>` : "";
          li.innerHTML = `<div class="item"><label><input type="checkbox" class="bbdl-f" data-i="${i}" checked><span>${esc(node.name)}${size}</span></label>` +
            `<a class="bbdl-open" href="${esc(absUrl(node.url))}" target="_blank" rel="noopener" aria-label="${esc(t("open_tab"))}" title="${esc(t("open_tab"))}">${OPEN_SVG}</a></div>` + descHtml(node.desc);
        }
        container.appendChild(li);
      }
    }
    function refreshDirStates() {
      const dirs = [...listRoot.querySelectorAll(".bbdl-dir")].reverse(); // 从深到浅
      for (const d of dirs) {
        const fs = [...d.closest("li").querySelectorAll(".bbdl-f")];
        const c = fs.filter((x) => x.checked).length;
        d.checked = fs.length > 0 && c === fs.length;
        d.indeterminate = c > 0 && c < fs.length;
      }
    }
    listRoot.addEventListener("change", (e) => {
      const cb = e.target;
      if (cb.classList.contains("bbdl-dir")) {
        cb.closest("li").querySelectorAll(".bbdl-f, .bbdl-dir").forEach((x) => { x.checked = cb.checked; x.indeterminate = false; });
      }
      refreshDirStates();
      syncSelectAll();
    });

    // 文件旁的打开图标：右键弹出「复制链接」。菜单挂在面板里（面板是 position:fixed，按面板坐标定位）
    let linkMenu = null;
    function closeLinkMenu() {
      if (!linkMenu) return;
      linkMenu.remove();
      linkMenu = null;
      document.removeEventListener("mousedown", onMenuOutside, true);
      document.removeEventListener("keydown", onMenuKey, true);
      document.removeEventListener("scroll", closeLinkMenu, true);
    }
    function onMenuOutside(e) { if (linkMenu && !linkMenu.contains(e.target)) closeLinkMenu(); }
    function onMenuKey(e) { if (e.key === "Escape") closeLinkMenu(); }
    function copyText(text) {
      const fallback = () => {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.cssText = "position:fixed;top:0;left:-9999px;opacity:0;";
        document.body.appendChild(ta);
        ta.select();
        let ok = false;
        try { ok = document.execCommand("copy"); } catch (e) {}
        ta.remove();
        return ok;
      };
      if (navigator.clipboard && navigator.clipboard.writeText)
        return navigator.clipboard.writeText(text).then(() => true, () => fallback());
      return Promise.resolve(fallback());
    }
    listRoot.addEventListener("contextmenu", (e) => {
      const a = e.target.closest(".bbdl-open");
      if (!a) return;
      e.preventDefault();
      closeLinkMenu();
      const url = a.href;
      linkMenu = el("div", { className: "bbdl-menu" });
      linkMenu.setAttribute("role", "menu");
      const item = el("button", { type: "button", textContent: t("copy_link") });
      item.setAttribute("role", "menuitem");
      item.onclick = () => {
        closeLinkMenu();
        copyText(url).then((ok) => status(ok ? t("link_copied") : "Copy failed"));
      };
      linkMenu.appendChild(item);
      dlPanel.appendChild(linkMenu);
      const box = dlPanel.getBoundingClientRect();
      const x = Math.min(e.clientX - box.left, box.width - linkMenu.offsetWidth - 4);
      const y = Math.min(e.clientY - box.top, box.height - linkMenu.offsetHeight - 4);
      linkMenu.style.left = Math.max(4, x) + "px";
      linkMenu.style.top = Math.max(4, y) + "px";
      document.addEventListener("mousedown", onMenuOutside, true);
      document.addEventListener("keydown", onMenuKey, true);
      document.addEventListener("scroll", closeLinkMenu, true);
      item.focus();
    });

    function syncSelectAll() {
      const fs = [...listRoot.querySelectorAll(".bbdl-f")];
      const c = fs.filter((x) => x.checked).length;
      const all = $("#bbdl-all");
      all.checked = fs.length > 0 && c === fs.length;
      all.indeterminate = c > 0 && c < fs.length;
    }

    function clearPendingZip() {
      pendingZip = null;
      $("#bbdl-go").textContent = t("download");
    }
    async function scan(force = false) {
      const cid = $("#bbdl-course").value;
      if (!cid) return status(t("pick"));
      const my = ++scanSeq;
      const current = () => my === scanSeq;
      clearPendingZip();
      listRoot.innerHTML = "";
      dlFiles = [];
      status(t("scanning"));
      let tree;
      const hit = scanCache.get(cid);
      if (!force && hit && Date.now() - hit.t < SCAN_TTL) {
        tree = hit.tree;
        status(t("scan_cached"));
      } else {
        tree = await scanTree(cid, "ROOT", "", (msg) => { if (current()) status(msg); });
        if (current()) scanCache.set(cid, { t: Date.now(), tree });
      }
      if (!current()) return; // 期间开始了新的扫描，或换了课程 / 学期：这次的结果作废
      listRoot.innerHTML = "";
      dlFiles = [];
      renderNodes(tree, listRoot);
      refreshDirStates();
      syncSelectAll();
      syncEmpty();
      const nv = listRoot.querySelectorAll(".vid").length; // 只数讲义视频，不数每个文件旁的「↗」
      status(t("found", dlFiles.length) + (nv ? t("plus_videos", nv) : ""));
    }
    $("#bbdl-scan").onclick = () => scan(true); // 手动扫描 = 强制刷新缓存
    $("#bbdl-course").onchange = () => scan(false);
    $("#bbdl-all").onchange = (e) => {
      listRoot.querySelectorAll(".bbdl-f, .bbdl-dir").forEach((c) => { c.checked = e.target.checked; c.indeterminate = false; });
      e.target.indeterminate = false;
    };

    // 下载失败的文件：在树里标 ❌ 并给「↗」原链接，点开后用浏览器自己的会话手动保存（iOS 上 GM 请求可能不带 Cookie）
    function markFailed(i, err) {
      const cb = listRoot.querySelector(`.bbdl-f[data-i="${i}"]`);
      const li = cb && cb.closest(".item");
      if (!li || li.querySelector(".bbdl-manual")) return;
      const a = el("a", { className: "bbdl-manual", href: absUrl(dlFiles[i].url), target: "_blank", rel: "noopener",
        title: t("manual") + (err ? "（" + err + "）" : "") }, "❌↗");
      li.insertBefore(a, li.firstChild);
    }

    $("#bbdl-go").onclick = async () => {
      // 第二次点击：保存已经打好的 ZIP（此时在用户手势里，iOS 才肯下载）
      if (pendingZip) {
        const { blob, name, ok, fail } = pendingZip;
        saveBlob(blob, name);
        clearPendingZip();
        return status(t("zip_saved", ok, fail));
      }
      const idx = [...listRoot.querySelectorAll(".bbdl-f:checked")].map((c) => +c.dataset.i);
      if (!idx.length) return status(t("no_sel"));
      listRoot.querySelectorAll(".bbdl-manual").forEach((a) => a.remove());
      const zip = zipCb.checked;
      $("#bbdl-go").disabled = true;
      let ok = 0, fail = 0, firstErr = "";
      const entries = [], used = new Set();
      const cs = $("#bbdl-course");
      const course = sanitize(cs.options[cs.selectedIndex] ? cs.options[cs.selectedIndex].textContent : "") || "blackboard";
      for (let k = 0; k < idx.length; k++) {
        const f = dlFiles[idx[k]];
        status(t("downloading", k + 1, idx.length, f.name));
        try {
          if (zip) {
            const blob = await fetchBlob(absUrl(f.url), f.name); // 先取到再占用文件名，失败的不占 (2)
            entries.push({ path: zipPath(f, used, course), blob });
          }
          else await downloadOne(f);
          ok++;
        } catch (err) {
          fail++;
          const msg = err.message || String(err);
          if (!firstErr) firstErr = msg;
          markFailed(idx[k], msg);
          console.warn("下载失败", f, err);
        }
        if (!zip) await new Promise((r) => setTimeout(r, 300));
      }
      if (zip && entries.length) {
        try {
          status(t("zipping", entries.length));
          const blob = await buildZip(entries);
          const name = course + ".zip";
          if (IS_IOS) {
            pendingZip = { blob, name, ok, fail };
            $("#bbdl-go").textContent = t("zip_save");
            status(t("zip_ready", ok, fail) + (firstErr ? "（" + firstErr + "）" : ""));
          } else {
            saveBlob(blob, name);
            status(fail ? t("done_err", ok, fail, firstErr) : t("zip_saved", ok, fail));
          }
        } catch (err) {
          status(t("done_err", 0, idx.length, err.message || String(err)));
        }
      } else {
        status(fail ? t("done_err", ok, fail, firstErr) : t("done", ok, fail));
      }
      $("#bbdl-go").disabled = false;
    };

    // cid があれば（コースカードのボタンから）、その学期・コースを選んでスキャンする
    dlPanel._open = async (cid) => {
      setShellOpen(dlPanel, true);
      await loadCourses();
      if (!cid || !grouped.length) return;
      const g = grouped.find(([, cs]) => cs.some((c) => c.id === cid));
      if (!g) return status(t("card_missing"));
      if ($("#bbdl-term").value !== g[0]) { $("#bbdl-term").value = g[0]; fillCourses(); }
      if ($("#bbdl-course").value !== cid) { $("#bbdl-course").value = cid; scan(false); }
    };
  }

  function toggleDlPanel() {
    buildDlPanel();
    if (dlPanel.classList.contains("open")) setShellOpen(dlPanel, false);
    else dlPanel._open();
  }

  function openDlForCourse(cid) {
    buildDlPanel();
    dlPanel._open(cid);
  }
  // ---------------------------------------------------------------- 左侧导航入口
  // 每个入口都克隆现有导航项（一个 svg + 一个 p），文字更新见下方 langHooks。
  function cloneNavItem(id, innerHtml, label, onClick) {
    const ul = document.getElementById("base_tools");
    if (!ul || document.getElementById(id)) return;
    const sample =
      ul.querySelector('a[data-analytics-id="base.nav.navigation.tools"]') ||
      ul.querySelector('a[data-analytics-id="base.nav.navigation.courses"]') ||
      ul.querySelector("a");
    if (!sample) return;
    const node = sample.cloneNode(true);
    node.id = id;
    node.setAttribute("href", "#");
    node.removeAttribute("data-analytics-id");
    node.removeAttribute("aria-current");
    // 去掉所有「当前选中」样式类（类名带随机后缀，按关键字匹配）
    for (const c of [...node.classList]) if (/active|selected/i.test(c)) node.classList.remove(c);

    const iconBox = node.querySelector(".MuiListItemIcon-root");
    if (iconBox) {
      const old = iconBox.querySelector("svg");
      if (old) {
        // 保留外层容器和原 svg 的尺寸/类名 → 和其它项对齐
        const tpl = document.createElement("div");
        tpl.innerHTML = innerHtml;
        const svg = tpl.firstElementChild;
        for (const attr of ["class", "width", "height", "style"]) {
          const v = old.getAttribute(attr);
          if (v != null) svg.setAttribute(attr, v);
        }
        const r = old.getBoundingClientRect();
        if (r.width && !old.getAttribute("width")) {
          svg.setAttribute("width", Math.round(r.width));
          svg.setAttribute("height", Math.round(r.height));
        }
        old.replaceWith(svg);
      } else {
        iconBox.innerHTML = innerHtml;
      }
    }
    const p = node.querySelector("p");
    if (p) p.textContent = label;
    node.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      // 手机/窄屏上左侧导航是抽屉，先收起，免得挡住面板
      const closeBtn = document.querySelector('[data-analytics-id="baseLayout.close.button"]');
      if (closeBtn) closeBtn.click();
      onClick();
    });
    ul.appendChild(node);
  }

  // パネルを開いている間、その入口を LMS の「選択中」と同じ見た目（左の白い線＋背景）にする。
  // 選択中のクラス（makeStylesactive-0-2-xxx と active。数字は読み込みごとに変わる）は、いま選択中の本物の項目から借りる。
  // 二重に光らないよう、本物の項目の選択中クラスは開いている間だけ外し、閉じたら戻す。
  // 本物に選択中の項目が無い画面（借りるクラスが無い）では、左の白線と背景を style で描く。
  // setShellOpen と、入口の injectAll（1.5 秒ごと：SPA の画面遷移で本物の選択中が変わったとき用）から呼ぶ。
  const NAV_ACT_RE = /active|selected/i;
  let navActCls = null, navLent = null;
  function syncNavActive() {
    const ul = document.getElementById("base_tools");
    if (!ul) return;
    const ours = [NAV_ID].map((id) => document.getElementById(id)).filter(Boolean);
    const open = document.querySelector(".bbtool-shell.open");
    const want = open && open.id ? open.id.replace(/-panel$/, "-nav") : "";
    const active = !!want && ours.some((a) => a.id === want);
    if (active) {
      for (const a of ul.querySelectorAll("a")) {
        if (ours.includes(a)) continue;
        const cls = [...a.classList].filter((c) => NAV_ACT_RE.test(c));
        if (!cls.length) continue;
        navActCls = cls;
        navLent = { el: a, cls, cur: a.getAttribute("aria-current") };
        a.classList.remove(...cls);
        a.removeAttribute("aria-current");
      }
    } else if (navLent) {
      if (navLent.el.isConnected) {
        navLent.el.classList.add(...navLent.cls);
        if (navLent.cur) navLent.el.setAttribute("aria-current", navLent.cur);
      }
      navLent = null;
    }
    for (const a of ours) {
      const on = active && a.id === want;
      for (const c of navActCls || []) a.classList.toggle(c, on);
      a.style.boxShadow = on && !navActCls ? "inset 4px 0 0 #fff" : "";
      a.style.backgroundColor = on && !navActCls ? "rgba(255,255,255,.16)" : "";
      if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    }
  }

  function ensureNavItem() {
    cloneNavItem(NAV_ID, DL_ICON, t("nav"), toggleDlPanel);
  }

  // コース一覧（/ultra/course）の各カード：★（お気に入り）の隣にダウンロードボタン。押すとそのコースでパネルを開く。
  // 開けないコース（非公開など inactive-link）と、まだ描画されていない空のカード（data-course-id=""）には付けない
  function ensureCardButtons() {
    for (const card of document.querySelectorAll("article.course-element-card[data-course-id]:not(.inactive-link)")) {
      const cid = card.dataset.courseId;
      const box = card.querySelector(".controls");
      if (!/^_\d+_\d+$/.test(cid) || !box) continue;
      const star = box.querySelector(".js-favourite-button");
      let b = box.querySelector(".telas-card-dl");
      if (!b) {
        const name = ((card.querySelector(".js-course-title-element") || {}).textContent || "").trim();
        b = el("button", { type: "button", className: "super-clear telas-card-dl", title: t("card_dl", name) }, DL_ICON);
        b.setAttribute("aria-label", t("card_dl", name));
        // カード全体がクリックでコースを開くので、そこまで伝わらないようにする
        b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); openDlForCourse(cid); });
        if (star) star.after(b); else box.appendChild(b);
      }
      if (star) placeLikeStar(b, star); // 1.5 秒ごと：画面幅でカードの並びが変わっても★に付いていく
    }
  }

  // ★ボタンの見た目は LMS の CSS（.favorite）が決めていて、こちらには当たらない（2026-11-23、ずれると報告）。
  // ★の実際の位置・大きさを写し、★が absolute で角に置かれているならその左隣に並べる。アイコンも★と同じクラスにする
  function placeLikeStar(b, star) {
    const cs = getComputedStyle(star);
    const s = b.style;
    s.color = "inherit";
    s.cursor = "pointer";
    for (const k of ["display", "verticalAlign", "boxSizing", "width", "height", "padding", "lineHeight", "float", "alignItems", "justifyContent"]) s[k] = cs[k];
    s.margin = "0";
    const starSvg = star.querySelector("svg"), mySvg = b.querySelector("svg");
    if (starSvg && mySvg && starSvg.getAttribute("class")) {
      mySvg.setAttribute("class", starSvg.getAttribute("class"));
      mySvg.removeAttribute("width");
      mySvg.removeAttribute("height");
    }
    if (cs.position === "absolute" || cs.position === "fixed") {
      s.position = cs.position;
      s.top = cs.top;
      s.bottom = cs.bottom;
      const gap = 4;
      if (cs.right !== "auto") { s.right = parseFloat(cs.right) + star.offsetWidth + gap + "px"; s.left = "auto"; }
      else { s.left = parseFloat(cs.left) - star.offsetWidth - gap + "px"; s.right = "auto"; }
    } else {
      s.position = cs.position === "static" ? "" : cs.position;
      s.top = s.bottom = s.left = s.right = "";
      s.marginLeft = cs.float === "right" ? "0" : "4px";
      s.marginRight = cs.float === "right" ? "4px" : "0";
    }
  }
  // ---------------------------------------------------------------- 讲义视频页（vlib）
  // 脚本也在 Mediasite 播放页运行：此时已是 vlib 同源，直接调 GetPlayerOptions 拿 MP4 直链，
  // MP4 又和本页同域，<a download> 就能存。授权（AuthTicket / MediasiteAuthTickets cookie）
  // 由浏览器点开视频时的 LTI 流程完成，脚本不碰。
  async function resolveMp4() {
    // 兼容 /Mediasite/Play/<id> 和 /Mediasite/v2021/Play/<id> 等带版本段的播放页
    const m = location.pathname.match(/\/Play\/([0-9a-fA-F]+)/);
    if (!m) throw new Error(t("v_not_play"));
    const pid = m[1];
    const r = await fetch(ORIGIN + "/Mediasite/PlayerService/PlayerService.svc/json/GetPlayerOptions", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ getPlayerOptionsRequest: { ResourceId: pid, QueryString: location.search, UseScreenReader: false, UrlReferrer: "" } }),
    });
    if (!r.ok) throw new Error(t("v_http", r.status));
    const d = (await r.json()).d || {};
    const pres = d.Presentation || {};
    const streams = (pres.Streams || []).slice().sort((a, b) => (a.StreamType !== 0) - (b.StreamType !== 0));
    for (const s of streams)
      for (const v of s.VideoUrls || [])
        if ((v.MimeType || "").startsWith("video/mp4") && v.Location)
          return { url: v.Location, title: pres.Title || pid };
    throw new Error(d.PlayerPresentationStatusMessage || t("v_no_mp4"));
  }

  function initMediasitePage() {
    const sanitizeV = (s) => (s || "video").replace(/[\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim();
    let busy = false;
    // say(text) 显示状态；结束后 say(null) 复原。下载本身两种按钮共用
    async function run(say) {
      if (busy) return;
      busy = true;
      say(t("v_resolving"));
      try {
        const { url, title } = await resolveMp4();
        const a = document.createElement("a");
        a.href = url;              // 与本页同域（vlib），download 可强制下载并改名
        a.download = sanitizeV(title) + ".mp4";
        document.body.appendChild(a);
        a.click();
        a.remove();
        console.log("[MP4]", url); // 需要时可从控制台复制直链
        say(t("v_started"));
        setTimeout(() => { busy = false; say(null); }, 4000);
      } catch (e) {
        say(t("v_fail", e.message || e));
        setTimeout(() => { busy = false; say(null); }, 5000);
      }
    }

    // ---- 播放器控制栏里的按钮：放在「情報 / 全画面」那一组最前面，样子跟原生按钮一致
    let toast;
    const sayToast = (msg) => {
      if (!toast) {
        toast = document.createElement("div");
        toast.setAttribute("role", "status");
        toast.style.cssText =
          "position:fixed;left:50%;bottom:96px;transform:translateX(-50%);z-index:2147483000;max-width:80vw;" +
          "background:rgba(0,0,0,.78);color:#fff;border-radius:4px;padding:8px 14px;font:13px/1.4 system-ui,sans-serif;" +
          "pointer-events:none;transition:opacity .2s";
        document.body.appendChild(toast);
      }
      if (msg) toast.textContent = msg;
      toast.style.opacity = msg ? "1" : "0";
    };
    function barButton() {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "telas-vdl ui-button ui-corner-all ui-widget";
      b.title = t("v_tip"); b.setAttribute("aria-label", b.title);
      b.style.cssText = "background:none;border:none;position:relative;padding:0;cursor:pointer;color:#fff";
      // 原生「ダウンロード」按钮（在「更に表示」里，通常是灰的）的图标正好是同一个图形，有就借用
      const nat = document.querySelector(".controlBar .downloads img.foreground");
      b.innerHTML = '<span class="ui-blur-image" style="width:30px;height:30px;display:flex;align-items:center;justify-content:center;' +
        'filter:drop-shadow(0 0 2px rgba(0,0,0,.7))">' +
        (nat ? `<img src="${esc(nat.src)}" alt="" style="width:30px;height:30px">` : DL_ICON.replace(/width="16" height="16"/, 'width="20" height="20"')) +
        "</span>";
      b.addEventListener("click", (e) => {
        e.stopPropagation();     // 别让播放器把点击当成「暂停 / 显示控制栏」
        run((msg) => { b.style.opacity = msg && busy ? ".6" : ""; sayToast(msg); });
      });
      return b;
    }
    let placed = false, queued = false;
    const place = () => {
      queued = false;
      if (document.querySelector(".telas-vdl")) return;
      const grp = document.querySelector(".controlBar .generalControls");
      if (!grp) return;
      grp.insertBefore(barButton(), grp.firstChild);
      placed = true;
      window.dispatchEvent(new Event("resize")); // 让播放器按新宽度重排各组的位置
    };
    // 控制栏由播放器脚本晚些生成，之后还可能整块重建，所以一直看着，丢了就补回去
    new MutationObserver(() => { if (!queued) { queued = true; requestAnimationFrame(place); } })
      .observe(document.documentElement, { childList: true, subtree: true });

    // ---- 找不到控制栏（播放器换了布局）时，退回原来的右下角浮动按钮
    setTimeout(() => {
      if (placed || !document.body) return;
      const btn = document.createElement("button");
      btn.textContent = t("v_btn");
      btn.style.cssText =
        "position:fixed;right:20px;bottom:20px;z-index:2147483000;background:#3b4fa8;color:#fff;border:none;" +
        "border-radius:24px;padding:12px 18px;font:14px/1 system-ui,sans-serif;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.3)";
      btn.onclick = () => run((msg) => { btn.textContent = msg || t("v_btn"); btn.disabled = !!msg; });
      document.body.appendChild(btn);
    }, 10000);
  }
  // ================================================================ TELAS 网站的桥（telas.manjuu.net，备用 manjuu08.github.io/telas-site）
  // 网站是静态页面，浏览器的 CORS 不让它直接访问 LMS；脚本的 GM 请求不受限制、还带着浏览器里 LMS 的登录状态，
  // 所以由脚本替网页办事。只开放下面这几个只读操作，地址全部由脚本自己拼，网页不能让脚本访问任意网址。
  // 协议：网页 → window.postMessage({ns, dir:"req", id, op, args})；脚本 → {ns, dir:"res", id, ok, data|error}，
  //       扫描过程中另发 {ns, dir:"progress", id, text}；脚本就绪时广播 {ns, dir:"ready", version}。
  function gmJSON(url) {
    const gm = gmXhr();
    if (!gm) return Promise.reject(Object.assign(new Error("no GM_xmlhttpRequest"), { code: "nogm" }));
    return new Promise((resolve, reject) => {
      const ret = gm({
        method: "GET", url, responseType: "text", anonymous: false,
        headers: { Accept: "application/json" },
        onload: (res) => {
          const text = res.responseText != null ? res.responseText : res.response;
          if (res.status === 401 || res.status === 403 || /^\s*</.test(text || "")) {
            return reject(Object.assign(new Error("not logged in"), { code: "auth" }));
          }
          if (res.status < 200 || res.status >= 300) return reject(Object.assign(new Error("HTTP " + res.status), { code: "http" }));
          try { resolve(JSON.parse(text)); } catch (e) { reject(Object.assign(new Error("bad JSON"), { code: "http" })); }
        },
        onerror: () => reject(Object.assign(new Error("network"), { code: "net" })),
        ontimeout: () => reject(Object.assign(new Error("timeout"), { code: "net" })),
      });
      if (ret && typeof ret.catch === "function") ret.catch(() => {});
    });
  }

  const BB_ID = /^_\d+_\d+$/;
  const needId = (v) => { if (!BB_ID.test(String(v || ""))) throw Object.assign(new Error("bad id"), { code: "args" }); return v; };
  // 截止日期字段在不同版本里叫法不一，按顺序找
  const dueOf = (c) => c.dueDate || (c.grading && c.grading.due) || c.due || c.dueDateTime || null;

  const BRIDGE_OPS = {
    async hello() {
      const v = (typeof GM_info !== "undefined" && GM_info.script && GM_info.script.version) || "";
      return { version: v };
    },
    async me() {
      const me = await gmJSON(API("/learn/api/v1/users/me"));
      return { name: [me.familyName, me.givenName].filter(Boolean).join(" ") || me.userName || "" };
    },
    async courses() {
      return groupCourses(await getCourses());
    },
    async scan({ cid }, progress) {
      needId(cid);
      await gmJSON(API(`/learn/api/v1/courses/${cid}`)); // 先确认登录和权限，免得静默返回空树
      return scanTree(cid, "ROOT", "", progress);
    },
    async columns({ cid }) {
      needId(cid);
      const data = await gmJSON(API(`/learn/api/v1/courses/${cid}/gradebook/columns?limit=1000`));
      return (data.results || [])
        .map((c) => ({ id: c.id, name: c.columnName || c.name || "", due: dueOf(c), contentId: c.contentId || null }))
        .filter((c) => c.id && c.due);
    },
    async attempts({ cid, colId }) {
      needId(cid); needId(colId);
      const data = await gmJSON(API(`/learn/api/v1/courses/${cid}/gradebook/columns/${colId}/attempts?limit=100`));
      return (data.results || []).map((a) => ({ status: a.status || "" }));
    },
    async file({ url, name }) {
      // 只允许 LMS 上 /bbcswebdav/ 下的文件
      const path = String(url || "").replace(LMS, "");
      if (!path.startsWith("/bbcswebdav/")) throw Object.assign(new Error("bad url"), { code: "args" });
      const blob = await fetchBlob(LMS + path, name || "");
      return { buffer: await blob.arrayBuffer(), type: blob.type || "" };
    },
  };

  function initSiteBridge() {
    const NS = "telas-bridge";
    const post = (msg, transfer) => window.postMessage({ ns: NS, ...msg }, location.origin, transfer || []);
    window.addEventListener("message", async (e) => {
      // 只收同一页面（同源）发来的请求；自己发出的回复也会进来，按 dir 过滤
      if (e.origin !== location.origin) return;
      const d = e.data;
      if (!d || d.ns !== NS || d.dir !== "req" || typeof d.op !== "string") return;
      const fn = Object.prototype.hasOwnProperty.call(BRIDGE_OPS, d.op) ? BRIDGE_OPS[d.op] : null;
      if (!fn) return post({ dir: "res", id: d.id, ok: false, error: { code: "op", message: "unknown op" } });
      try {
        const data = await fn(d.args || {}, (text) => post({ dir: "progress", id: d.id, text: String(text) }));
        const transfer = data && data.buffer && data.buffer.byteLength != null ? [data.buffer] : [];
        post({ dir: "res", id: d.id, ok: true, data }, transfer);
      } catch (err) {
        post({ dir: "res", id: d.id, ok: false, error: { code: err.code || "error", message: String(err.message || err) } });
      }
    });
    BRIDGE_OPS.hello().then((h) => post({ dir: "ready", version: h.version }));
  }

  // ================================================================ 新版本检查
  // 脚本管理器自己也会按 @updateURL 更新，但什么时候查、有没有新版，用户看不到。
  // 这里最多每 6 小时取一次线上脚本的 @version，比当前装的新就在 TELAS 的导航项上加红点、
  // 面板右上角的更新按钮（点开就是安装页，管理器会提示更新）右上角也加红点。
  const UPDATE_URL = "https://telas.manjuu.net/teikyo-bb.user.js";
  const LS_UPDATE = "telas.update"; // {t: 上次检查的时间, v: 线上版本}
  const UPDATE_EVERY = 6 * 3600 * 1000;
  let updateVer = "";

  function installedVersion() {
    try { return (typeof GM_info !== "undefined" ? GM_info : GM.info).script.version || ""; } catch (e) { return ""; }
  }
  function newerVersion(a, b) { // a 比 b 新？按点分的数字逐段比较
    const x = String(a).split(".").map(Number), y = String(b).split(".").map(Number);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      const d = (x[i] || 0) - (y[i] || 0);
      if (d) return d > 0;
    }
    return false;
  }
  function checkUpdate() {
    const cur = installedVersion();
    if (!cur) return;
    let saved = {};
    try { saved = JSON.parse(store.get(LS_UPDATE, "{}")) || {}; } catch (e) {}
    const apply = (v) => { updateVer = v && newerVersion(v, cur) ? v : ""; markUpdate(); };
    apply(saved.v);
    if (Date.now() - (saved.t || 0) < UPDATE_EVERY) return;
    const gm = gmXhr();
    if (!gm) return;
    const ret = gm({
      method: "GET", url: UPDATE_URL + "?t=" + Date.now(), anonymous: true,
      onload: (r) => {
        const m = r.status === 200 && /^\/\/\s*@version\s+(\S+)/m.exec(r.responseText || "");
        if (!m) return;
        store.set(LS_UPDATE, JSON.stringify({ t: Date.now(), v: m[1] }));
        apply(m[1]);
      },
    });
    if (ret && typeof ret.catch === "function") ret.catch(() => {});
  }
  // 由入口的 injectAll 每 1.5 秒调用：SPA 重画导航、新开的面板都会补上
  function markUpdate() {
    if (!updateVer) return;
    for (const id of [NAV_ID]) {
      const box = document.querySelector(`#${id} .MuiListItemIcon-root`) || document.getElementById(id);
      if (!box || box.querySelector(".telas-upd-dot")) continue;
      box.style.position = "relative";
      const dot = el("span", { className: "telas-upd-dot", title: t("update_available", updateVer) });
      dot.style.cssText = "position:absolute;top:-2px;right:-2px;width:9px;height:9px;border-radius:50%;background:#e53935;box-shadow:0 0 0 2px #fff;pointer-events:none";
      box.appendChild(dot);
    }
    for (const btn of document.querySelectorAll(".bbtool-shell .bbtool-gh")) {
      if (btn.querySelector(".telas-upd-dot")) continue;
      btn.title = btn.ariaLabel = t("update_available", updateVer);
      const dot = el("span", { className: "telas-upd-dot" });
      dot.style.cssText = "position:absolute;top:2px;right:2px;width:9px;height:9px;border-radius:50%;background:#e53935;box-shadow:0 0 0 2px var(--bg);pointer-events:none";
      btn.appendChild(dot);
    }
  }
  // ---------------------------------------------------------------- DOM 就绪
  // @run-at document-start 时 body / base_tools 都还没有；SPA 的导航也可能比脚本晚出现。
  // 等到 body 出现且（导航锚点或登录表单）就位，或最多等 30 秒，再跑各模块的初始化。
  function whenReady(cb) {
    const ready = () => document.body && (document.getElementById("base_tools") || onLoginForm());
    if (ready()) { cb(); return; }
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      if (ready()) { clearInterval(timer); cb(); }
      else if (tries > 120) { clearInterval(timer); cb(); }
    }, 250);
  }

  // ================================================================ 入口分流
  // @run-at 是 document-start，body / base_tools 还没有，所以 DOM 相关的初始化放到 whenReady 之后。
  // 网站上没有 LMS 的导航 / 登录表单，whenReady 会白等 30 秒；DOM 好了就开桥（首页靠 ready 广播判断脚本是否已装）
  if (ON_SITE) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initSiteBridge, { once: true });
    else initSiteBridge();
    return;
  }
  if (location.hostname === "vlib.ita.teikyo-u.ac.jp") {
    if (/\/Play\/[0-9a-fA-F]+/.test(location.pathname)) initMediasitePage();
    return;
  }

  // lms2017：登录页认 #user_id，或路径 /webapps/login/（登录页上什么都不做）
  function onLoginForm() {
    return !!document.getElementById("user_id") || /\/webapps\/login\//.test(location.pathname);
  }

  function boot() {
    if (onLoginForm()) return;
    // 应用页：导航项和课程卡片上的下载按钮，SPA 重渲染（课程列表滚动加载）后轮询补回
    const injectAll = () => { ensureNavItem(); ensureCardButtons(); markUpdate(); syncNavActive(); };
    injectAll();
    checkUpdate();
    setInterval(injectAll, 1500);
  }

  whenReady(boot);
})();
