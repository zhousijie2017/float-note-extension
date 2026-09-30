const INJECTED_FLAG = "__floatingNotesInjected";
/** 全标签页/全域名共用的登录标记（存在 local，保证跨域可读） */
const UNLOCK_KEY = "fnBrowserUnlocked";
/** session 里的开机标记：浏览器重启后 session 会清空 */
const BOOT_KEY = "fnBrowserBoot";

let browserUnlocked = false;
let readyPromise = null;

async function bootstrap() {
  const session = await chrome.storage.session.get(BOOT_KEY);
  if (!session[BOOT_KEY]) {
    // 新的浏览器进程：清空登录态，并打上开机标记
    await chrome.storage.session.set({ [BOOT_KEY]: true });
    await chrome.storage.local.set({ [UNLOCK_KEY]: false });
    browserUnlocked = false;
    return;
  }
  const local = await chrome.storage.local.get(UNLOCK_KEY);
  browserUnlocked = Boolean(local[UNLOCK_KEY]);
}

function ensureReady() {
  if (!readyPromise) readyPromise = bootstrap();
  return readyPromise;
}

async function getUnlocked() {
  await ensureReady();
  const local = await chrome.storage.local.get(UNLOCK_KEY);
  browserUnlocked = Boolean(local[UNLOCK_KEY]);
  return browserUnlocked;
}

async function setUnlocked(value) {
  await ensureReady();
  browserUnlocked = Boolean(value);
  await chrome.storage.local.set({ [UNLOCK_KEY]: browserUnlocked });
  // 确保本次浏览器进程已标记，避免误判为新开机
  await chrome.storage.session.set({ [BOOT_KEY]: true });
}

async function broadcastAuth(unlocked) {
  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs.map((tab) =>
      tab.id
        ? chrome.tabs
            .sendMessage(tab.id, { type: "FN_AUTH_CHANGED", unlocked })
            .catch(() => {})
        : Promise.resolve()
    )
  );
}

chrome.runtime.onStartup.addListener(() => {
  readyPromise = (async () => {
    browserUnlocked = false;
    await chrome.storage.local.set({ [UNLOCK_KEY]: false });
    try {
      await chrome.storage.session.clear();
      await chrome.storage.session.set({ [BOOT_KEY]: true });
    } catch {
      /* ignore */
    }
  })();
});

ensureReady();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "FN_AUTH_GET") {
    getUnlocked()
      .then((unlocked) => sendResponse({ unlocked }))
      .catch(() => sendResponse({ unlocked: false }));
    return true;
  }

  if (message?.type === "FN_AUTH_SET") {
    const unlocked = Boolean(message.unlocked);
    setUnlocked(unlocked)
      .then(() => broadcastAuth(unlocked))
      .then(() => sendResponse({ ok: true, unlocked: browserUnlocked }))
      .catch(() => sendResponse({ ok: false, unlocked: browserUnlocked }));
    return true;
  }

  return false;
});

async function ensureContentScript(tabId) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (flag) => Boolean(window[flag]),
      args: [INJECTED_FLAG],
    });
    if (result) return;
  } catch {
    /* continue inject */
  }

  await chrome.scripting.insertCSS({
    target: { tabId },
    files: ["content.css"],
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"],
  });
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;

  if (
    tab.url?.startsWith("chrome://") ||
    tab.url?.startsWith("chrome-extension://") ||
    tab.url?.startsWith("edge://") ||
    tab.url?.startsWith("about:") ||
    tab.url?.startsWith("https://chrome.google.com/webstore") ||
    tab.url?.startsWith("https://chromewebstore.google.com")
  ) {
    console.warn("无法在此页面使用悬浮记事本");
    return;
  }

  try {
    await ensureContentScript(tab.id);
    await chrome.tabs.sendMessage(tab.id, { type: "FLOATING_NOTES_TOGGLE" });
  } catch (err) {
    console.error("悬浮记事本打开失败:", err);
  }
});
