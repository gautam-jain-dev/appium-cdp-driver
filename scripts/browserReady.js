import log from '../src/logger.js';

/**
 * Shared readiness helper for the skip-welcome-* scripts.
 *
 * The scripts clear the browser profile and then click through first-run
 * onboarding. That choreography is inherently racy: dialog order and content
 * vary per launch, some stages are conditional, and an Android system dialog
 * (e.g. "System UI isn't responding") can cover the screen entirely. When it
 * goes wrong the browser never opens its devtools socket and session creation
 * fails later with "socket hang up" or "Debug list is empty or invalid".
 *
 * Instead of requiring a fixed sequence, converge on the end state the driver
 * actually needs: the browser's own devtools socket, with onboarding gone and a
 * page open. Dismiss whatever happens to be on screen, relaunch when stuck, and
 * report honestly if it never becomes ready.
 */

const ONBOARDING_ACTIVITY = /Welcome|FirstRun|firstrun|Onboarding|HelpIntro/i;

// Safe to click on first-run and system dialogs, in priority order. "Wait" is
// first so an ANR dialog is cleared before anything underneath it is touched.
const COMMON_SELECTORS = [
  '//android.widget.Button[@text="Wait"]',
  '//android.widget.Button[@text="OK"]',
  '//android.widget.Button[@text="Continue"]',
  '//android.widget.Button[@text="Next"]',
  '//android.widget.Button[@text="Skip"]',
  '//android.widget.Button[@text="Not now"]',
  '//android.widget.Button[@text="Allow"]',
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function socketPresent(adb, socket, pkg, pidScoped) {
  const unix = String(await adb.adbExec(['shell', 'cat', '/proc/net/unix']));
  if (!pidScoped) {
    return unix.includes(socket);
  }
  // WebView-based browsers expose webview_devtools_remote_<pid>; the bare prefix
  // also matches other apps' WebViews, so scope it to this package's pid.
  const pid = String(await adb.adbExec(['shell', 'pidof', pkg])).trim().split(/\s+/)[0];
  return Boolean(pid) && unix.includes(`${socket}_${pid}`);
}

async function currentActivity(driver) {
  try {
    return String(await driver.getCurrentActivity());
  } catch (e) {
    return '';
  }
}

async function openPage(adb, pkg, url) {
  await adb.adbExec(['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', url, pkg]);
}

/**
 * @param {object} opts
 * @param {object} opts.driver     UiAutomator2 driver used for the walkthrough
 * @param {object} opts.adb        appium-adb instance
 * @param {string} opts.pkg        browser package name
 * @param {string} opts.socket     devtools socket name (see DEVTOOLS_SOCKET_MAP)
 * @param {boolean} [opts.pidScoped]  socket name is suffixed with the pid (WebView apps)
 * @param {string[]} [opts.selectors] browser-specific selectors, tried before the common ones
 * @param {string} [opts.url]      page to open once the socket is up
 * @param {number} [opts.attempts]
 * @returns {Promise<boolean>} whether the browser became ready
 */
export async function ensureBrowserReady(opts) {
  const {
    driver, adb, pkg, socket,
    pidScoped = false,
    selectors = [],
    url = 'https://www.appium.io',
    attempts = 12,
    intervalMs = 2500,
  } = opts;
  const candidates = [...selectors, ...COMMON_SELECTORS];

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      // The process (and its socket) can exist while onboarding is still on
      // screen; with no tab open /json/list is empty, which is the "Debug list
      // is empty" failure. Require both, then open a page.
      const activity = await currentActivity(driver);
      if (ONBOARDING_ACTIVITY.test(activity)) {
        log.info(`ensureBrowserReady: still on onboarding (${activity})`);
      } else if (await socketPresent(adb, socket, pkg, pidScoped)) {
        await openPage(adb, pkg, url);
        await sleep(4000);
        return true;
      }
    } catch (e) {
      // fall through to the dismissal pass
    }

    let clicked = null;
    for (const selector of candidates) {
      try {
        const element = await driver.findElement('xpath', selector);
        await driver.click(element.ELEMENT);
        clicked = selector;
        break;
      } catch (e) {
        // selector not present — try the next one
      }
    }

    if (clicked) {
      log.info(`ensureBrowserReady: dismissed ${clicked}`);
    } else if (attempt % 3 === 2) {
      log.info(`ensureBrowserReady: nothing to dismiss, relaunching ${pkg}`);
      try {
        await openPage(adb, pkg, url);
      } catch (e) {
        // browser may still be starting
      }
    }
    await sleep(intervalMs);
  }
  return false;
}

/**
 * Click an element without letting a stale/handled element abort the rest of the
 * walkthrough — the screen often changes under it.
 */
export async function clickSafely(driver, element) {
  try {
    await driver.click(element.ELEMENT);
  } catch (error) {
    log.info(`click failed, continuing: ${error.message}`);
  }
}

/**
 * Close out a skip-welcome script: make the browser ready, always release the
 * UiAutomator2 session, and fail loudly if the browser cannot serve a session.
 * Without the throw, a script that dismissed nothing still exits 0 and the
 * caller starts a session that is doomed to fail.
 */
export async function finishSession(driver, opts) {
  const ready = await ensureBrowserReady({ driver, ...opts });
  log.info(`${opts.pkg} devtools ready: ${ready}`);
  try {
    await driver.deleteSession();
  } catch (e) {
    log.info(`deleteSession failed: ${e.message}`);
  }
  if (!ready) {
    throw new Error(`${opts.pkg}: devtools socket never became available; the browser cannot serve a session`);
  }
}
