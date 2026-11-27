// Regenerate the README images from figures.html.
// Requires Playwright with Chromium (not a dependency of this package):
//   npx -y playwright@1 install chromium
//   NODE_PATH=$(npm root -g) node docs/images/src/render.cjs   # or with playwright installed locally
// The numbers and messages in figures.html come from `npm run example:home`; update both together.
const path = require('node:path');
const {chromium} = require('playwright');

(async () => {
  const outDir = path.resolve(__dirname, '..');
  const browser = await chromium.launch();
  const page = await browser.newPage({viewport: {width: 1100, height: 900}, deviceScaleFactor: 2});
  await page.goto('file://' + path.join(__dirname, 'figures.html'), {waitUntil: 'networkidle'});
  await page.evaluate(() => document.fonts.ready);
  for (const id of ['hero', 'terminal', 'gate']) {
    await page.locator(`#${id}`).screenshot({path: path.join(outDir, `${id}.png`), omitBackground: true});
    console.log(`wrote docs/images/${id}.png`);
  }
  await browser.close();
})();
