'use strict';

/* 布局测试：用无头 Chrome 渲染面板（叠加 t.bilibili 裸标签干扰样式），
 * 断言 main 不溢出、开关与空提示完整在面板内。
 * 找不到 Chrome/Edge 时自动跳过（不视为失败）。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const chrome = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
if (!chrome) {
  console.log('⚠️ 未找到 Chrome/Edge，跳过布局测试（可运行 npm run test:layout 单独触发）。');
  process.exit(0);
}

const src = fs.readFileSync(path.join(__dirname, '..', 'bili-cat-butler.user.js'), 'utf8');
const panelHtml = src.match(/const PANEL_HTML = `([\s\S]*?)`;\n/)[1];
const css = src.match(/const CSS = `([\s\S]*?)`;\n/)[1];
const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'tbili-bare.css'), 'utf8');

const switches = [
  '<label class="mc-switch"><input type="checkbox" data-key="sign" checked=""><span>签到</span></label>',
  '<label class="mc-switch"><input type="checkbox" data-key="feed" checked=""><span>喂食</span></label>',
  '<label class="mc-switch"><input type="checkbox" data-key="petSelf" checked=""><span>摸自己</span></label>',
  '<label class="mc-switch"><input type="checkbox" data-key="petRank"><span>摸同担</span></label>',
  '<label class="mc-switch"><input type="checkbox" data-key="banner"><span>手幅·1电池</span></label>',
].join('');

const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>${fixture}</style>
<style>${css}</style>
</head>
<body>
${panelHtml}
<pre id="diag" style="position:fixed;left:0;top:0;z-index:999999;background:#fff;color:#000;font-size:10px;max-height:60vh;overflow:auto;"></pre>
<script>
window.addEventListener('load', function () {
  setTimeout(function () {
    document.getElementById('mc-cat-list').innerHTML = '<div class="mc-empty">没有匹配结果，换个关键词试试</div>';
    document.getElementById('mc-opt-row').innerHTML = '${switches}';
    var root = document.getElementById('mc-root');
    function rect(el) { var r = el.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width) }; }
    var panelR = rect(root);
    var switchesEls = Array.prototype.slice.call(document.querySelectorAll('.mc-switch'));
    var diag = {
      viewport: innerWidth,
      panel: panelR,
      mainFits: rect(document.querySelector('.mc-main')).r <= panelR.r,
      switchesAllInside: switchesEls.every(function (s) { return rect(s).r <= panelR.r; }),
      emptyInside: rect(document.querySelector('.mc-empty')).r <= panelR.r
    };
    document.getElementById('diag').textContent = 'MIAO-DIAG ' + JSON.stringify(diag);
  }, 600);
});
</script>
</body></html>`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-butler-layout-'));
const htmlPath = path.join(dir, 'layout.html');
fs.writeFileSync(htmlPath, html, 'utf8');

const profile = path.join(dir, 'profile');
const args = [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
  `--user-data-dir=${profile}`,
  '--window-size=900,900',
  '--virtual-time-budget=6000',
  '--dump-dom',
  'file:///' + htmlPath.replace(/\\/g, '/'),
];
const res = spawnSync(chrome, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const dump = res.stdout || '';
const m = dump.match(/MIAO-DIAG (\{.*\})/);
assert.ok(m, '应输出布局诊断，stderr=' + String(res.stderr || '').slice(0, 300));
const diag = JSON.parse(m[1]);
assert.strictEqual(diag.mainFits, true, 'main 不应超出面板宽度');
assert.strictEqual(diag.emptyInside, true, '空提示文字不应被截断');
assert.strictEqual(diag.switchesAllInside, true, '开关（含手幅·1电池）不应超出面板');
console.log('✅ 布局测试通过（含 t.bilibili 裸标签干扰回归）');
