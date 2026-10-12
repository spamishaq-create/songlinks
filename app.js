(function () {
  "use strict";
  function $(id) { return document.getElementById(id); }
  var STORAGE_MSG = (location.protocol === "file:" || location.protocol === "content:")
    ? "This phone blocks saving songs when the app is opened as a file. Put the app on an https web address (see README) to save songs."
    : "Offline storage isn't available in this browser.";
  function showError(msg) {
    var b = document.getElementById("err");
    if (!b) return;
    b.textContent = "Something went wrong: " + msg + " (tap to dismiss)";
    b.hidden = false;
  }
  window.addEventListener("error", function (e) { showError(e && e.message ? e.message : "unknown error"); });
  var PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
  var PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';

  /* ---------- Small helpers ---------- */
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function hueOf(name) { var h = 0; for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360; return h; }
  function gradOf(name) { var h = hueOf(name); return "linear-gradient(135deg,hsl(" + h + " 62% 46%),hsl(" + ((h + 50) % 360) + " 68% 28%))"; }
  function fmt(s) { if (!isFinite(s) || s < 0) s = 0; var m = Math.floor(s / 60), r = Math.floor(s % 60); return m + ":" + (r < 10 ? "0" : "") + r; }
  function fmtSize(b) { if (!b) return ""; return b > 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.round(b / 1024) + " KB"; }
  function isYouTube(u) {
    try { var h = new URL(u).hostname.replace(/^www\./, ""); return h === "youtu.be" || h === "youtube.com" || h.endsWith(".youtube.com"); }
    catch (e) { return false; }
  }

  /* ---------- Cover art ---------- */
  var artUrls = {};
  function paintArt(node, name, img) {
    node.style.background = "";
    node.style.backgroundImage = "";
    if (img) {
      node.style.backgroundImage = 'url("' + img.replace(/"/g, "%22") + '"), ' + gradOf(name);
      node.style.backgroundSize = "cover";
      node.textContent = "";
    } else {
      node.style.background = gradOf(name);
      node.textContent = (name.trim().charAt(0) || "\u266A").toUpperCase();
    }
  }
  function trackArtUrl(t) {
    if (!t.art) return null;
    if (!artUrls[t.id]) artUrls[t.id] = URL.createObjectURL(t.art);
    return artUrls[t.id];
  }
  function makeArt(name, img) { var d = el("div", "art"); paintArt(d, name, img); return d; }

  /* ---------- Tabs ---------- */
  var VIEWS = ["library", "search", "links"];
  function show(name) {
    VIEWS.forEach(function (v) { $("v-" + v).hidden = v !== name; });
    Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (t) {
      if (t.getAttribute("data-view") === name) t.setAttribute("aria-current", "page"); else t.removeAttribute("aria-current");
    });
    $("views").scrollTop = 0;
  }
  Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (t) {
    t.addEventListener("click", function () { show(t.getAttribute("data-view")); });
  });

  /* ---------- Saved YouTube Music links ---------- */
  var LINKS_KEY = "songlinks:v1";
  var links = [];
  function loadLinks() { try { var p = JSON.parse(localStorage.getItem(LINKS_KEY) || "[]"); links = Array.isArray(p) ? p : []; } catch (e) { links = []; } }
  function saveLinks() { try { localStorage.setItem(LINKS_KEY, JSON.stringify(links)); } catch (e) {} }
  function renderLinks() {
    var list = $("list"); list.textContent = "";
    links.forEach(function (s) {
      var li = el("li");
      var a = el("a", "row-main"); a.href = s.url; a.target = "_blank"; a.rel = "noopener noreferrer";
      a.appendChild(makeArt(s.title));
      var tx = el("div", "txt"); tx.appendChild(el("span", "t", s.title)); tx.appendChild(el("span", "s", "Opens in YouTube Music"));
      a.appendChild(tx);
      var rm = el("button", "remove", "Remove"); rm.type = "button"; rm.setAttribute("aria-label", "Remove " + s.title);
      rm.addEventListener("click", function () { links = links.filter(function (x) { return x.id !== s.id; }); saveLinks(); renderLinks(); });
      li.appendChild(a); li.appendChild(rm); list.appendChild(li);
    });
    $("empty").style.display = links.length ? "none" : "block";
  }
  $("save").addEventListener("submit", function (e) {
    e.preventDefault();
    var t = $("title").value.trim(), u = $("url").value.trim(), msg = $("msg");
    if (!t) { msg.textContent = "Add the song title so you can find it later."; return; }
    if (!isYouTube(u)) { msg.textContent = "Paste a link from YouTube Music or YouTube."; return; }
    links.unshift({ id: Date.now().toString(36), title: t, url: u });
    saveLinks(); renderLinks(); $("title").value = ""; $("url").value = ""; msg.textContent = "";
  });

  /* ---------- Offline library (IndexedDB) ---------- */
  var db = null, tracks = [], current = -1, currentUrl = null;
  var shuffleOn = false, repeatMode = "off";
  var audio = $("audio"), audioMsg = $("audioMsg"), seeking = false;

  function openDb() {
    return new Promise(function (res, rej) {
      if (!window.indexedDB) { rej(new Error("no idb")); return; }
      var r = indexedDB.open("songlinks-audio", 1);
      r.onupgradeneeded = function () { r.result.createObjectStore("tracks", { keyPath: "id" }); };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function tx(mode, fn) {
    return new Promise(function (res, rej) {
      var t = db.transaction("tracks", mode), out = fn(t.objectStore("tracks"));
      t.oncomplete = function () { res(out && out.result); };
      t.onerror = function () { rej(t.error); };
      t.onabort = function () { rej(t.error); };
    });
  }
  function subOf(t) { return t.artist || "On this device"; }
  function inLibrary(key) { return tracks.some(function (t) { return t.srcId === key; }); }

  function renderTracks() {
    var ul = $("tracks"); ul.textContent = "";
    tracks.forEach(function (t, i) {
      var li = el("li"); if (i === current) li.className = "playing";
      var b = el("button", "row-main"); b.type = "button";
      b.appendChild(makeArt(t.name, trackArtUrl(t)));
      var tx2 = el("div", "txt"); tx2.appendChild(el("span", "t", t.name)); tx2.appendChild(el("span", "s", subOf(t)));
      b.appendChild(tx2);
      b.addEventListener("click", function () { play(i); });
      var rm = el("button", "remove", "Remove"); rm.type = "button"; rm.setAttribute("aria-label", "Remove " + t.name);
      rm.addEventListener("click", function () { removeTrack(i); });
      li.appendChild(b); li.appendChild(rm); ul.appendChild(li);
    });
    $("tracksEmpty").style.display = tracks.length ? "none" : "block";
    $("count").textContent = tracks.length ? tracks.length + (tracks.length === 1 ? " song" : " songs") : "";
  }
  function removeTrack(i) {
    var t = tracks[i], wasCurrent = i === current;
    tx("readwrite", function (s) { return s.delete(t.id); }).then(function () {
      tracks.splice(i, 1);
      if (artUrls[t.id]) { URL.revokeObjectURL(artUrls[t.id]); delete artUrls[t.id]; }
      if (wasCurrent) { stopCurrent(); current = -1; $("mini").hidden = true; closeFull(); }
      else if (i < current) current -= 1;
      renderTracks(); refreshResultButtons();
    }).catch(function () { audioMsg.textContent = "Couldn't remove that song."; });
  }
  function saveTrack(rec) {
    if (!db) return Promise.reject(new Error("no db"));
    return tx("readwrite", function (s) { s.put(rec); }).then(function () { tracks.push(rec); renderTracks(); refreshResultButtons(); });
  }

  $("addBtn").addEventListener("click", function () { $("files").click(); });
  $("files").addEventListener("change", function () {
    var input = $("files");
    if (!db) { audioMsg.textContent = STORAGE_MSG; return; }
    var files = Array.prototype.slice.call(input.files || []).filter(function (f) {
      return f.type.indexOf("audio/") === 0 || /\.(mp3|m4a|aac|wav|ogg|opus|flac)$/i.test(f.name);
    });
    input.value = "";
    if (!files.length) { audioMsg.textContent = "Choose audio files (MP3, M4A, WAV, OGG, FLAC)."; return; }
    audioMsg.textContent = "";
    var added = files.map(function (f, n) {
      return { id: Date.now().toString(36) + "-" + n + "-" + Math.random().toString(36).slice(2, 6), name: f.name.replace(/\.[^.]+$/, ""), added: Date.now() + n, blob: f };
    });
    tx("readwrite", function (s) { added.forEach(function (a) { s.put(a); }); }).then(function () {
      tracks = tracks.concat(added); renderTracks();
    }).catch(function () { audioMsg.textContent = "Couldn't save to this phone. Storage may be full or blocked."; });
  });

  /* ---------- Player ---------- */
  function stopCurrent() {
    audio.pause();
    if (currentUrl) { URL.revokeObjectURL(currentUrl); currentUrl = null; }
    audio.removeAttribute("src"); audio.load();
  }
  function setMedia(t) {
    try {
      if ("mediaSession" in navigator && window.MediaMetadata) {
        var md = { title: t.name, artist: subOf(t) };
        navigator.mediaSession.metadata = new MediaMetadata(md);
      }
    } catch (e) {}
  }
  function play(i) {
    if (i < 0 || i >= tracks.length) return;
    stopCurrent();
    current = i;
    var t = tracks[i], img = trackArtUrl(t);
    currentUrl = URL.createObjectURL(t.blob);
    audio.src = currentUrl;
    paintArt($("miniArt"), t.name, img); paintArt($("fullArt"), t.name, img);
    $("miniTitle").textContent = t.name; $("fullTitle").textContent = t.name;
    $("miniSub").textContent = subOf(t); $("fullSub").textContent = subOf(t);
    $("full").style.setProperty("--full-top", "hsl(" + hueOf(t.name) + " 45% 32%)");
    $("mini").hidden = false;
    $("mini").style.background = "hsl(" + hueOf(t.name) + " 38% 24%)";
    setMedia(t);
    var p = audio.play(); if (p && p.catch) p.catch(function () {});
    renderTracks();
  }
  function randomOther() { if (tracks.length < 2) return 0; var n; do { n = Math.floor(Math.random() * tracks.length); } while (n === current); return n; }
  function goNext(auto) {
    if (!tracks.length) return;
    if (auto && repeatMode === "one") { audio.currentTime = 0; audio.play(); return; }
    if (shuffleOn) { play(randomOther()); return; }
    if (current < tracks.length - 1) { play(current + 1); return; }
    if (!auto || repeatMode === "all") { play(0); return; }
    audio.pause(); audio.currentTime = 0;
  }
  function goPrev() {
    if (!tracks.length) return;
    if (audio.currentTime > 3) { audio.currentTime = 0; return; }
    if (shuffleOn) { play(randomOther()); return; }
    play((current - 1 + tracks.length) % tracks.length);
  }
  function toggle() {
    if (current < 0) { if (tracks.length) play(shuffleOn ? randomOther() : 0); return; }
    if (audio.paused) { var p = audio.play(); if (p && p.catch) p.catch(function () {}); } else audio.pause();
  }
  function syncPlayIcons() {
    var playing = !audio.paused && !audio.ended;
    $("miniPlay").innerHTML = playing ? PAUSE : PLAY; $("play").innerHTML = playing ? PAUSE : PLAY;
    $("miniPlay").setAttribute("aria-label", playing ? "Pause" : "Play"); $("play").setAttribute("aria-label", playing ? "Pause" : "Play");
    try { if ("mediaSession" in navigator) navigator.mediaSession.playbackState = playing ? "playing" : "paused"; } catch (e) {}
  }
  function setShuffle(on) {
    shuffleOn = on;
    $("shuffle").classList.toggle("on", on);
    $("shuffle").setAttribute("aria-pressed", String(on)); $("shuffleTop").setAttribute("aria-pressed", String(on));
  }
  function cycleRepeat() {
    repeatMode = repeatMode === "off" ? "all" : repeatMode === "all" ? "one" : "off";
    var r = $("repeat"); r.setAttribute("data-mode", repeatMode); r.classList.toggle("on", repeatMode !== "off"); r.setAttribute("aria-label", "Repeat " + repeatMode);
  }
  audio.addEventListener("play", syncPlayIcons);
  audio.addEventListener("pause", syncPlayIcons);
  audio.addEventListener("ended", function () { syncPlayIcons(); goNext(true); });
  audio.addEventListener("loadedmetadata", function () { $("dur").textContent = fmt(audio.duration); });
  audio.addEventListener("error", function () { if (current >= 0) audioMsg.textContent = "This file couldn't be played. Try a different format."; });
  audio.addEventListener("timeupdate", function () {
    var d = audio.duration, c = audio.currentTime;
    if (isFinite(d) && d > 0) { $("miniBar").style.width = (c / d * 100) + "%"; if (!seeking) { $("seek").value = Math.round(c / d * 1000); $("seek").style.setProperty("--pct", (c / d * 100) + "%"); } }
    if (!seeking) $("cur").textContent = fmt(c);
  });
  $("seek").addEventListener("input", function () { seeking = true; $("seek").style.setProperty("--pct", ($("seek").value / 10) + "%"); var d = audio.duration; if (isFinite(d)) $("cur").textContent = fmt(d * $("seek").value / 1000); });
  $("seek").addEventListener("change", function () { var d = audio.duration; if (isFinite(d)) audio.currentTime = d * $("seek").value / 1000; seeking = false; });
  $("miniPlay").addEventListener("click", toggle);
  $("play").addEventListener("click", toggle);
  $("miniNext").addEventListener("click", function () { goNext(false); });
  $("next").addEventListener("click", function () { goNext(false); });
  $("prev").addEventListener("click", goPrev);
  $("shuffle").addEventListener("click", function () { setShuffle(!shuffleOn); });
  $("shuffleTop").addEventListener("click", function () { setShuffle(!shuffleOn); });
  $("repeat").addEventListener("click", cycleRepeat);
  $("playAll").addEventListener("click", function () { if (tracks.length) play(shuffleOn ? Math.floor(Math.random() * tracks.length) : 0); });
  function openFull() { $("full").hidden = false; $("fullClose").focus(); }
  function closeFull() { $("full").hidden = true; }
  $("miniOpen").addEventListener("click", openFull);
  $("fullClose").addEventListener("click", closeFull);
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !$("full").hidden) closeFull(); });
  try {
    if ("mediaSession" in navigator) {
      navigator.mediaSession.setActionHandler("play", function () { audio.play(); });
      navigator.mediaSession.setActionHandler("pause", function () { audio.pause(); });
      navigator.mediaSession.setActionHandler("previoustrack", goPrev);
      navigator.mediaSession.setActionHandler("nexttrack", function () { goNext(false); });
    }
  } catch (e) {}

  /* ---------- Downloading into the library ---------- */
  function mimeFor(name, ct) {
    if (ct && ct.indexOf("audio/") === 0) return ct.split(";")[0];
    var ext = (name.match(/\.([a-z0-9]+)(?:\?|$)/i) || [])[1];
    ext = ext ? ext.toLowerCase() : "";
    return { mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg", opus: "audio/ogg", wav: "audio/wav", flac: "audio/flac" }[ext] || "audio/mpeg";
  }
  function fetchAudio(url, onProgress) {
    return fetch(url).then(function (resp) {
      if (!resp.ok) throw new Error("The server said " + resp.status + ".");
      var ct = resp.headers.get("content-type") || "";
      if (/text\/html|application\/json/i.test(ct)) throw new Error("That link isn't an audio file.");
      var total = parseInt(resp.headers.get("content-length") || "0", 10);
      if (!resp.body || !resp.body.getReader) {
        return resp.blob().then(function (b) { return new Blob([b], { type: mimeFor(url, ct) }); });
      }
      var reader = resp.body.getReader(), chunks = [], got = 0;
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) return new Blob(chunks, { type: mimeFor(url, ct) });
          chunks.push(r.value); got += r.value.length;
          if (onProgress) onProgress(got, total);
          return pump();
        });
      }
      return pump();
    });
  }
  function fetchImage(url) {
    if (!url) return Promise.resolve(null);
    return fetch(url).then(function (r) { return r.ok ? r.blob() : null; }).catch(function () { return null; });
  }
  // meta: { key, name, artist, img, url }
  function downloadTrack(meta, onProgress) {
    if (!db) return Promise.reject(new Error(STORAGE_MSG));
    if (!navigator.onLine) return Promise.reject(new Error("You're offline. Connect to the internet to download."));
    return fetchAudio(meta.url, onProgress).then(function (blob) {
      if (!blob.size) throw new Error("The file was empty.");
      return fetchImage(meta.img).then(function (art) {
        var rec = { id: Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6), name: meta.name, artist: meta.artist || "", added: Date.now(), blob: blob, srcId: meta.key || "" };
        if (art && art.size) rec.art = art;
        return saveTrack(rec);
      });
    }).catch(function (e) {
      if (e && (e.name === "TypeError" || /failed to fetch|networkerror|load failed/i.test(e.message || ""))) {
        throw new Error((location.protocol === "file:" || location.protocol === "content:") ? "Downloads are blocked because the app was opened as a file. Open it from an https web address." : "This site doesn't allow downloads from apps.");
      }
      if (e && e.name === "QuotaExceededError") throw new Error("Your phone is out of storage space.");
      throw e;
    });
  }

  /* ---------- Search: Jamendo + Internet Archive ---------- */
  var JAM_KEY = "songlinks:jamendo";
  var source = "jamendo";
  var q = $("q"), results = $("results"), searchMsg = $("searchMsg");
  var resultButtons = [];

  function getJamId() { try { return localStorage.getItem(JAM_KEY) || ""; } catch (e) { return ""; } }
  function setSource(s) {
    source = s;
    $("srcJamendo").setAttribute("aria-pressed", String(s === "jamendo"));
    $("srcArchive").setAttribute("aria-pressed", String(s === "archive"));
    $("jamSetup").hidden = !(s === "jamendo" && !getJamId());
    results.textContent = ""; resultButtons = []; searchMsg.textContent = "";
  }
  $("srcJamendo").addEventListener("click", function () { setSource("jamendo"); });
  $("srcArchive").addEventListener("click", function () { setSource("archive"); });
  $("jamSave").addEventListener("click", function () {
    var v = $("jamId").value.trim();
    if (!v) { searchMsg.textContent = "Paste your Jamendo client ID first."; return; }
    try { localStorage.setItem(JAM_KEY, v); } catch (e) {}
    $("jamSetup").hidden = true; $("jamId").value = ""; searchMsg.textContent = "Saved. Now search for a song.";
  });

  function updateYtLink() {
    var raw = q.value.trim(), go = $("go");
    if (raw) { go.href = "https://music.youtube.com/search?q=" + encodeURIComponent(raw); go.classList.remove("disabled"); }
    else { go.href = "#"; go.classList.add("disabled"); }
  }
  q.addEventListener("input", updateYtLink);
  q.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); runSearch(); } });
  $("searchBtn").addEventListener("click", runSearch);

  function refreshResultButtons() {
    resultButtons.forEach(function (r) { if (inLibrary(r.key)) { r.btn.textContent = "In library"; r.btn.disabled = true; r.btn.className = "dl ghost"; } });
  }
  function addDownloadButton(host, meta) {
    var btn = el("button", "dl", "Download"); btn.type = "button";
    btn.setAttribute("aria-label", "Download " + meta.name);
    var fb = null;
    if (inLibrary(meta.key)) { btn.textContent = "In library"; btn.disabled = true; btn.className = "dl ghost"; }
    btn.addEventListener("click", function () {
      btn.disabled = true; btn.textContent = "0%";
      if (fb) { fb.remove(); fb = null; }
      downloadTrack(meta, function (got, total) { btn.textContent = total ? Math.round(got / total * 100) + "%" : fmtSize(got); })
        .then(function () { btn.textContent = "In library"; btn.className = "dl ghost"; })
        .catch(function (err) {
          btn.disabled = false; btn.textContent = "Retry";
          fb = el("div", "fallback");
          fb.appendChild(document.createTextNode((err && err.message ? err.message : "Download failed.") + " "));
          var a = el("a", null, "Open the file in your browser"); a.href = meta.url; a.target = "_blank"; a.rel = "noopener noreferrer";
          fb.appendChild(a);
          host.appendChild(fb);
        });
    });
    resultButtons.push({ key: meta.key, btn: btn });
    return btn;
  }
  function resultRow(title, sub, img) {
    var li = el("li");
    var main = el("div", "row-main"); main.style.cursor = "default";
    main.appendChild(makeArt(title, img));
    var tx2 = el("div", "txt"); tx2.appendChild(el("span", "t", title)); tx2.appendChild(el("span", "s", sub));
    main.appendChild(tx2); li.appendChild(main);
    return li;
  }

  function searchJamendo(text) {
    var id = getJamId();
    if (!id) { $("jamSetup").hidden = false; return Promise.reject(new Error("Add your Jamendo client ID below to search Jamendo.")); }
    var url = "https://api.jamendo.com/v3.0/tracks/?client_id=" + encodeURIComponent(id) + "&format=json&limit=25&audiodownload_allowed=true&imagesize=200&search=" + encodeURIComponent(text);
    return fetch(url).then(function (r) { return r.json(); }).then(function (j) {
      if (!j || !j.headers || j.headers.status !== "success") throw new Error((j && j.headers && j.headers.error_message) || "Jamendo search failed. Check your client ID.");
      return j.results.map(function (x) {
        return { key: "jamendo:" + x.id, name: x.name, artist: x.artist_name, img: x.image || x.album_image || "", url: x.audiodownload || x.audio, dur: x.duration };
      }).filter(function (m) { return m.url; });
    });
  }
  function renderJamendo(items) {
    items.forEach(function (m) {
      var li = resultRow(m.name, (m.artist || "Unknown artist") + (m.dur ? " \u2022 " + fmt(m.dur) : ""), m.img);
      li.appendChild(addDownloadButton(li, m));
      results.appendChild(li);
    });
  }

  function searchArchive(text) {
    var query = "(" + text + ") AND mediatype:audio AND collection:opensource_audio";
    var url = "https://archive.org/advancedsearch.php?q=" + encodeURIComponent(query) + "&fl%5B%5D=identifier&fl%5B%5D=title&fl%5B%5D=creator&rows=20&page=1&output=json";
    return fetch(url).then(function (r) { return r.json(); }).then(function (j) {
      return ((j && j.response && j.response.docs) || []).map(function (d) {
        var c = Array.isArray(d.creator) ? d.creator[0] : d.creator;
        return { id: d.identifier, title: Array.isArray(d.title) ? d.title[0] : (d.title || d.identifier), artist: c || "" };
      });
    });
  }
  function renderArchive(items) {
    items.forEach(function (it) {
      var cover = "https://archive.org/services/img/" + encodeURIComponent(it.id);
      var li = resultRow(it.title, it.artist || "Internet Archive", cover);
      var open = el("button", "dl ghost", "Files"); open.type = "button";
      var list = null, loaded = false;
      open.addEventListener("click", function () {
        if (list) { list.hidden = !list.hidden; open.textContent = list.hidden ? "Files" : "Hide"; return; }
        open.disabled = true; open.textContent = "\u2026";
        fetch("https://archive.org/metadata/" + encodeURIComponent(it.id)).then(function (r) { return r.json(); }).then(function (j) {
          var files = ((j && j.files) || []).filter(function (f) { return /\.mp3$/i.test(f.name); }).slice(0, 30);
          list = el("ul", "files");
          if (!files.length) list.appendChild(el("li", null, "No MP3 files in this item."));
          files.forEach(function (f) {
            var row = el("li");
            var label = f.title || f.name;
            row.appendChild(el("span", "t", label));
            var meta = { key: "ia:" + it.id + "/" + f.name, name: (f.title || f.name.replace(/\.[^.]+$/, "")), artist: f.artist || it.artist || "", img: cover,
                         url: "https://archive.org/download/" + encodeURIComponent(it.id) + "/" + f.name.split("/").map(encodeURIComponent).join("/") };
            row.appendChild(addDownloadButton(row, meta));
            list.appendChild(row);
          });
          li.appendChild(list); loaded = true;
          open.disabled = false; open.textContent = "Hide";
        }).catch(function () {
          open.disabled = false; open.textContent = "Files";
          searchMsg.textContent = "Couldn't load that item's files.";
        });
      });
      li.appendChild(open);
      results.appendChild(li);
    });
  }

  function runSearch() {
    var text = q.value.trim();
    results.textContent = ""; resultButtons = [];
    if (!text) { searchMsg.textContent = "Type a song or artist first."; return; }
    if (!navigator.onLine) { searchMsg.textContent = "You're offline. Your library still plays."; return; }
    searchMsg.className = "msg ok"; searchMsg.textContent = "Searching\u2026";
    var p = source === "jamendo" ? searchJamendo(text) : searchArchive(text);
    p.then(function (items) {
      if (!items.length) { searchMsg.textContent = "No results. Try a different search or source."; return; }
      searchMsg.textContent = items.length + " results";
      if (source === "jamendo") renderJamendo(items); else renderArchive(items);
    }).catch(function (e) {
      searchMsg.className = "msg";
      var net = e && (e.name === "TypeError" || /failed to fetch|networkerror|load failed/i.test(e.message || ""));
      var fileMode = location.protocol === "file:" || location.protocol === "content:";
      searchMsg.textContent = net ? (fileMode ? "Search is blocked because the app was opened as a file. Open it from an https web address instead." : "Couldn't reach the search service. Check your connection.") : (e && e.message) || "Search failed.";
    });
  }

  /* ---------- Add from a direct link ---------- */
  $("dlBtn").addEventListener("click", function () {
    var u = $("dlUrl").value.trim(), msg = $("dlMsg"), btn = $("dlBtn");
    msg.className = "msg";
    var parsed = null; try { parsed = new URL(u); } catch (e) {}
    if (!parsed || !/^https?:$/.test(parsed.protocol)) { msg.textContent = "Paste a full link that starts with https://"; return; }
    if (isYouTube(u)) { msg.textContent = "YouTube links can't be downloaded here. Use Open in YouTube Music instead."; return; }
    var nm = $("dlName").value.trim();
    if (!nm) { try { nm = decodeURIComponent(parsed.pathname.split("/").pop() || "").replace(/\.[^.]+$/, ""); } catch (e) { nm = ""; } }
    if (!nm) nm = "Downloaded song";
    btn.disabled = true; btn.textContent = "Downloading\u2026"; msg.className = "msg ok"; msg.textContent = "";
    downloadTrack({ key: "", name: nm, artist: "", img: "", url: u }, function (got, total) { btn.textContent = total ? "Downloading " + Math.round(got / total * 100) + "%" : "Downloading " + fmtSize(got); })
      .then(function () { msg.textContent = "Saved to your library."; $("dlUrl").value = ""; $("dlName").value = ""; })
      .catch(function (e) { msg.className = "msg"; msg.textContent = (e && e.message) || "Download failed."; })
      .then(function () { btn.disabled = false; btn.textContent = "Download to library"; });
  });

  window.addEventListener("offline", function () { searchMsg.className = "msg ok"; searchMsg.textContent = "You're offline. Your library still plays."; });
  window.addEventListener("online", function () { if (/offline/.test(searchMsg.textContent)) searchMsg.textContent = ""; });

  /* ---------- Start ---------- */
  syncPlayIcons(); loadLinks(); renderLinks(); updateYtLink(); renderTracks();
  setSource(getJamId() ? "jamendo" : "archive");
  openDb().then(function (d) {
    db = d;
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
    return tx("readonly", function (s) { return s.getAll(); });
  }).then(function (all) {
    tracks = (all || []).sort(function (a, b) { return a.added - b.added; });
    renderTracks();
  }).catch(function () { audioMsg.textContent = STORAGE_MSG; });

  if ("serviceWorker" in navigator && /^https:$|^http:$/.test(location.protocol) && (location.protocol === "https:" || location.hostname === "localhost")) {
    window.addEventListener("load", function () { navigator.serviceWorker.register("sw.js").catch(function () {}); });
  }
})();
