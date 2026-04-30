import { chromium } from 'playwright';

const CODE = process.argv[2];
const PROFILE = process.argv[3] || 'tg-acc1';
const PROFILE_DIR = `F:\\ANEN\\Desktop\\macro-recorder-debug\\data\\profiles\\${PROFILE}`;
const SHOTS = 'F:\\ANEN\\Desktop\\macro-recorder-debug\\data\\.tmp';

if (!CODE) { console.log('Usage: node enter-code.mjs <code> [profile]'); process.exit(1); }

(async () => {
  console.log(`Opening profile ${PROFILE}, entering code ${CODE}`);
  const browser = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false, viewport: { width: 1280, height: 800 }
  });
  const page = browser.pages()[0] || await browser.newPage();
  
  // Telegram should still be on code-entry screen
  await page.waitForTimeout(2000);
  const url = page.url();
  console.log('URL:', url);
  await page.screenshot({ path: `${SHOTS}/${PROFILE}-before-code.png` });
  
  // Type code
  console.log(`Typing code: ${CODE}`);
  for (const d of CODE) {
    await page.keyboard.type(d, { delay: 150 });
  }
  
  await page.waitForTimeout(5000);
  await page.screenshot({ path: `${SHOTS}/${PROFILE}-after-code.png` });
  
  // Check for 2FA
  const pwdInput = page.locator('input[type="password"]');
  if (await pwdInput.isVisible({ timeout: 3000 }).catch(() => false)) {
    console.log('2FA PASSWORD REQUIRED!');
  } else {
    console.log('Login seems complete!');
  }
  
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${SHOTS}/${PROFILE}-final.png` });
  console.log('DONE');
  
  await browser.close();
})();
