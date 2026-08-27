'use strict';

/* 引擎运行时测试：
 * - 从用户脚本提取 TaskEngine 及依赖，替换延迟为 0 后真实执行 _runRoom。
 * - 覆盖：基础领养、摸自己 0 成长重试/已满判定、完整流水线、指定 UID 预核对、排行榜前 N、
 *   登录失效终止、喂食零成长停止、手幅失败不标记完成、手幅成功后自动补喂回馈猫粮。
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
  extractStatement('const PET_ZERO_COOLDOWN =', 'PET_ZERO_COOLDOWN'),
  extractStatement('const PET_ZERO_LIMIT =', 'PET_ZERO_LIMIT'),
  extractStatement('const MAX_TASK_PASSES =', 'MAX_TASK_PASSES'),
  extractStatement('const REDO_WAIT_RANGE =', 'REDO_WAIT_RANGE'),
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
    markRoomDone: (ruid) => { store.enabledStages(ruid).forEach((s) => marks.add(s)); },
    _petGrowth: 0,
    petSelfGrowth: () => store._petGrowth || 0,
    setPetSelfGrowth: (ruid, gained) => { store._petGrowth = gained; },
    roomDone: () => false,
    enabledStages: () => [],
    selectedRooms: () => [],
    pendingRooms: () => [],
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

  /* 场景2：摸自己返回 0 成长且无“已满”消息 → 重试 3 次后停止，不标记完成 */
  {
    let petCalls = 0;
    const store = makeStore({ group: { petSelf: true, selfPetLimit: 15 } });
    const api = {
      adopt: async () => ({ code: 0 }),
      pet: async () => { petCalls++; return { code: 0, data: { growth_delta: 0 } }; },
    };
    const { ui } = await run(store, api);
    assert.strictEqual(petCalls, 6, '0 成长无明确消息时应先退避重试 5 次（共 6 次请求）');
    assert.ok(ui.logs.some((l) => l.includes('连续 5 次未返回成长')), '应输出重试后停止的日志');
    assert.ok(!store.marks.has('petSelf'), '未确认已满时不应标记摸自己完成');
  }

  /* 场景2b：摸自己返回明确“已满”消息 → 1 次即停并标记完成 */
  {
    let petCalls = 0;
    const store = makeStore({ group: { petSelf: true, selfPetLimit: 15 } });
    const api = {
      adopt: async () => ({ code: 0 }),
      pet: async () => { petCalls++; return { code: 0, message: '今日摸猫次数已达上限', data: { growth_delta: 0 } }; },
    };
    const { ui } = await run(store, api);
    assert.strictEqual(petCalls, 1, '明确已满时应只摸一次');
    assert.ok(ui.logs.some((l) => l.includes('今日摸猫次数已达上限')), '应输出已满原因');
    assert.ok(store.marks.has('petSelf'), '明确已满应标记完成');
  }

  /* 场景2c：摸自己先返回 0 成长后恢复 → 应继续摸并攒满 50 */
  {
    let petCalls = 0;
    const store = makeStore({ group: { petSelf: true, selfPetLimit: 15 } });
    const api = {
      adopt: async () => ({ code: 0 }),
      pet: async () => {
        petCalls++;
        if (petCalls <= 2) return { code: 0, data: { growth_delta: 0 } };
        return { code: 0, data: { growth_delta: 10 } };
      },
    };
    await run(store, api);
    assert.strictEqual(petCalls, 7, '2 次 0 成长后应恢复（重试 2 次 + 成功 5 次 = 7 次请求）');
    assert.ok(store.marks.has('petSelf'), '攒满 50 后应标记完成');
    assert.strictEqual(store.stats.growth, 50, '累计成长应为 50');
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
    assert.strictEqual(feedCalls, 4, '余粮 2/1/0 应喂 3 次，手幅回馈后再自动补喂 1 次');
    assert.ok(selfPetCalls >= 12 && selfPetCalls <= 15, '摸自己应攒满 50（成长+4/次）');
    assert.strictEqual(rankPetCalls, 2, '摸同担 1 只猫 × 2 次');
    assert.strictEqual(bannerCalls, 1, '手幅应投 1 次');
    ['sign', 'feed', 'petSelf', 'petRank', 'banner'].forEach((s) => {
      assert.ok(store.marks.has(s), `应标记阶段 ${s}`);
    });
    assert.strictEqual(store.stats.food, 4);
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

  /* 场景8：手幅失败 → 不标记完成、不计礼物、不自动喂食 */
  {
    let feedCalls = 0;
    const store = makeStore({
      group: { banner: true, feed: true },
      store: { stageDone: (r, s) => s === 'feed' },
    });
    const api = {
      adopt: async () => ({ code: 0 }),
      masterRoomId: async () => 777,
      sendBanner: async () => ({ code: 1, message: '电池不足' }),
      feed: async () => { feedCalls++; return { code: 0, data: { food_balance: 0 } }; },
    };
    const { ui } = await run(store, api);
    assert.ok(!store.marks.has('banner'), '手幅失败不应标记完成');
    assert.strictEqual(store.stats.gifts, 0);
    assert.strictEqual(feedCalls, 0, '手幅失败不应自动喂食');
    assert.ok(ui.logs.some((l) => l.includes('电池不足')), '应提示失败原因');
  }

  /* 场景8b：手幅成功后即使喂食已完成，也自动补喂消耗回馈猫粮 */
  {
    let feedCalls = 0;
    let bannerCalls = 0;
    const store = makeStore({
      group: { feed: true, banner: true },
      store: { stageDone: (r, s) => s === 'feed' },
    });
    const api = {
      adopt: async () => ({ code: 0 }),
      masterRoomId: async () => 777,
      sendBanner: async () => { bannerCalls++; return { code: 0 }; },
      feed: async () => {
        feedCalls++;
        return { code: 0, data: { growth_delta: 5, food_balance: 0 } };
      },
    };
    const { ui } = await run(store, api);
    assert.strictEqual(bannerCalls, 1, '手幅应投 1 次');
    assert.strictEqual(feedCalls, 1, '喂食已完成时，手幅回馈的 1 猫粮应补喂 1 次');
    assert.ok(store.marks.has('banner'), '应标记手幅完成');
    assert.strictEqual(store.stats.food, 1, '补喂应计入猫粮消耗统计');
    assert.strictEqual(store.stats.growth, 5, '补喂应计入成长统计');
    assert.ok(ui.logs.some((l) => l.includes('回馈猫粮')), '应提示手幅回馈猫粮');
  }

  /* 场景8c：手幅成功但未勾选喂食 → 不自动喂食 */
  {
    let feedCalls = 0;
    const store = makeStore({ group: { banner: true } });
    const api = {
      adopt: async () => ({ code: 0 }),
      masterRoomId: async () => 777,
      sendBanner: async () => ({ code: 0 }),
      feed: async () => { feedCalls++; return { code: 0, data: { food_balance: 0 } }; },
    };
    const { ui } = await run(store, api);
    assert.strictEqual(feedCalls, 0, '未勾选喂食不应自动喂');
    assert.ok(store.marks.has('banner'), '手幅成功应标记完成');
    assert.strictEqual(store.stats.gifts, 1, '应计入礼物统计');
    assert.ok(ui.logs.some((l) => l.includes('已投喂')), '应输出投喂成功日志');
  }

  /* 场景9：摸自己首轮被限流 → 自动补做一轮（只补摸自己），直到攒满 50 */
  {
    let petCalls = 0;
    let adoptCalls = 0;
    const store = makeStore({
      group: { petSelf: true, selfPetLimit: 15 },
      store: {
        roomDone: () => store.marks.has('petSelf'),
        selectedRooms: () => (store.marks.has('petSelf') ? [] : [{ ruid: '11111', name: '测试房间' }]),
        pendingRooms: () => (store.marks.has('petSelf') ? [] : [{ ruid: '11111', name: '测试房间' }]),
      },
    });
    const api = {
      adopt: async () => { adoptCalls++; return { code: 0 }; },
      pet: async () => {
        petCalls++;
        if (petCalls <= 6) return { code: 0, data: { growth_delta: 0 } };
        return { code: 0, data: { growth_delta: 10 } };
      },
    };
    const ui = makeUi();
    const engine = new TaskEngine({
      store,
      api,
      session: { uid: '10086', csrf: 'csrf', refresh: async () => ({ uid: '10086', name: '测试用户' }) },
      ui,
    });
    await engine.start({ testMode: false });
    assert.strictEqual(petCalls, 11, '首轮 6 次退避失败后，补做轮 5 次成功');
    assert.strictEqual(adoptCalls, 1, '补做轮只补摸自己，不应重复领养/签到等');
    assert.ok(store.marks.has('petSelf'), '补做成功后应标记完成');
    assert.ok(ui.logs.some((l) => l.includes('补做')), '应有补做日志');
  }

  /* 场景10：始终 0 成长 → 首轮 + 1 次快速补做后不再重试，保持未完成 */
  {
    let petCalls = 0;
    const store = makeStore({
      group: { petSelf: true, selfPetLimit: 15 },
      store: {
        roomDone: () => store.marks.has('petSelf'),
        selectedRooms: () => (store.marks.has('petSelf') ? [] : [{ ruid: '11111', name: '测试房间' }]),
        pendingRooms: () => (store.marks.has('petSelf') ? [] : [{ ruid: '11111', name: '测试房间' }]),
      },
    });
    const api = {
      adopt: async () => ({ code: 0 }),
      pet: async () => { petCalls++; return { code: 0, data: { growth_delta: 0 } }; },
    };
    const ui = makeUi();
    const engine = new TaskEngine({
      store,
      api,
      session: { uid: '10086', csrf: 'csrf', refresh: async () => ({ uid: '10086', name: '测试用户' }) },
      ui,
    });
    await engine.start({ testMode: false });
    assert.strictEqual(petCalls, 12, '首轮 6 次 + 补做轮 6 次，最多两轮即停');
    assert.ok(!store.marks.has('petSelf'), '始终 0 成长不应标记完成');
    assert.strictEqual(ui.logs.filter((l) => l.includes('补做')).length, 1, '最多只补做一次');
    assert.ok(ui.logs.some((l) => l.includes('不会自动重试')), '单次模式应提示不会自动重试');
    assert.ok(ui.logs.some((l) => l.includes('今日已满或暂不可摸')), '未完成提示应说明可能原因');
  }

  /* 场景11：手动确认完成 → 标记未完成阶段并更新房间状态 */
  {
    const store = makeStore({
      group: { petSelf: true },
      store: { enabledStages: () => ['petSelf'] },
    });
    const ui = makeUi();
    const engine = new TaskEngine({ store, api: {}, session, ui });
    engine._roomStates.set('11111', 'failed');
    engine.confirmRoomDone('11111');
    assert.ok(store.marks.has('petSelf'), '应标记摸自己完成');
    assert.strictEqual(engine.roomState('11111'), 'done', '房间状态应更新为已完成');
  }

  /* 场景12：首轮摸到部分成长后被限流 → 补做轮从累计值继续，攒满 50 即完成 */
  {
    let petCalls = 0;
    const store = makeStore({
      group: { petSelf: true, selfPetLimit: 15 },
      store: {
        roomDone: () => store.marks.has('petSelf'),
        selectedRooms: () => (store.marks.has('petSelf') ? [] : [{ ruid: '11111', name: '测试房间' }]),
        pendingRooms: () => (store.marks.has('petSelf') ? [] : [{ ruid: '11111', name: '测试房间' }]),
      },
    });
    const api = {
      adopt: async () => ({ code: 0 }),
      pet: async () => {
        petCalls++;
        if (petCalls <= 3) return { code: 0, data: { growth_delta: 10 } };
        if (petCalls <= 9) return { code: 0, data: { growth_delta: 0 } };
        return { code: 0, data: { growth_delta: 10 } };
      },
    };
    const ui = makeUi();
    const engine = new TaskEngine({
      store,
      api,
      session: { uid: '10086', csrf: 'csrf', refresh: async () => ({ uid: '10086', name: '测试用户' }) },
      ui,
    });
    await engine.start({ testMode: false });
    assert.strictEqual(petCalls, 11, '3 次成功 + 6 次 0 成长退避 + 补做轮 2 次成功（累计 50 即停）');
    assert.ok(store.marks.has('petSelf'), '补做轮累计到 50 后应标记完成');
    assert.ok(ui.logs.some((l) => l.includes('累计 50/50')), '日志应显示累计 50 成长');
    assert.ok(ui.logs.some((l) => l.includes('今日已累计 30/50')), '补做轮开始应提示已累计 30');
  }

  const total = (fs.readFileSync(__filename, 'utf8').match(/\/\* 场景/g) || []).length;
  console.log(`✅ 引擎测试全部通过（${total} 个场景）`);
})().catch((e) => {
  console.error('引擎测试失败：', e);
  process.exit(1);
});
