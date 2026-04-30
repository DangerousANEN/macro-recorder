import { chromium } from 'playwright';
import { createInterface } from 'readline';

const PHONE = process.argv[2] || '+79538014766';
const PROFILE = process.argv[3] || 'tg-acc1';
const PROFILE_DIR = `F:\\ANEN\\Desktop\\macro-recorder-debug\\data\\profiles\\${PROFILE}`;
const SHOTS = 'F:\\ANEN\\Desktop\\macro-recorder-debug\\data\\.tmp';

(async () => {
  console.log(`Opening profile: ${PROFILE}, phone: ${PHONE}`);
  const browser = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 800 }
  });
  const page = browser.pages()[0] || await browser.newPage();
  
  await page.goto('https://web.telegram.org/a/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  console.log('Telegram loaded');
  await page.waitForTimeout(5000);
  
  // Click "Log in by phone Number" link
  const phoneLoginLink = page.locator('text=Log in by phone Number').first();
  if (await phoneLoginLink.isVisible({ timeout: 5000 }).catch(() => false)) {
    await phoneLoginLink.click();
    console.log('Clicked "Log in by phone Number"');
    await page.waitForTimeout(2000);
  }
  
  // Find phone input - try multiple selectors
  let phoneInput = null;
  for (const sel of ['input[type="tel"]', 'input#sign-in-phone-number', 'input[inputmode="tel"]', 'input.form-control']) {
    const el = page.locator(sel).first();
    if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
      phoneInput = el;
      console.log(`Found phone input: ${sel}`);
      break;
    }
  }
  
  // If still not found, try label
  if (!phoneInput) {
    const byLabel = page.getByLabel('phone number', { exact: false }).first();
    if (await byLabel.isVisible({ timeout: 2000 }).catch(() => false)) {
      phoneInput = byLabel;
      console.log('Found by label');
    }
  }
  
  // Last resort - find any input on the page
  if (!phoneInput) {
    const inputs = page.locator('input');
    const count = await inputs.count();
    console.log(`Found ${count} inputs total`);
    for (let i = 0; i < count; i++) {
      const inp = inputs.nth(i);
      const visible = await inp.isVisible().catch(() => false);
      const type = await inp.getAttribute('type').catch(() => '?');
      const id = await inp.getAttribute('id').catch(() => '?');
      const ph = await inp.getAttribute('placeholder').catch(() => '?');
      console.log(`  input[${i}]: type=${type}, id=${id}, placeholder=${ph}, visible=${visible}`);
      if (visible && !phoneInput) phoneInput = inp;
    }
  }
  
  if (!phoneInput) {
    console.log('No phone input found!');
    await page.screenshot({ path: `${SHOTS}/${PROFILE}-no-input.png` });
    await new Promise(() => {});
    return;
  }
  
  console.log('Entering phone number...');
  await phoneInput.click();
  await page.waitForTimeout(500);
  
  // Field already has +7, just move to end and type the local part
  await page.keyboard.press('End');
  await page.waitForTimeout(200);
  
  // Get current value to check what's prefilled
  const currentVal = await phoneInput.inputValue().catch(() => '');
  console.log(`Current field value: "${currentVal}"`);
  
  // Strip matching prefix from our number
  let toType = PHONE;
  if (currentVal && PHONE.startsWith(currentVal.replace(/\s/g, ''))) {
    toType = PHONE.slice(currentVal.replace(/\s/g, '').length);
  } else if (PHONE.startsWith('+7') && currentVal.includes('+7')) {
    toType = PHONE.replace(/^\+7/, '');
  }
  
  console.log(`Typing: "${toType}"`);
  for (const ch of toType) {
    await page.keyboard.type(ch, { delay: 80 });
  }
  
  const finalVal = await phoneInput.inputValue().catch(() => '');
  console.log(`Final value: "${finalVal}"`);
  await page.waitForTimeout(1000);
  
  // Click Next
  const nextBtn = page.locator('button:has-text("Next")').first();
  if (await nextBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await nextBtn.click();
    console.log('Clicked Next');
  } else {
    await phoneInput.press('Enter');
    console.log('Pressed Enter');
  }
  
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${SHOTS}/${PROFILE}-code-wait.png` });
  console.log('=== WAITING FOR CODE ===');
  console.log('Type the code here:');
  
  const rl = createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    const code = line.trim();
    if (!code) return;
    console.log(`Entering code: ${code}`);
    
    for (const digit of code) {
      await page.keyboard.type(digit, { delay: 150 });
    }
    
    await page.waitForTimeout(5000);
    await page.screenshot({ path: `${SHOTS}/${PROFILE}-after-code.png` });
    
    // Check for 2FA
    const pwdInput = page.locator('input[type="password"]');
    if (await pwdInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      console.log('2FA PASSWORD REQUIRED! Type it:');
      return;
    }
    
    console.log('Login complete! Saving profile...');
    await page.waitForTimeout(3000);
    await page.screenshot({ path: `${SHOTS}/${PROFILE}-final.png` });
    console.log('DONE! Profile saved.');
  });
})();
