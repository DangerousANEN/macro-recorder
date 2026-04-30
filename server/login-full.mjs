import { chromium } from 'playwright';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';

const PHONE = process.argv[2];
const PROFILE = process.argv[3] || 'tg-acc1';
const PROFILE_DIR = `F:\\ANEN\\Desktop\\macro-recorder-debug\\data\\profiles\\${PROFILE}`;
const SHOTS = 'F:\\ANEN\\Desktop\\macro-recorder-debug\\data\\.tmp';
const CODE_FILE = `${SHOTS}/${PROFILE}-code.txt`;

if (!PHONE) { console.log('Usage: node login-full.mjs <phone> [profile]'); process.exit(1); }

// Clean up code file
try { unlinkSync(CODE_FILE); } catch(e) {}

(async () => {
  console.log(`Profile: ${PROFILE}, Phone: ${PHONE}`);
  const browser = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false, viewport: { width: 1280, height: 800 }
  });
  const page = browser.pages()[0] || await browser.newPage();
  
  await page.goto('https://web.telegram.org/a/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  console.log('Telegram loaded');
  await page.waitForTimeout(5000);
  
  // Click "Log in by phone Number" - try multiple selectors
  let clicked = false;
  for (const sel of [
    'text=Log in by phone Number',
    'text=LOG IN BY PHONE NUMBER', 
    'a:has-text("phone")',
    'button:has-text("phone")',
    'text=Войти по номеру телефона',
    'text=ВОЙТИ ПО НОМЕРУ ТЕЛЕФОНА',
  ]) {
    const link = page.locator(sel).first();
    if (await link.isVisible({ timeout: 2000 }).catch(() => false)) {
      await link.click();
      console.log(`Clicked: ${sel}`);
      clicked = true;
      await page.waitForTimeout(2000);
      break;
    }
  }
  if (!clicked) {
    // Maybe need to wait for QR page to fully load first
    console.log('Phone link not found, waiting more...');
    await page.waitForTimeout(5000);
    // Try again
    for (const sel of ['text=Log in by phone Number', 'text=LOG IN BY PHONE NUMBER', 'a:has-text("phone")', 'text=Войти по номеру телефона']) {
      const link = page.locator(sel).first();
      if (await link.isVisible({ timeout: 3000 }).catch(() => false)) {
        await link.click();
        console.log(`Clicked (retry): ${sel}`);
        clicked = true;
        await page.waitForTimeout(2000);
        break;
      }
    }
  }
  if (!clicked) {
    // Dump all links/buttons for debug
    const links = await page.locator('a, button').allInnerTexts();
    console.log('Available links/buttons:', JSON.stringify(links));
  }
  
  // Find phone input
  const phoneInput = page.locator('input#sign-in-phone-number').first();
  if (!await phoneInput.isVisible({ timeout: 5000 }).catch(() => false)) {
    console.log('ERROR: No phone input!');
    await page.screenshot({ path: `${SHOTS}/${PROFILE}-error.png` });
    await browser.close();
    process.exit(1);
  }
  
  // Enter phone (field has +7 prefix)
  await phoneInput.click();
  await page.keyboard.press('End');
  await page.waitForTimeout(200);
  const currentVal = await phoneInput.inputValue().catch(() => '');
  let toType = PHONE.startsWith('+7') ? PHONE.slice(2) : PHONE;
  if (currentVal.replace(/\s/g, '').endsWith(toType.slice(0, 3))) {
    toType = toType.slice(3); // some digits already there
  }
  for (const ch of toType) {
    await page.keyboard.type(ch, { delay: 80 });
  }
  const finalVal = await phoneInput.inputValue().catch(() => '');
  console.log(`Phone: ${finalVal}`);
  
  // Click Next
  const nextBtn = page.locator('button:has-text("Next")').first();
  if (await nextBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await nextBtn.click();
  } else {
    await phoneInput.press('Enter');
  }
  console.log('Submitted, waiting for code...');
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${SHOTS}/${PROFILE}-waiting.png` });
  
  // Poll for code file
  console.log(`Write code to: ${CODE_FILE}`);
  console.log('READY_FOR_CODE');
  
  for (let i = 0; i < 300; i++) { // 5 minutes
    if (existsSync(CODE_FILE)) {
      const code = readFileSync(CODE_FILE, 'utf8').trim();
      if (code) {
        console.log(`Got code: ${code}`);
        for (const d of code) {
          await page.keyboard.type(d, { delay: 150 });
        }
        await page.waitForTimeout(5000);
        await page.screenshot({ path: `${SHOTS}/${PROFILE}-after-code.png` });
        
        // Check 2FA
        const pwdInput = page.locator('input[type="password"]');
        if (await pwdInput.isVisible({ timeout: 3000 }).catch(() => false)) {
          console.log('2FA_REQUIRED');
          // Wait for password file
          const PWD_FILE = `${SHOTS}/${PROFILE}-pwd.txt`;
          for (let j = 0; j < 300; j++) {
            if (existsSync(PWD_FILE)) {
              const pwd = readFileSync(PWD_FILE, 'utf8').trim();
              await pwdInput.fill(pwd);
              await page.keyboard.press('Enter');
              await page.waitForTimeout(5000);
              break;
            }
            await new Promise(r => setTimeout(r, 1000));
          }
        }
        
        console.log('LOGIN_COMPLETE');
        await page.waitForTimeout(5000);
        await page.screenshot({ path: `${SHOTS}/${PROFILE}-final.png` });
        await browser.close();
        process.exit(0);
      }
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  
  console.log('TIMEOUT - no code received');
  await browser.close();
  process.exit(1);
})();
