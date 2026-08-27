'use strict';

/* UI 层测试：用 jsdom 真实加载用户脚本并模拟交互。
 * 覆盖：面板构建、登录态、自动拉取、搜索过滤、全选、新建组、批量分配、
 *       任务页开关联动、重置到默认组、无初始化错误。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const src = fs.readFileSync(path.join(__dirname, '..', 'bili-cat-butler.user.js'), 'utf8');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function boot(seed) {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'https://live.bilibili.com/21013446?live_from=82002',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const storage = Object.assign({}, seed || {});
  window.GM_addStyle = () => {};
  window.GM_getValue = (key, fallback) => (Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : fallback);
  window.GM_setValue = (key, value) => { storage[key] = value; };
  window.GM_deleteValue = (key) => { delete storage[key]; };
  window.GM_xmlhttpRequest = (opts) => {
    setTimeout(() => {
      let body = { code: 0, data: {} };
      if (opts.url.indexOf('/nav') >= 0) {
        body = { code: 0, data: { isLogin: true, mid: 10086, uname: '测试用户' } };
      } else if (opts.url.indexOf('fansMedal') >= 0) {
        body = {
          code: 0,
          data: {
            list: [
              { medal: { target_id: '11111', medal_name: '张三牌' }, anchor_info: { nick_name: '张三' } },
              { medal: { target_id: '22222', medal_name: '李四牌' }, anchor_info: { nick_name: '李四' } },
            ],
            page_info: { has_more: false },
          },
        };
      }
      if (opts.onload) opts.onload({ status: 200, responseText: JSON.stringify(body) });
    }, 5);
  };
  window.GM_notification = () => {};
  window.GM_registerMenuCommand = () => {};
  window.confirm = () => true;
  window.prompt = () => '改名组';
  const issues = [];
  window.console.error = (...a) => issues.push('ERR ' + a.join(' '));
  window.console.warn = (...a) => issues.push('WARN ' + a.join(' '));
  window.eval(src);
  return { window, storage, issues };
}

(async () => {
  const { window, issues } = boot();
  const doc = window.document;
  await wait(1300); // 登录检测 + 自动拉取

  /* 1. 面板与登录态 */
  assert.ok(doc.getElementById('mc-root'), '面板应存在');
  assert.ok(doc.querySelector('.mc-brand-sub').textContent.includes('v1.0.4'), '标题应显示版本号');
  assert.ok(doc.getElementById('mc-login-text').textContent.includes('已登录'), '登录栏应显示已登录');
  assert.ok(doc.getElementById('mc-cat-list').textContent.includes('张三'), '自动拉取后列表应有张三');

  /* 2. 搜索过滤 */
  const search = doc.getElementById('mc-search');
  search.value = '李四';
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
  let listText = doc.getElementById('mc-cat-list').textContent;
  assert.ok(listText.includes('李四') && !listText.includes('张三'), '搜索应只显示李四');
  search.value = '';
  search.dispatchEvent(new window.Event('input', { bubbles: true }));

  /* 3. 全选 */
  doc.getElementById('mc-select-page').click();
  await wait(30);
  assert.ok(doc.getElementById('mc-selected-count').textContent.includes('已选 2'), '全选应选中 2 个');

  /* 4. 新建组 */
  doc.getElementById('mc-group-add').click();
  await wait(50);
  const chips = Array.from(doc.querySelectorAll('#mc-group-chips .mc-chip'));
  assert.strictEqual(chips.length, 2, '新建组后应有 2 个组');
  const newGid = chips[1].dataset.gid;
  assert.ok(newGid, '新组应有 id');

  /* 5. 批量分配到新组 */
  const assignSelect = doc.getElementById('mc-assign-group');
  assignSelect.value = newGid;
  doc.getElementById('mc-assign-btn').click();
  await wait(50);
  const badges = Array.from(doc.querySelectorAll('#mc-cat-list .mc-group-tag')).map((t) => t.textContent);
  assert.ok(badges.length === 2 && badges.every((b) => b === chips[1].textContent), '两个房间都应显示新组名');

  /* 6. 任务页开关与摸同担面板联动（当前组） */
  chips[1].click();
  await wait(30);
  const findSwitch = (label) => Array.from(doc.querySelectorAll('#mc-opt-row .mc-switch')).find((s) => s.textContent.includes(label));
  assert.ok(findSwitch('手幅'), '应有手幅开关');
  assert.strictEqual(doc.getElementById('mc-rank-panel').hidden, true, '未勾摸同担时面板应隐藏');
  findSwitch('摸同担').querySelector('input').click();
  await wait(30);
  assert.strictEqual(doc.getElementById('mc-rank-panel').hidden, false, '勾选摸同担后应显示模式面板');

  /* 7. 重置到默认组 */
  doc.getElementById('mc-reset-group').click();
  await wait(50);
  const badges2 = Array.from(doc.querySelectorAll('#mc-cat-list .mc-group-tag')).map((t) => t.textContent);
  assert.ok(badges2.every((b) => b === '默认组'), '重置后应回到默认组');

  /* 8. 无初始化/运行错误 */
  assert.ok(!issues.some((l) => l.includes('初始化失败')), '不应有初始化失败：' + issues.join(' | '));

  /* 9. 忽略已完成：勾选后只显示未完成房间 */
  {
    const d = new Date();
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const seeded = boot({
      'miao.daily.v1': { date, rooms: { '11111': { sign: true, feed: true, petSelf: true } } },
    });
    const doc2 = seeded.window.document;
    await wait(1300);
    doc2.getElementById('mc-select-page').click();
    await wait(30);
    assert.ok(doc2.getElementById('mc-hide-done'), '应有「忽略已完成」勾选框');
    doc2.getElementById('mc-hide-done').click();
    await wait(30);
    const listText = doc2.getElementById('mc-room-list').textContent;
    assert.ok(!listText.includes('张三'), '应隐藏已完成房间（张三）');
    assert.ok(listText.includes('李四'), '应显示未完成房间（李四）');
  }

  console.log('✅ UI 测试全部通过');
})().catch((e) => {
  console.error('UI 测试失败：', e);
  process.exit(1);
});
