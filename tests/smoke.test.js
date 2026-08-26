'use strict';

/* 零依赖冒烟测试：从用户脚本中提取纯逻辑模块并断言关键行为。 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'bili-cat-butler.user.js');
const src = fs.readFileSync(file, 'utf8');

function extractBlock(pattern, label) {
  const re = new RegExp(pattern);
  const m = re.exec(src);
  if (!m) throw new Error(`找不到代码块：${label}`);
  const bodyStart = src.indexOf('{', m.index);
  if (bodyStart < 0) throw new Error(`无代码块：${label}`);
  let depth = 0;
  for (let i = bodyStart; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(m.index, i + 1);
    }
  }
  throw new Error(`代码块未闭合：${label}`);
}

function extractStatement(pattern, label) {
  const re = new RegExp(pattern);
  const m = re.exec(src);
  if (!m) throw new Error(`找不到语句：${label}`);
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  let inStr = null;
  for (let i = m.index; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inStr = ch;
      continue;
    }
    if (ch === '(') paren++;
    else if (ch === ')') paren--;
    else if (ch === '[') bracket++;
    else if (ch === ']') bracket--;
    else if (ch === '{') brace++;
    else if (ch === '}') brace--;
    else if (ch === ';' && paren === 0 && bracket === 0 && brace === 0) {
      return src.slice(m.index, i + 1);
    }
  }
  throw new Error(`语句未闭合：${label}`);
}

const parts = [
  extractStatement('const STORAGE_KEYS =', 'STORAGE_KEYS'),
  extractStatement('const STAGES =', 'STAGES'),
  extractStatement('const DEFAULT_SETTINGS =', 'DEFAULT_SETTINGS'),
  extractBlock('function today\\(', 'today'),
  extractBlock('function clamp\\(', 'clamp'),
  extractBlock('function toUid\\(', 'toUid'),
  extractBlock('function safeParse\\(', 'safeParse'),
  extractBlock('function parseCookies\\(', 'parseCookies'),
  extractBlock('function cookieFields\\(', 'cookieFields'),
  extractBlock('function verdict\\(', 'verdict'),
  extractBlock('class Store ', 'Store'),
];

const storage = {};
const gmGet = (key, fallback) =>
  Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : fallback;
const gmSet = (key, value) => {
  storage[key] = value;
};
const gmDelete = (key) => {
  delete storage[key];
};

const code = parts.join('\n\n') + `
module.exports = { Store, verdict, parseCookies, cookieFields, toUid, clamp, today, DEFAULT_SETTINGS, STAGES };
`;

const moduleObj = { exports: {} };
new Function('module', 'exports', 'GM_getValue', 'GM_setValue', 'GM_deleteValue', code)(
  moduleObj,
  moduleObj.exports,
  gmGet,
  gmSet,
  gmDelete
);
const { Store, verdict, parseCookies, cookieFields, toUid, clamp, today, DEFAULT_SETTINGS } = moduleObj.exports;

/* ---------- verdict 判定 ---------- */
assert.strictEqual(verdict({ code: 0 }).kind, 'ok');
assert.strictEqual(verdict({ code: -101 }).kind, 'fatal');
assert.strictEqual(verdict({ code: -400 }).kind, 'fatal');
assert.strictEqual(verdict({ code: 1, message: '今日已签到' }).kind, 'already');
assert.strictEqual(verdict({ code: 1, message: '猫粮不足' }).kind, 'exhausted');
assert.strictEqual(verdict({ code: 1, message: '今日摸猫次数已满' }).kind, 'capped');
assert.strictEqual(verdict({ code: 1, message: '系统繁忙' }).kind, 'transient');
assert.strictEqual(verdict({ code: 0, message: '今日摸猫次数已满' }).kind, 'capped');
assert.strictEqual(verdict({ code: 0, message: '今日已签到' }).kind, 'already');
assert.strictEqual(verdict({ code: 0, message: '猫粮不足' }).kind, 'exhausted');
assert.strictEqual(verdict({ code: 0, message: '操作频繁，请稍后再试' }).kind, 'transient');
assert.strictEqual(verdict({ code: 1 }).kind, 'fail');

/* ---------- 文本解析 ---------- */

const cookies = parseCookies('a=hello%20world; b=1');
assert.strictEqual(cookies.a, 'hello world');
assert.strictEqual(cookies.b, '1');

const fields = cookieFields('SESSDATA=x; bili_jct=csrf123; DedeUserID=10086');
assert.strictEqual(fields.csrf, 'csrf123');
assert.strictEqual(fields.uid, '10086');

/* ---------- 工具函数 ---------- */
assert.strictEqual(toUid('abc789012xyz'), '789012');
assert.strictEqual(clamp(150, 1, 100), 100);
assert.strictEqual(clamp(-5, 1, 100), 1);
assert.match(today(), /^\d{4}-\d{2}-\d{2}$/);

