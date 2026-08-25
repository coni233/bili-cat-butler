'use strict';

/* 引擎运行时测试：
 * - 从用户脚本提取 TaskEngine 及依赖，替换延迟为 0 后真实执行 _runRoom。
 * - 覆盖：基础领养、摸自己已满即停、完整流水线、指定 UID 预核对、排行榜前 N、
 *   登录失效终止、喂食零成长停止、手幅失败不标记完成。
 */
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
  let paren = 0, bracket = 0, brace = 0, inStr = null;
  for (let i = m.index; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (ch === '\\') { i++; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
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

let engineCode = [
  extractStatement('const sleep =', 'sleep'),
  extractBlock('function rand\\(', 'rand'),
  extractBlock('function clamp\\(', 'clamp'),
  extractBlock('function verdict\\(', 'verdict'),
  extractBlock('class TaskEngine ', 'TaskEngine'),
].join('\n\n');

/* 加速：随机延迟归零、_wait 内的 sleep 变空操作，让测试瞬时完成 */
engineCode = engineCode.replace('function rand(min, max) {', 'function rand(min, max) { return 0;');
engineCode = engineCode.replace('await sleep(400);', '/* noop */');
engineCode = engineCode.replace('await sleep(Math.min(400, remain));', '/* noop */');
engineCode += '\nmodule.exports = { TaskEngine };';

const moduleObj = { exports: {} };
new Function('module', 'exports', engineCode)(moduleObj, moduleObj.exports);
const { TaskEngine } = moduleObj.exports;

function makeStore(overrides) {
  const group = Object.assign({
    id: 'default', name: '默认组',
    sign: false, feed: false, petSelf: false, petRank: false, banner: false,
    rankMode: 'all', rankTopN: 20, rankUids: '', pokeTimes: 3,
  }, overrides.group || {});
  const marks = new Set();
  const store = {
    settings: { notify: false, mode: 'once', feedLimit: 60, selfPetLimit: 15, blacklist: '' },
    groups: [group],
    roomGroup: {},
    marks,
    groupFor: () => group,
    stageDone: () => false,
    markStage: (ruid, stage) => { marks.add(stage); },
    roomDone: () => false,
    enabledStages: () => [],
    bumpStats: (patch) => { store.stats = Object.assign(store.stats || { growth: 0, food: 0, pets: 0, gifts: 0 }, patch); },
    stats: { growth: 0, food: 0, pets: 0, gifts: 0 },
  };
  return Object.assign(store, overrides.store || {});
}

function makeUi() {
  const logs = [];
  return { logs, log: (lvl, msg) => logs.push(lvl + ':' + msg), sync: () => {} };
}

const session = { uid: '10086', csrf: 'csrf' };

async function run(store, api) {
  const ui = makeUi();
  const engine = new TaskEngine({ store, api, session, ui });
  await engine._runRoom({ ruid: '11111', name: '测试房间' }, false);
  return { ui, engine };
}

(async () => {
  /* 场景1：全部动作关闭 → 仅领养 + 房间总结，无错误 */
  {
    const store = makeStore({});
    const api = { adopt: async () => ({ code: 0 }) };
    const { ui, engine } = await run(store, api);
    assert.ok(ui.logs.some((l) => l.includes('[领养]')), '应执行领养');
    assert.ok(ui.logs.some((l) => l.includes('[房间]')), '应输出房间总结');
    assert.ok(!ui.logs.some((l) => l.startsWith('err')), '不应有错误');
    assert.ok(!engine._fatal, '不应有致命错误');
  }

  /* 场景2：摸自己已满（growth_delta=0）→ 只摸 1 次即停 */
  {
    let petCalls = 0;
    const store = makeStore({ group: { petSelf: true, selfPetLimit: 15 } });
    const api = {
      adopt: async () => ({ code: 0 }),
      pet: async () => { petCalls++; return { code: 0, data: { growth_delta: 0 } }; },
    };
    const { ui } = await run(store, api);
    assert.strictEqual(petCalls, 1, '成长为 0 时应只摸一次');
    assert.ok(ui.logs.some((l) => l.includes('今日成长已满')), '应输出已满日志');
    assert.ok(store.marks.has('petSelf'), '应标记摸自己完成');
  }

  /* 场景3：完整流水线（签到/喂食/摸自己/摸同担全部/手幅） */
  {
    let feedCalls = 0;
    let selfPetCalls = 0;
    let rankPetCalls = 0;
    let bannerCalls = 0;
    const foodBalance = [2, 1, 0];
    const store = makeStore({
      group: { sign: true, feed: true, petSelf: true, petRank: true, banner: true, rankMode: 'all', pokeTimes: 2 },
    });
    const api = {
      adopt: async () => ({ code: 0 }),
      sign: async () => ({ code: 0, data: { food_balance: 3 } }),
      feed: async () => {
        const fb = foodBalance[feedCalls++] != null ? foodBalance[feedCalls - 1] : 0;
        return { code: 0, data: { growth_delta: 100, food_balance: fb } };
      },
      pet: async (ruid, targetUid) => {
        if (String(targetUid) === '10086') { selfPetCalls++; return { code: 0, data: { growth_delta: 4 } }; }
        rankPetCalls++;
        return { code: 0, data: { growth_delta: 1 } };
      },
      rankCats: async () => ({ code: 0, data: { list: [{ item_id: '999', extra: '{"nick_name":"路人甲"}' }] } }),
      masterRoomId: async () => 777,
      sendBanner: async () => { bannerCalls++; return { code: 0 }; },
    };
    const { ui, engine } = await run(store, api);
    assert.strictEqual(feedCalls, 3, '余粮 2/1/0 应喂 3 次');
    assert.ok(selfPetCalls >= 12 && selfPetCalls <= 15, '摸自己应攒满 50（成长+4/次）');
    assert.strictEqual(rankPetCalls, 2, '摸同担 1 只猫 × 2 次');
    assert.strictEqual(bannerCalls, 1, '手幅应投 1 次');
    ['sign', 'feed', 'petSelf', 'petRank', 'banner'].forEach((s) => {
      assert.ok(store.marks.has(s), `应标记阶段 ${s}`);
    });
    assert.strictEqual(store.stats.food, 3);
    assert.strictEqual(store.stats.gifts, 1);
    assert.ok(!engine._fatal, '不应有致命错误');
  }

  /* 场景4：指定 UID 预核对（不在房间的不请求、不计数） */
  {
    let petCalls = 0;
    const store = makeStore({
      group: { petRank: true, rankMode: 'uid', rankUids: '999\n12345\n10086', pokeTimes: 2 },
    });
    const api = {
      adopt: async () => ({ code: 0 }),
      rankCats: async () => ({ code: 0, data: { list: [{ item_id: '999', extra: '{"nick_name":"A"}' }, { item_id: '10086', extra: '{"nick_name":"自己"}' }] } }),
      pet: async () => { petCalls++; return { code: 0, data: { growth_delta: 1 } }; },
    };
    const { ui } = await run(store, api);
    assert.strictEqual(petCalls, 2, '仅摸本房间内目标 999（2 次）');
    assert.ok(ui.logs.some((l) => l.includes('不在本房间：12345')), '应提示 12345 不在本房间');
    assert.ok(ui.logs.some((l) => l.includes('成功 1 只')), '汇总应按猫只数统计');
    assert.ok(store.marks.has('petRank'), '应标记摸同担完成');
  }

  /* 场景5：排行榜前 N 模式按 N 截断 */
  {
    let rankCalls = 0;
    let petCalls = 0;
    const items = Array.from({ length: 20 }, (_, i) => ({ item_id: String(20000 + i), extra: '{"nick_name":"猫' + i + '"}' }));
    const store = makeStore({
      group: { petRank: true, rankMode: 'top', rankTopN: 5, pokeTimes: 1 },
    });
    const api = {
      adopt: async () => ({ code: 0 }),
      rankCats: async (ruid, start, end) => { rankCalls++; return { code: 0, data: { list: items.slice(start, end + 1) } }; },
      pet: async () => { petCalls++; return { code: 0, data: { growth_delta: 1 } }; },
    };
    await run(store, api);
    assert.strictEqual(rankCalls, 1, '前 5 只只需拉一页');
    assert.strictEqual(petCalls, 5, '只摸 5 只');
    assert.ok(store.marks.has('petRank'));
  }

  /* 场景6：登录失效（-101）→ 立即终止，不再执行后续阶段 */
  {
    let feedCalls = 0;
    const store = makeStore({ group: { sign: true, feed: true } });
    const api = {
      adopt: async () => ({ code: 0 }),
      sign: async () => ({ code: -101, message: '登录已失效' }),
      feed: async () => { feedCalls++; return { code: 0, data: { food_balance: 1 } }; },
    };
    const { engine } = await run(store, api);
    assert.ok(engine._fatal, '应设置致命错误');
    assert.strictEqual(feedCalls, 0, '致命错误后不应再喂食');
    assert.ok(!store.marks.has('sign'), '登录失效不应标记完成');
  }

  /* 场景7：喂食返回 0 成长且无余粮 → 喂 1 次即停 */
  {
    let feedCalls = 0;
    const store = makeStore({ group: { feed: true } });
    const api = {
      adopt: async () => ({ code: 0 }),
      feed: async () => { feedCalls++; return { code: 0, data: { growth_delta: 0 } }; },
    };
    await run(store, api);
    assert.strictEqual(feedCalls, 1, '0 成长应只喂一次');
    assert.ok(store.marks.has('feed'), '应标记喂食完成');
  }

  /* 场景8：手幅失败 → 不标记完成、不计礼物 */
  {
    const store = makeStore({ group: { banner: true } });
    const api = {
      adopt: async () => ({ code: 0 }),
      masterRoomId: async () => 777,
      sendBanner: async () => ({ code: 1, message: '电池不足' }),
    };
    const { ui } = await run(store, api);
    assert.ok(!store.marks.has('banner'), '手幅失败不应标记完成');
    assert.strictEqual(store.stats.gifts, 0);
    assert.ok(ui.logs.some((l) => l.includes('电池不足')), '应提示失败原因');
  }

  console.log('✅ 引擎测试全部通过（8 个场景）');
})().catch((e) => {
  console.error('引擎测试失败：', e);
  process.exit(1);
});
