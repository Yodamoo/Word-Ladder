// Renders the Cow Tippers YouTube profile picture and banner from channel.html.
//   node channel.js <outDir>
const puppeteer = require('puppeteer-core');
const path = require('path');
const URL = 'file:///' + path.join(__dirname, 'channel.html').split(path.sep).join('/');
(async () => {
  const b = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--force-color-profile=srgb'] });
  const out = process.argv[2];
  for (const [kind, w, h, name] of [['pfp', 800, 800, 'cowtippers-youtube-profile-800.png'], ['banner', 2560, 1440, 'cowtippers-youtube-banner-2560x1440.png']]) {
    const p = await b.newPage();
    await p.setViewport({ width: w, height: h });
    await p.goto(`${URL}?kind=${kind}&w=${w}&h=${h}`);
    await p.evaluate(() => window.ready);
    await p.screenshot({ path: path.join(out, name) });
    console.log(name);
  }
  await b.close();
})();