/* ---------- Store 数据模型 ---------- */
const store = new Store();
assert.strictEqual(store.settings.sign, true);
assert.strictEqual(store.settings.mode, 'once');
assert.strictEqual(store.groups.length, 1);
assert.strictEqual(store.enabledStages('11111').length, 3);

store.medals = [
  { ruid: '11111', target_name: '张三', medal_name: '张三牌' },
  { ruid: '22222', target_name: '李四', medal_name: '李四牌' },
];
gmSet('miao.medals.v1', store.medals);
store.toggleSelected('11111', true);
store.toggleSelected('22222', true);
assert.deepStrictEqual(store.selected, ['11111', '22222']);

store.groups[0].petSelf = false;
store.groups[0].petRank = false;
store.groups[0].banner = false;
store.saveGroups();
assert.strictEqual(store.roomDone('11111'), false);
store.markStage('11111', 'sign');
store.markStage('11111', 'feed');
assert.strictEqual(store.roomDone('11111'), true);

/* 任务分组 */
const groupB = store.addGroup('手幅组');
groupB.banner = true;
assert.strictEqual(store.groups.length, 2);
const assigned = store.assignRoomsToGroup(['22222'], groupB.id);
assert.strictEqual(assigned, 1);
assert.strictEqual(store.groupFor('22222').id, groupB.id);
assert.strictEqual(store.groupFor('11111').id, 'default');
assert.strictEqual(store.enabledStages('22222').includes('banner'), true);
assert.strictEqual(store.enabledStages('11111').includes('banner'), false);

/* 手动确认已完成：把房间所有已启用阶段标记为完成 */
const storeC = new Store();
storeC.groups = [storeC._defaultGroup()];
storeC.groups[0].banner = true;
assert.strictEqual(storeC.enabledStages('33333').length, 4);
assert.strictEqual(storeC.roomDone('33333'), false);
storeC.markRoomDone('33333');
assert.strictEqual(storeC.roomDone('33333'), true);
['sign', 'feed', 'petSelf', 'banner'].forEach((st) => {
  assert.strictEqual(storeC.stageDone('33333', st), true, `应标记阶段 ${st}`);
});
store.resetAllToDefault();
assert.strictEqual(store.groupFor('22222').id, 'default');
assert.strictEqual(store.removeGroup('default'), false, '默认组不可删除');

/* 持久化跨实例 */
const store2 = new Store();
assert.strictEqual(store2.stageDone('11111', 'feed'), true);

/* pendingRooms：今日完成 + 黑名单过滤 + 测试模式 */
assert.strictEqual(store2.pendingRooms(false).length, 1);
assert.strictEqual(store2.pendingRooms(false)[0].ruid, '22222');
store2.settings.blacklist = '李四';
assert.strictEqual(store2.pendingRooms(false).length, 0);
assert.strictEqual(store2.pendingRooms(true).length, 1);
assert.strictEqual(store2.pendingRooms(true)[0].ruid, '11111');

store2.resetToday();
assert.strictEqual(store2.roomDone('11111'), false);
assert.strictEqual(store2.stageDone('11111', 'sign'), false);

/* ---------- 分组归一化 / 回退 / 分配 ---------- */
const store3 = new Store();
store3.groups = [store3._normalizeGroup({}, 0)];
store3.groups.push(store3._normalizeGroup({ name: '测试组' }, 1));
assert.strictEqual(store3.groups[1].name, '测试组');
assert.strictEqual(store3.groups[1].id, 'g2');
assert.strictEqual(store3.groups[1].pokeTimes, 3, '缺省 pokeTimes 应为 3');
store3.roomGroup = { 11111: 'ghost' };
assert.strictEqual(store3.groupFor('11111').id, 'default', '失效组应回退默认组');
assert.strictEqual(store3.assignRoomsToGroup(['11111'], 'ghost'), 0, '不存在的组返回 0');

/* ---------- pendingRooms：黑名单 + 今日完成 ---------- */
store3.medals = [{ ruid: '11111', target_name: '甲' }, { ruid: '22222', target_name: '乙' }];
store3.toggleSelected('11111', true);
store3.toggleSelected('22222', true);
store3.settings.blacklist = '甲';
assert.deepStrictEqual(store3.pendingRooms(false).map((r) => r.ruid), ['22222'], '黑名单应过滤');

/* ---------- 统计与重置 ---------- */
store3.bumpStats({ food: 3, growth: 300 });
assert.strictEqual(store3.stats.food, 3);
store3.resetToday();
assert.strictEqual(store3.stats.food, 0);

/* ---------- cookie 边界 ---------- */
const emptyFields = cookieFields('');
assert.strictEqual(emptyFields.uid, '');
assert.strictEqual(emptyFields.csrf, '');

/* ---------- verdict 补充 ---------- */
assert.strictEqual(verdict({ code: 0, message: '已达上限' }).kind, 'capped');
assert.strictEqual(verdict({ code: -400 }).kind, 'fatal');

console.log('✅ 冒烟测试全部通过');
