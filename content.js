(() => {
  if (window.__floatingNotesInjected) return;
  window.__floatingNotesInjected = true;

  const STORAGE_KEY = "floatingNotesByDomain";
  const LEGACY_KEY = "floatingNotes";
  const UI_KEY = "floatingNotesUi";
  const DIR_META_KEY = "floatingNotesDirMeta";
  const AUTH_KEY = "floatingNotesAuth";
  const UNLOCK_KEY = "fnBrowserUnlocked";
  const SESSION_KEY = "floatingNotesUnlocked"; // 兼容旧键，不再作为主判断
  const IDB_NAME = "floating-notes-fs";
  const IDB_STORE = "handles";
  const IDB_DIR_KEY = "notesDir";
  const ROOT_ID = "fn-root";
  const DRAG_THRESHOLD = 5;

  /** @type {HTMLElement | null} */
  let root = null;
  /** @type {Record<string, Array>} */
  let notesByDomain = {};
  /** @type {FileSystemDirectoryHandle | null} */
  let dirHandle = null;
  let dirLabel = "";
  /** @type {{ salt: string, passwordHash: string, recoveryQ: string, recoveryHash: string } | null} */
  let auth = null;
  let unlocked = false;
  /** @type {'login' | 'setup' | 'reset'} */
  let authView = "login";
  let ui = {
    visible: true,
    minimized: false,
    maximized: false,
    left: null,
    top: null,
    expandedLeft: null,
    expandedTop: null,
  };

  function currentDomain() {
    try {
      return location.hostname || "本地页面";
    } catch {
      return "本地页面";
    }
  }

  function currentNotes() {
    const domain = currentDomain();
    if (!Array.isArray(notesByDomain[domain])) {
      notesByDomain[domain] = [];
    }
    return notesByDomain[domain];
  }

  function uid() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function formatTime(ts) {
    try {
      return new Date(ts).toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return "";
    }
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  const NOTES_FILE = "floating-notes.json";

  function randomSalt() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  function bytesToHex(bytes) {
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  /** HTTP 等非安全页面没有 crypto.subtle，用纯 JS SHA-256 兜底 */
  function sha256HexSync(text) {
    const K = new Uint32Array([
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ]);

    function rotr(n, x) {
      return (x >>> n) | (x << (32 - n));
    }

    const msg = unescape(encodeURIComponent(text));
    const len = msg.length;
    const bitLen = len * 8;
    const withPad = len + 1;
    const total = ((withPad + 8 + 63) & ~63);
    const bytes = new Uint8Array(total);
    for (let i = 0; i < len; i++) bytes[i] = msg.charCodeAt(i);
    bytes[len] = 0x80;
    const view = new DataView(bytes.buffer);
    view.setUint32(total - 4, bitLen >>> 0, false);
    // high 32 bits of length (always 0 for short passwords)
    view.setUint32(total - 8, Math.floor(bitLen / 0x100000000), false);

    let h0 = 0x6a09e667;
    let h1 = 0xbb67ae85;
    let h2 = 0x3c6ef372;
    let h3 = 0xa54ff53a;
    let h4 = 0x510e527f;
    let h5 = 0x9b05688c;
    let h6 = 0x1f83d9ab;
    let h7 = 0x5be0cd19;
    const w = new Uint32Array(64);

    for (let i = 0; i < total; i += 64) {
      for (let j = 0; j < 16; j++) w[j] = view.getUint32(i + j * 4, false);
      for (let j = 16; j < 64; j++) {
        const s0 = rotr(7, w[j - 15]) ^ rotr(18, w[j - 15]) ^ (w[j - 15] >>> 3);
        const s1 = rotr(17, w[j - 2]) ^ rotr(19, w[j - 2]) ^ (w[j - 2] >>> 10);
        w[j] = (w[j - 16] + s0 + w[j - 7] + s1) >>> 0;
      }
      let a = h0;
      let b = h1;
      let c = h2;
      let d = h3;
      let e = h4;
      let f = h5;
      let g = h6;
      let h = h7;
      for (let j = 0; j < 64; j++) {
        const S1 = rotr(6, e) ^ rotr(11, e) ^ rotr(25, e);
        const ch = (e & f) ^ (~e & g);
        const t1 = (h + S1 + ch + K[j] + w[j]) >>> 0;
        const S0 = rotr(2, a) ^ rotr(13, a) ^ rotr(22, a);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + maj) >>> 0;
        h = g;
        g = f;
        f = e;
        e = (d + t1) >>> 0;
        d = c;
        c = b;
        b = a;
        a = (t1 + t2) >>> 0;
      }
      h0 = (h0 + a) >>> 0;
      h1 = (h1 + b) >>> 0;
      h2 = (h2 + c) >>> 0;
      h3 = (h3 + d) >>> 0;
      h4 = (h4 + e) >>> 0;
      h5 = (h5 + f) >>> 0;
      h6 = (h6 + g) >>> 0;
      h7 = (h7 + h) >>> 0;
    }

    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);
    outView.setUint32(0, h0, false);
    outView.setUint32(4, h1, false);
    outView.setUint32(8, h2, false);
    outView.setUint32(12, h3, false);
    outView.setUint32(16, h4, false);
    outView.setUint32(20, h5, false);
    outView.setUint32(24, h6, false);
    outView.setUint32(28, h7, false);
    return bytesToHex(out);
  }

  async function sha256Hex(text) {
    // HTTPS / 扩展页可用 subtle；HTTP 内网页必须走纯 JS
    if (globalThis.crypto?.subtle) {
      try {
        const data = new TextEncoder().encode(text);
        const buf = await crypto.subtle.digest("SHA-256", data);
        return bytesToHex(new Uint8Array(buf));
      } catch {
        /* fall through */
      }
    }
    return sha256HexSync(text);
  }

  async function hashSecret(secret, salt) {
    return sha256Hex(`${salt}:${secret}`);
  }

  async function getSessionUnlocked() {
    // 1) 后台统一状态（推荐）
    try {
      const res = await chrome.runtime.sendMessage({ type: "FN_AUTH_GET" });
      if (typeof res?.unlocked === "boolean") return res.unlocked;
    } catch {
      /* fall through */
    }
    // 2) 直接读 local：所有域名/标签页共享同一份
    try {
      const data = await chrome.storage.local.get(UNLOCK_KEY);
      return Boolean(data[UNLOCK_KEY]);
    } catch {
      return false;
    }
  }

  async function setSessionUnlocked(value) {
    unlocked = Boolean(value);
    try {
      const res = await chrome.runtime.sendMessage({
        type: "FN_AUTH_SET",
        unlocked,
      });
      if (typeof res?.unlocked === "boolean") {
        unlocked = res.unlocked;
        return;
      }
    } catch {
      /* fall through */
    }
    // 后台不可用时，直接写入共享存储
    await chrome.storage.local.set({ [UNLOCK_KEY]: unlocked });
  }

  function onSharedUnlockChanged(changes, areaName) {
    if (areaName !== "local" || !changes[UNLOCK_KEY]) return;
    unlocked = Boolean(changes[UNLOCK_KEY].newValue);
    authView = unlocked ? authView : "login";
    if (root) {
      applyAuthGate();
      if (unlocked) renderList();
    }
  }

  chrome.storage.onChanged.addListener(onSharedUnlockChanged);

  function openIdb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbGet(key) {
    const db = await openIdb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbSet(key, value) {
    const db = await openIdb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function ensureDirPermission(handle, mode = "readwrite") {
    if (!handle) return false;
    const opts = { mode };
    if ((await handle.queryPermission(opts)) === "granted") return true;
    if ((await handle.requestPermission(opts)) === "granted") return true;
    return false;
  }

  async function restoreDirHandle() {
    try {
      const handle = await idbGet(IDB_DIR_KEY);
      if (!handle) return;
      const ok = await ensureDirPermission(handle, "readwrite");
      if (!ok) return;
      dirHandle = handle;
      const meta = await chrome.storage.local.get(DIR_META_KEY);
      dirLabel = meta[DIR_META_KEY]?.name || handle.name || "已选目录";
    } catch (err) {
      console.warn("恢复本地目录失败:", err);
    }
  }

  async function pickLocalDirectory() {
    if (!unlocked) {
      showToast("请先登录");
      return;
    }
    if (!window.showDirectoryPicker) {
      showToast("当前浏览器不支持选择本地目录");
      return;
    }
    try {
      const handle = await window.showDirectoryPicker({
        id: "floating-notes",
        mode: "readwrite",
        startIn: "documents",
      });
      const ok = await ensureDirPermission(handle, "readwrite");
      if (!ok) {
        showToast("未获得目录写入权限");
        return;
      }
      dirHandle = handle;
      dirLabel = handle.name;
      await idbSet(IDB_DIR_KEY, handle);
      await chrome.storage.local.set({
        [DIR_META_KEY]: { name: handle.name, boundAt: Date.now() },
      });
      await syncNotesFileToDisk();
      updateDirStatus();
      showToast(`将统一写入 ${handle.name}/${NOTES_FILE}`);
    } catch (err) {
      if (err?.name === "AbortError") return;
      console.error(err);
      showToast("选择目录失败");
    }
  }

  async function writeNotesFile(allNotes) {
    if (!dirHandle) return false;
    const ok = await ensureDirPermission(dirHandle, "readwrite");
    if (!ok) return false;

    const fileHandle = await dirHandle.getFileHandle(NOTES_FILE, { create: true });
    const writable = await fileHandle.createWritable();
    const payload = {
      updatedAt: Date.now(),
      notesByDomain: allNotes,
    };
    await writable.write(JSON.stringify(payload, null, 2));
    await writable.close();
    return true;
  }

  async function readNotesFile() {
    if (!dirHandle) return null;
    const ok = await ensureDirPermission(dirHandle, "readwrite");
    if (!ok) return null;
    try {
      const fileHandle = await dirHandle.getFileHandle(NOTES_FILE);
      const file = await fileHandle.getFile();
      const text = await file.text();
      const data = JSON.parse(text);
      if (data?.notesByDomain && typeof data.notesByDomain === "object") {
        return data.notesByDomain;
      }
      return null;
    } catch {
      return null;
    }
  }

  async function syncNotesFileToDisk() {
    if (!dirHandle) return false;
    return writeNotesFile(notesByDomain);
  }

  async function loadState() {
    const data = await chrome.storage.local.get([
      STORAGE_KEY,
      LEGACY_KEY,
      UI_KEY,
      DIR_META_KEY,
      AUTH_KEY,
    ]);

    auth = data[AUTH_KEY] || null;
    unlocked = await getSessionUnlocked();
    authView = auth ? "login" : "setup";

    if (data[STORAGE_KEY] && typeof data[STORAGE_KEY] === "object") {
      notesByDomain = data[STORAGE_KEY];
    } else if (Array.isArray(data[LEGACY_KEY])) {
      notesByDomain = {};
      for (const note of data[LEGACY_KEY]) {
        let domain = currentDomain();
        try {
          if (note.pageUrl) domain = new URL(note.pageUrl).hostname || domain;
        } catch {
          /* keep */
        }
        if (!notesByDomain[domain]) notesByDomain[domain] = [];
        notesByDomain[domain].push(note);
      }
      await chrome.storage.local.set({ [STORAGE_KEY]: notesByDomain });
      await chrome.storage.local.remove(LEGACY_KEY);
    } else {
      notesByDomain = {};
    }

    ui = {
      visible: true,
      minimized: false,
      maximized: false,
      left: null,
      top: null,
      expandedLeft: null,
      expandedTop: null,
      ...(data[UI_KEY] || {}),
    };

    dirLabel = data[DIR_META_KEY]?.name || "";
    await restoreDirHandle();

    if (unlocked) {
      const fromDisk = await readNotesFile();
      if (fromDisk) {
        notesByDomain = fromDisk;
        await chrome.storage.local.set({ [STORAGE_KEY]: notesByDomain });
      }
    }
  }

  async function saveNotes() {
    await chrome.storage.local.set({ [STORAGE_KEY]: notesByDomain });
    // 若曾绑定过目录则静默同步到单一文件，不再每次弹窗
    return syncNotesFileToDisk();
  }

  async function saveUi() {
    const rect = root?.getBoundingClientRect();
    if (rect) {
      rememberPos(Math.round(rect.left), Math.round(rect.top));
    }
    await chrome.storage.local.set({ [UI_KEY]: ui });
  }

  /** 记住最近一次窗口/圆点位置（动态，随拖动变化） */
  function rememberPos(left, top) {
    ui.left = left;
    ui.top = top;
    ui.expandedLeft = left;
    ui.expandedTop = top;
  }

  function defaultPosition() {
    const w = ui.maximized ? 420 : 320;
    const h = ui.maximized ? 560 : 380;
    return {
      left: Math.max(12, window.innerWidth - w - 24),
      top: Math.max(12, window.innerHeight - h - 24),
    };
  }

  function applyPosition() {
    if (!root) return;
    const pos =
      ui.left != null && ui.top != null
        ? { left: ui.left, top: ui.top }
        : defaultPosition();

    const size = ui.minimized ? 44 : root.offsetWidth || 320;
    const height = ui.minimized ? 44 : root.offsetHeight || 200;
    const maxLeft = Math.max(0, window.innerWidth - size);
    const maxTop = Math.max(0, window.innerHeight - height);
    const left = Math.min(Math.max(0, pos.left), maxLeft);
    const top = Math.min(Math.max(0, pos.top), maxTop);
    root.style.left = `${left}px`;
    root.style.top = `${top}px`;
    root.style.right = "auto";
    root.style.bottom = "auto";
    // 钳位后的实际位置也写回，保证下次最大/最小化一致
    ui.left = left;
    ui.top = top;
  }

  function applySizeMode() {
    if (!root) return;
    root.classList.toggle("fn-minimized", ui.minimized);
    root.classList.toggle("fn-expanded", !ui.minimized && !ui.maximized);
    root.classList.toggle("fn-maximized", !ui.minimized && ui.maximized);

    const maxBtn = root.querySelector("[data-action='maximize']");
    if (maxBtn) {
      maxBtn.textContent = ui.maximized ? "❐" : "□";
      maxBtn.title = ui.maximized ? "还原" : "放大";
    }
  }

  function updateDomainBadge() {
    const badge = root?.querySelector(".fn-domain");
    const domainText = root?.querySelector(".fn-domain-text");
    const domain = currentDomain();
    if (domainText) domainText.textContent = domain;
    if (badge) badge.title = `当前域名：${domain}（按域名分文件保存）`;
  }

  function updateDirStatus() {
    const el = root?.querySelector(".fn-dir-status");
    if (!el) return;
    if (dirHandle || dirLabel) {
      el.textContent = `文件：${NOTES_FILE}`;
      el.classList.add("fn-dir-bound");
      el.title = `统一保存在 ${dirLabel || dirHandle?.name || "本地"}/${NOTES_FILE}`;
    } else {
      el.textContent = "已存浏览器本地";
      el.classList.add("fn-dir-bound");
      el.title = "记录已自动保存；可选点 📁 额外同步到单个文件";
    }
  }

  function showToast(text) {
    const toast = root?.querySelector(".fn-toast");
    if (!toast) return;
    toast.textContent = text;
    toast.classList.add("fn-show");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.remove("fn-show"), 1600);
  }

  function setAuthError(text) {
    const el = root?.querySelector(".fn-auth-error");
    if (el) el.textContent = text || "";
  }

  function setComposerOpen(open) {
    if (!unlocked) return;
    const composer = root?.querySelector(".fn-composer");
    if (!composer) return;
    composer.hidden = !open;
    if (open) composer.querySelector(".fn-input")?.focus();
  }

  function applyAuthGate() {
    if (!root) return;
    root.classList.toggle("fn-locked", !unlocked);

    const gate = root.querySelector(".fn-auth");
    const content = root.querySelector(".fn-secure");
    if (gate) gate.hidden = unlocked;
    if (content) content.hidden = !unlocked;

    const lockBtn = root.querySelector("[data-action='lock']");
    if (lockBtn) lockBtn.hidden = !unlocked;

    if (!unlocked) {
      setComposerOpen(false);
      renderAuthView();
    }
  }

  function renderAuthView() {
    const box = root?.querySelector(".fn-auth-body");
    if (!box) return;
    setAuthError("");

    if (authView === "setup") {
      box.innerHTML = `
        <div class="fn-auth-title">设置登录密码</div>
        <p class="fn-auth-desc">首次使用请设置密码。关闭浏览器后再次打开需重新登录。</p>
        <label class="fn-auth-label">登录密码（至少 4 位）</label>
        <input class="fn-input" type="password" data-auth="password" autocomplete="new-password" maxlength="64" />
        <label class="fn-auth-label">确认密码</label>
        <input class="fn-input" type="password" data-auth="confirm" autocomplete="new-password" maxlength="64" />
        <label class="fn-auth-label">密保问题（用于重置密码）</label>
        <input class="fn-input" type="text" data-auth="recovery-q" placeholder="例如：我小学的名字？" maxlength="80" />
        <label class="fn-auth-label">密保答案</label>
        <input class="fn-input" type="text" data-auth="recovery-a" autocomplete="off" maxlength="80" />
        <button type="button" class="fn-btn fn-btn-primary" data-auth-action="setup">完成设置并进入</button>
      `;
      return;
    }

    if (authView === "reset") {
      box.innerHTML = `
        <div class="fn-auth-title">重置密码</div>
        <p class="fn-auth-desc">请回答密保问题后设置新密码。</p>
        <div class="fn-auth-question">${escapeHtml(auth?.recoveryQ || "未设置密保问题")}</div>
        <label class="fn-auth-label">密保答案</label>
        <input class="fn-input" type="text" data-auth="recovery-a" autocomplete="off" maxlength="80" />
        <label class="fn-auth-label">新密码（至少 4 位）</label>
        <input class="fn-input" type="password" data-auth="password" autocomplete="new-password" maxlength="64" />
        <label class="fn-auth-label">确认新密码</label>
        <input class="fn-input" type="password" data-auth="confirm" autocomplete="new-password" maxlength="64" />
        <button type="button" class="fn-btn fn-btn-primary" data-auth-action="reset">确认重置</button>
        <button type="button" class="fn-btn fn-btn-ghost" data-auth-action="to-login">返回登录</button>
      `;
      return;
    }

    box.innerHTML = `
      <div class="fn-auth-title">密码登录</div>
      <p class="fn-auth-desc">打开浏览器后任意网页登录一次即可，其他域名无需再登；关闭浏览器后需重新登录。</p>
      <label class="fn-auth-label">登录密码</label>
      <input class="fn-input" type="password" data-auth="password" autocomplete="current-password" maxlength="64" />
      <button type="button" class="fn-btn fn-btn-primary" data-auth-action="login">登录</button>
      <div class="fn-auth-links">
        <button type="button" class="fn-link-btn" data-auth-action="to-reset">重置密码</button>
      </div>
    `;
    box.querySelector('[data-auth="password"]')?.focus();
  }

  async function handleSetup() {
    try {
      const password = root.querySelector('[data-auth="password"]')?.value || "";
      const confirm = root.querySelector('[data-auth="confirm"]')?.value || "";
      const recoveryQ = (root.querySelector('[data-auth="recovery-q"]')?.value || "").trim();
      const recoveryA = (root.querySelector('[data-auth="recovery-a"]')?.value || "").trim();

      if (password.length < 4) {
        setAuthError("密码至少 4 位");
        return;
      }
      if (password !== confirm) {
        setAuthError("两次输入的密码不一致");
        return;
      }
      if (!recoveryQ || !recoveryA) {
        setAuthError("请填写密保问题与答案，便于日后重置");
        return;
      }

      const salt = randomSalt();
      const passwordHash = await hashSecret(password, salt);
      const recoveryHash = await hashSecret(recoveryA.toLowerCase(), salt);
      auth = {
        salt,
        passwordHash,
        recoveryQ,
        recoveryHash,
        createdAt: Date.now(),
      };
      await chrome.storage.local.set({ [AUTH_KEY]: auth });
      await setSessionUnlocked(true);
      applyAuthGate();
      renderList();
      showToast("密码已设置");
    } catch (err) {
      console.error(err);
      setAuthError("设置失败，请重试");
    }
  }

  async function handleLogin() {
    try {
      if (!auth) {
        authView = "setup";
        renderAuthView();
        return;
      }
      const password = root.querySelector('[data-auth="password"]')?.value || "";
      if (!password) {
        setAuthError("请输入密码");
        return;
      }
      const hash = await hashSecret(password, auth.salt);
      if (hash !== auth.passwordHash) {
        setAuthError("密码错误");
        return;
      }
      await setSessionUnlocked(true);
      const fromDisk = await readNotesFile();
      if (fromDisk) {
        notesByDomain = fromDisk;
        await chrome.storage.local.set({ [STORAGE_KEY]: notesByDomain });
      }
      applyAuthGate();
      renderList();
      showToast("登录成功");
    } catch (err) {
      console.error(err);
      setAuthError("登录失败（当前页面为 HTTP，已兼容处理，请重试）");
    }
  }

  async function handleReset() {
    try {
      if (!auth?.recoveryHash) {
        setAuthError("未设置密保，无法重置");
        return;
      }
      const answer = (root.querySelector('[data-auth="recovery-a"]')?.value || "").trim();
      const password = root.querySelector('[data-auth="password"]')?.value || "";
      const confirm = root.querySelector('[data-auth="confirm"]')?.value || "";

      if (!answer) {
        setAuthError("请填写密保答案");
        return;
      }
      const answerHash = await hashSecret(answer.toLowerCase(), auth.salt);
      if (answerHash !== auth.recoveryHash) {
        setAuthError("密保答案不正确");
        return;
      }
      if (password.length < 4) {
        setAuthError("新密码至少 4 位");
        return;
      }
      if (password !== confirm) {
        setAuthError("两次输入的新密码不一致");
        return;
      }

      const salt = randomSalt();
      auth = {
        ...auth,
        salt,
        passwordHash: await hashSecret(password, salt),
        recoveryHash: await hashSecret(answer.toLowerCase(), salt),
        updatedAt: Date.now(),
      };
      await chrome.storage.local.set({ [AUTH_KEY]: auth });
      await setSessionUnlocked(true);
      applyAuthGate();
      renderList();
      showToast("密码已重置");
    } catch (err) {
      console.error(err);
      setAuthError("重置失败，请重试");
    }
  }

  function renderList() {
    const list = root?.querySelector(".fn-list");
    if (!list) return;
    if (!unlocked) {
      list.innerHTML = "";
      return;
    }

    const notes = currentNotes();
    const domain = currentDomain();

    if (!notes.length) {
      list.innerHTML = `<div class="fn-empty">「${escapeHtml(domain)}」还没有记录<br/>点击右上角 ＋ 添加</div>`;
    } else {
      list.innerHTML = notes
        .map(
          (n) => `
      <article class="fn-item" data-id="${n.id}">
        <div class="fn-item-top">
          <div class="fn-item-title">${escapeHtml(n.title || "未命名")}</div>
          <button type="button" class="fn-item-del" data-del="${n.id}" title="删除">删除</button>
        </div>
        ${n.content ? `<div class="fn-item-content">${escapeHtml(n.content)}</div>` : ""}
        <div class="fn-item-time">${formatTime(n.updatedAt || n.createdAt)}</div>
      </article>`
        )
        .join("");
    }

    const count = root.querySelector(".fn-count");
    if (count) count.textContent = `${notes.length} 条`;
    updateDomainBadge();
    updateDirStatus();
  }

  function createRoot() {
    if (document.getElementById(ROOT_ID)) {
      root = document.getElementById(ROOT_ID);
      return;
    }

    root = document.createElement("div");
    root.id = ROOT_ID;
    root.innerHTML = `
      <button type="button" class="fn-dot" title="点击展开 · 拖动可移动">记</button>
      <div class="fn-panel">
        <div class="fn-header">
          <div class="fn-title-wrap">
            <div class="fn-title">悬浮记事本</div>
            <div class="fn-domain" title="">
              <span class="fn-domain-icon" aria-hidden="true">◉</span>
              <span class="fn-domain-text"></span>
            </div>
          </div>
          <button type="button" data-action="lock" title="锁定（需重新登录）" hidden>🔒</button>
          <button type="button" data-action="pick-dir" title="可选：同步到本地单个文件">📁</button>
          <button type="button" data-action="add" title="添加记录">＋</button>
          <button type="button" data-action="maximize" title="放大">□</button>
          <button type="button" data-action="minimize" title="缩成圆点">─</button>
          <button type="button" data-action="close" title="关闭">×</button>
        </div>
        <div class="fn-body">
          <div class="fn-auth" hidden>
            <div class="fn-auth-body"></div>
            <div class="fn-auth-error" role="alert"></div>
          </div>
          <div class="fn-secure" hidden>
            <div class="fn-composer" hidden>
              <input class="fn-input" name="title" type="text" placeholder="标题" maxlength="80" />
              <textarea class="fn-textarea" name="content" placeholder="记录内容…" maxlength="4000"></textarea>
              <div class="fn-composer-actions">
                <button type="button" class="fn-btn fn-btn-primary" data-action="save-note">保存</button>
                <button type="button" class="fn-btn fn-btn-ghost" data-action="cancel-compose">取消</button>
              </div>
            </div>
            <div class="fn-meta">
              <span class="fn-count">0 条</span>
              <span class="fn-dir-status">已存浏览器本地</span>
            </div>
            <div class="fn-list"></div>
          </div>
        </div>
        <div class="fn-toast"></div>
      </div>
    `;

    document.documentElement.appendChild(root);
    bindEvents();
  }

  function expandFromDot() {
    // 以圆点当前（最近一次挪动）位置为窗口左上角展开
    const rect = root.getBoundingClientRect();
    rememberPos(Math.round(rect.left), Math.round(rect.top));
    ui.minimized = false;
    applySizeMode();
    applyPosition();
    applyAuthGate();
    return saveUi();
  }

  async function saveCurrentCompose() {
    if (!unlocked) return;
    const composer = root.querySelector(".fn-composer");
    const titleInput = composer.querySelector(".fn-input");
    const contentInput = composer.querySelector(".fn-textarea");
    const title = titleInput.value.trim();
    const content = contentInput.value.trim();
    if (!title && !content) {
      showToast("请先填写内容");
      return;
    }

    const domain = currentDomain();
    const notes = currentNotes();
    notes.unshift({
      id: uid(),
      title: title || "未命名",
      content,
      domain,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pageUrl: location.href,
      pageTitle: document.title,
    });

    const written = await saveNotes();
    titleInput.value = "";
    contentInput.value = "";
    setComposerOpen(false);
    renderList();
    if (written) {
      showToast(`已保存到 ${NOTES_FILE}`);
    } else {
      showToast("已保存");
    }
  }

  function bindEvents() {
    if (!root) return;

    enableDotInteract(root.querySelector(".fn-dot"));

    root.querySelector("[data-action='minimize']")?.addEventListener("click", async () => {
      const rect = root.getBoundingClientRect();
      // 圆点落在「最近一次窗口位置」的左上角
      rememberPos(Math.round(rect.left), Math.round(rect.top));
      ui.minimized = true;
      setComposerOpen(false);
      applySizeMode();
      applyPosition();
      await saveUi();
    });

    root.querySelector("[data-action='maximize']")?.addEventListener("click", async () => {
      // 放大/还原都锚定在最近一次挪动后的左上角
      const rect = root.getBoundingClientRect();
      rememberPos(Math.round(rect.left), Math.round(rect.top));
      ui.maximized = !ui.maximized;
      applySizeMode();
      applyPosition();
      await saveUi();
    });

    root.querySelector("[data-action='close']")?.addEventListener("click", async () => {
      ui.visible = false;
      root.style.display = "none";
      await saveUi();
    });

    root.querySelector("[data-action='lock']")?.addEventListener("click", async () => {
      await setSessionUnlocked(false);
      authView = "login";
      applyAuthGate();
      showToast("已锁定");
    });

    root.querySelector("[data-action='pick-dir']")?.addEventListener("click", () => {
      if (!unlocked) {
        showToast("请先登录");
        return;
      }
      pickLocalDirectory();
    });

    root.querySelector("[data-action='add']")?.addEventListener("click", () => {
      if (!unlocked) {
        showToast("请先登录");
        return;
      }
      const composer = root.querySelector(".fn-composer");
      setComposerOpen(composer.hidden);
    });

    root.querySelector("[data-action='cancel-compose']")?.addEventListener("click", () => {
      setComposerOpen(false);
    });

    root.querySelector("[data-action='save-note']")?.addEventListener("click", () => {
      saveCurrentCompose();
    });

    root.querySelector(".fn-list")?.addEventListener("click", async (e) => {
      if (!unlocked) return;
      const btn = e.target.closest("[data-del]");
      if (!btn) return;
      const id = btn.getAttribute("data-del");
      const domain = currentDomain();
      notesByDomain[domain] = currentNotes().filter((n) => n.id !== id);
      const written = await saveNotes();
      renderList();
      showToast(written ? `已删除并更新 ${NOTES_FILE}` : "已删除");
    });

    root.querySelector(".fn-auth")?.addEventListener("click", async (e) => {
      const action = e.target.closest("[data-auth-action]")?.getAttribute("data-auth-action");
      if (!action) return;
      if (action === "setup") await handleSetup();
      if (action === "login") await handleLogin();
      if (action === "reset") await handleReset();
      if (action === "to-reset") {
        authView = "reset";
        renderAuthView();
      }
      if (action === "to-login") {
        authView = "login";
        renderAuthView();
      }
    });

    root.querySelector(".fn-auth")?.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const action =
        authView === "setup" ? "setup" : authView === "reset" ? "reset" : "login";
      const btn = root.querySelector(`[data-auth-action="${action}"]`);
      btn?.click();
    });

    enableDrag(root.querySelector(".fn-header"));
  }

  function enableDotInteract(dot) {
    if (!dot || !root) return;

    let pointerId = null;
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;
    let moved = false;
    let dragging = false;

    const onMove = (e) => {
      if (!dragging || e.pointerId !== pointerId) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!moved && Math.hypot(dx, dy) >= DRAG_THRESHOLD) {
        moved = true;
        dot.classList.add("fn-dragging");
      }
      if (!moved) return;

      const left = Math.min(Math.max(0, originLeft + dx), window.innerWidth - 44);
      const top = Math.min(Math.max(0, originTop + dy), window.innerHeight - 44);
      root.style.left = `${left}px`;
      root.style.top = `${top}px`;
    };

    const onUp = async (e) => {
      if (e.pointerId !== pointerId) return;
      dragging = false;
      pointerId = null;
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      dot.classList.remove("fn-dragging");
      try {
        dot.releasePointerCapture?.(e.pointerId);
      } catch {
        /* ignore */
      }

      if (moved) {
        const rect = root.getBoundingClientRect();
        rememberPos(Math.round(rect.left), Math.round(rect.top));
        await saveUi();
        return;
      }

      await expandFromDot();
    };

    dot.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      pointerId = e.pointerId;
      dragging = true;
      moved = false;
      startX = e.clientX;
      startY = e.clientY;
      const rect = root.getBoundingClientRect();
      originLeft = rect.left;
      originTop = rect.top;
      try {
        dot.setPointerCapture?.(e.pointerId);
      } catch {
        /* ignore */
      }
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
      document.addEventListener("pointercancel", onUp);
      e.preventDefault();
    });

    dot.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
  }

  function enableDrag(handle) {
    if (!handle || !root) return;

    let dragging = false;
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;

    const onMove = (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const width = root.offsetWidth;
      const height = root.offsetHeight;
      const left = Math.min(Math.max(0, originLeft + dx), window.innerWidth - width);
      const top = Math.min(Math.max(0, originTop + dy), window.innerHeight - height);
      root.style.left = `${left}px`;
      root.style.top = `${top}px`;
    };

    const onUp = async () => {
      if (!dragging) return;
      dragging = false;
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      const rect = root.getBoundingClientRect();
      rememberPos(Math.round(rect.left), Math.round(rect.top));
      await saveUi();
    };

    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      if (e.target.closest("button")) return;
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = root.getBoundingClientRect();
      originLeft = rect.left;
      originTop = rect.top;
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
      e.preventDefault();
    });
  }

  function refreshUi() {
    applySizeMode();
    applyPosition();
    applyAuthGate();
    updateDomainBadge();
    if (unlocked) renderList();
  }

  async function showPanel() {
    await loadState();
    createRoot();
    // 打开前再确认一次全局登录态，避免换域名重复要密码
    unlocked = await getSessionUnlocked();
    ui.visible = true;
    root.style.display = "block";
    refreshUi();
    await saveUi();
  }

  async function togglePanel() {
    await loadState();
    createRoot();
    unlocked = await getSessionUnlocked();

    if (ui.visible && root.style.display !== "none") {
      ui.visible = false;
      root.style.display = "none";
      await saveUi();
      return;
    }

    await showPanel();
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "FLOATING_NOTES_TOGGLE") {
      togglePanel().then(() => sendResponse({ ok: true }));
      return true;
    }
    if (message?.type === "FN_AUTH_CHANGED") {
      unlocked = Boolean(message.unlocked);
      authView = unlocked ? authView : "login";
      if (root) {
        applyAuthGate();
        if (unlocked) renderList();
      }
      sendResponse({ ok: true });
      return false;
    }
  });

  loadState().then(() => {
    if (ui.visible) {
      createRoot();
      root.style.display = "block";
      refreshUi();
    }
  });
})();
