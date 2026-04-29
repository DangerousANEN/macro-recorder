import { chromium } from 'playwright';
import { writeFileSync } from 'fs';

// Use Chrome's default profile to get YouTube cookies
const userDataDir = process.env.LOCALAPPDATA + '\\Google\\Chrome\\User Data';

(async () => {
  console.log('Launching Chrome with user profile...');
  const browser = await chromium.launchPersistentContext(
    userDataDir,
    { 
      headless: true, 
      channel: 'chrome',
      viewport: { width: 1280, height: 800 },
      args: ['--disable-extensions']
    }
  );
  
  const page = browser.pages()[0] || await browser.newPage();
  await page.goto('https://www.youtube.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);
  
  // Get cookies
  const cookies = await browser.cookies('https://www.youtube.com');
  console.log(`Got ${cookies.length} cookies`);
  
  // Convert to Netscape cookies.txt format
  let txt = '# Netscape HTTP Cookie File\n';
  for (const c of cookies) {
    const domain = c.domain.startsWith('.') ? c.domain : '.' + c.domain;
    const flag = domain.startsWith('.') ? 'TRUE' : 'FALSE';
    const secure = c.secure ? 'TRUE' : 'FALSE';
    const expires = c.expires > 0 ? Math.floor(c.expires) : 0;
    txt += `${domain}\t${flag}\t${c.path}\t${secure}\t${expires}\t${c.name}\t${c.value}\n`;
  }
  
  writeFileSync('F:\\Downloads\\yt-cookies.txt', txt);
  console.log('Saved to F:\\Downloads\\yt-cookies.txt');
  
  await browser.close();
})();
