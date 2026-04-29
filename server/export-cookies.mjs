import WebSocket from 'ws';
import { writeFileSync } from 'fs';

const ws = new WebSocket('ws://127.0.0.1:18800/devtools/page/B34A805BD2859D2148063A0CC51575A9');
ws.on('open', () => {
  ws.send(JSON.stringify({ id: 1, method: 'Network.getAllCookies', params: {} }));
});
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.id === 1) {
    const cookies = msg.result?.cookies || [];
    const yt = cookies.filter(c => c.domain.includes('youtube') || c.domain.includes('google'));
    console.log(`Total: ${cookies.length}, YT/Google: ${yt.length}`);
    
    let txt = '# Netscape HTTP Cookie File\n';
    for (const c of yt) {
      const dom = c.domain.startsWith('.') ? c.domain : '.' + c.domain;
      const sec = c.secure ? 'TRUE' : 'FALSE';
      const exp = c.expires > 0 ? Math.floor(c.expires) : 0;
      txt += `${dom}\tTRUE\t${c.path}\t${sec}\t${exp}\t${c.name}\t${c.value}\n`;
    }
    
    writeFileSync('F:\\Downloads\\yt-cookies.txt', txt);
    console.log('Saved to F:\\Downloads\\yt-cookies.txt');
    ws.close();
    process.exit(0);
  }
});
ws.on('error', (e) => { console.log('Error:', e.message); process.exit(1); });
