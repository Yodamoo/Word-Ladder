// Renders Rungs ad assets from stage.html with headless Chrome.
//   node render.js images            -> out/images/*.png
//   node render.js frames <w> <h> <name> [fps] -> out/frames/<name>/%05d.png
//   node render.js still <w> <h> <t> -> out/still_<w>x<h>_<t>.png (video frame check)
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const STAGE = 'file:///' + path.join(__dirname, 'stage.html').replace(/\\/g, '/');
const OUT = path.join(__dirname, 'out');

async function page(browser, w, h) {
  const p = await browser.newPage();
  await p.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
  await p.goto(`${STAGE}?w=${w}&h=${h}&cut=${process.env.CUT || 'climb'}`, { waitUntil: 'networkidle0' });
  const fonts = await p.evaluate(() => window.ready);
  if (!fonts.some(f => f.includes('Space Grotesk')) || !fonts.some(f => f.includes('JetBrains'))) throw new Error('fonts missing: ' + fonts);
  return p;
}

(async () => {
  const [mode, ...args] = process.argv.slice(2);
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--force-color-profile=srgb', '--hide-scrollbars'] });
  try {
    if (mode === 'images') {
      const dir = path.join(OUT, 'images'); fs.mkdirSync(dir, { recursive: true });
      const sizes = { square: [1200, 1200], landscape: [1200, 628], portrait: [1200, 1500] };
      for (const [lay, [w, h]] of Object.entries(sizes)) {
        const p = await page(browser, w, h);
        await p.evaluate(() => window.fitFor(false));
        for (const scene of ['solved', 'challenge', 'daily']) {
          await p.evaluate(s => window.renderScene(s), scene);
          const file = path.join(dir, `rungs_${lay}_${scene}_${w}x${h}.png`);
          await p.screenshot({ path: file });
          console.log(file);
        }
        await p.close();
      }
    } else if (mode === 'scene') {
      const [w, h] = args.slice(0, 2).map(Number); const scene = args[2]; const file = args[3];
      const p = await page(browser, w, h);
      await p.evaluate(s => window.renderScene(s), scene);
      await p.screenshot({ path: file }); console.log(file);
    } else if (mode === 'still') {
      const [w, h, t] = args.map(Number);
      const p = await page(browser, w, h);
      await p.evaluate(t => window.renderAt(t), t);
      const file = path.join(OUT, `still_${w}x${h}_${t}.png`);
      fs.mkdirSync(OUT, { recursive: true });
      await p.screenshot({ path: file }); console.log(file);
    } else if (mode === 'frames') {
      const [w, h] = args.slice(0, 2).map(Number); const name = args[2]; const fps = +(args[3] || 30);
      const dir = path.join(OUT, 'frames', name); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
      const p = await page(browser, w, h);
      const dur = await p.evaluate(() => window.DUR);
      const n = Math.round(dur * fps);
      for (let i = 0; i < n; i++) {
        await p.evaluate(t => window.renderAt(t), i / fps);
        await p.screenshot({ path: path.join(dir, String(i).padStart(5, '0') + '.png') });
      }
      console.log(`${n} frames -> ${dir}`);
    }
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
