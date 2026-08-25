// ==UserScript==
// @name         猫咪养成助手
// @namespace    https://github.com/coni233/bili-cat-butler
// @homepageURL  https://github.com/coni233/bili-cat-butler
// @supportURL   https://github.com/coni233/bili-cat-butler/issues
// @license      MIT
// @version      1.0.1
// @description  开源的 B 站直播养猫自动化工具：签到 / 喂食 / 摸自己 / 摸同担（全部/前N/指定UID）/ 投喂手幅。全新界面与任务引擎，零自动关注、纯本地存储、可审计。
// @author       coni
// @match        https://live.bilibili.com/*
// @match        https://t.bilibili.com/*
// @connect      api.live.bilibili.com
// @connect      api.bilibili.com
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// @grant        GM_cookie
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*!
 * 猫咪养成助手 (Bili Cat Butler)
 *
 * - 不包含任何自动关注、自动加好友等“投毒”行为；
 * - 所有数据仅保存在本机 Tampermonkey 存储中；
 * - 仅调用 B 站养猫活动公开接口，未对页面做任何注入。
 *
 * 安全承诺：本脚本不会修改你的关注列表、不会收集个人信息、不包含远程配置。
 */

(function () {
  'use strict';

  /* 脚本版本：优先读取管理器提供的版本号，测试环境回退到内置值 */
  const SCRIPT_VERSION = (typeof GM_info !== 'undefined' && GM_info && GM_info.script && GM_info.script.version) || '1.0.1';

  /* ===================== 事实常量（B 站活动接口参数） ===================== */
  const ACTIVITY = Object.freeze({
    id: 110505,          // 养猫活动 id
    rankId: 300155,      // 猫咪排行榜 id
    catType: 2,          // 领养的猫类型
    bannerGiftId: 35469, // 粉丝手幅礼物 id
    bannerPrice: 100,    // 单价（电池）
    bannerGiftNum: 1,
  });

  const API = Object.freeze({
    nav: 'https://api.bilibili.com/x/web-interface/nav',
    medalPanel: 'https://api.live.bilibili.com/xlive/app-ucenter/v1/fansMedal/panel',
    masterInfo: 'https://api.live.bilibili.com/live_user/v1/Master/info',
    roomInfo: 'https://api.live.bilibili.com/room/v1/Room/getRoomInfoOld',
    activity: 'https://api.live.bilibili.com/xlive/custom-activity-interface/activities2026',
    rank: 'https://api.live.bilibili.com/xlive/custom-activity-interface/baseActivity/Rank',
    gift: 'https://api.live.bilibili.com/xlive/revenue/v1/gift/sendGold',
  });

  const ACTIONS = Object.freeze({
    adopt: 'Q3FansS1MiaoZaiSelectCat',
    sign: 'Q3FansS1MiaoZaiSignIn',
    feed: 'Q3FansS1MiaoZaiFeedCat',
    pet: 'Q3FansS1MiaoZaiPetCat',
  });

  const STORAGE_KEYS = Object.freeze({
    settings: 'miao.settings.v1',
    selected: 'miao.selected.v1',
    medals: 'miao.medals.v1',
    custom: 'miao.custom.v1',
    daily: 'miao.daily.v1',
    stats: 'miao.stats.v1',
    ui: 'miao.ui.v1',
    groups: 'miao.groups.v1',
    roomGroup: 'miao.roomGroup.v1',
  });

  const STAGES = Object.freeze(['sign', 'feed', 'petSelf', 'petRank', 'banner']);

  const DEFAULT_SETTINGS = Object.freeze({
    mode: 'once',         // once | cruise
    cruiseMinutes: 240,
    sign: true,
    feed: true,
    feedLimit: 60,        // 单个房间单轮喂食次数安全上限
    petSelf: true,
    selfPetLimit: 15,
    petRank: false,
    rankMode: 'all',      // all | top | uid
    rankTopN: 20,
    rankUids: '',
    pokeTimes: 3,         // 每只他人猫咪抚摸次数
    banner: false,
    blacklist: '',
    notify: true,
  });

  /* 摸猫容错：单次 0 成长/瞬时返回后的短冷却（毫秒，控制在 10 秒内） */
  const PET_ZERO_COOLDOWN = [5000, 8000];
  /* 连续无成长达到该次数即停止本轮（不标记完成，留给后续运行重试） */
  const PET_ZERO_LIMIT = 5;
  /* 单次运行最多轮数（首轮 + 最多 1 轮快速补做） */
  const MAX_TASK_PASSES = 2;
  /* 补做轮之间的冷却范围（毫秒，控制在 10 秒内） */
  const REDO_WAIT_RANGE = [8000, 10000];

  /* ===================== 基础工具 ===================== */
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function rand(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function today() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function toUid(value) {
    return String(value == null ? '' : value).replace(/\D/g, '');
  }

  function safeParse(value, fallback) {
    if (value == null) return fallback;
    if (typeof value === 'object') return value;
    try {
      return JSON.parse(value);
    } catch (e) {
      return fallback;
    }
  }

  function parseCookies(str) {
    const out = {};
    String(str || '').split(';').forEach((part) => {
      const idx = part.indexOf('=');
      if (idx < 0) return;
      const key = part.slice(0, idx).trim();
      if (!key) return;
      try {
        out[key] = decodeURIComponent(part.slice(idx + 1).trim());
      } catch (e) {
        out[key] = part.slice(idx + 1).trim();
      }
    });
    return out;
  }

  function cookieFields(cookieStr) {
    const c = parseCookies(cookieStr);
    return {
      uid: c.DedeUserID || '',
      csrf: c.bili_jct || '',
      sessdata: c.SESSDATA || '',
    };
  }


  function gmNotify(title, text) {
    try {
      if (typeof GM_notification === 'function') {
        GM_notification({ title, text, timeout: 6000 });
      }
    } catch (e) {
      /* 忽略通知失败 */
    }
  }

  function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('请求超时')), ms);
      promise.then(
        (value) => { clearTimeout(timer); resolve(value); },
        (err) => { clearTimeout(timer); reject(err); }
      );
    });
  }

  /* ===================== 存储与数据模型 ===================== */
  class Store {
    constructor() {
      this.settings = Object.assign({}, DEFAULT_SETTINGS, safeParse(GM_getValue(STORAGE_KEYS.settings, null), {}));
      const sel = safeParse(GM_getValue(STORAGE_KEYS.selected, []), []);
      this.selected = Array.isArray(sel) ? sel.map(String) : [];
      const medals = safeParse(GM_getValue(STORAGE_KEYS.medals, []), []);
      this.medals = Array.isArray(medals) ? medals : [];
      GM_deleteValue(STORAGE_KEYS.custom);
      this.daily = this._loadDaily();
      this.stats = this._loadStats();
      this.groups = this._loadGroups();
      this.roomGroup = safeParse(GM_getValue(STORAGE_KEYS.roomGroup, {}), {});
      if (!this.roomGroup || typeof this.roomGroup !== 'object') this.roomGroup = {};
    }

    _defaultGroup() {
      const s = this.settings;
      return {
        id: 'default',
        name: '默认组',
        sign: !!s.sign,
        feed: !!s.feed,
        petSelf: !!s.petSelf,
        petRank: !!s.petRank,
        banner: !!s.banner,
        rankMode: s.rankMode || 'all',
        rankTopN: Number(s.rankTopN) || 20,
        rankUids: String(s.rankUids || ''),
        pokeTimes: Number(s.pokeTimes) || 3,
      };
    }

    _normalizeGroup(g, index) {
      const d = this._defaultGroup();
      return Object.assign({}, d, {
        id: String(g.id || (index === 0 ? 'default' : 'g' + (index + 1))),
        name: String(g.name || (index === 0 ? '默认组' : '组' + (index + 1))),
        sign: !!g.sign,
        feed: !!g.feed,
        petSelf: !!g.petSelf,
        petRank: !!g.petRank,
        banner: !!g.banner,
        rankMode: ['all', 'top', 'uid'].includes(g.rankMode) ? g.rankMode : 'all',
        rankTopN: clamp(Number(g.rankTopN) || 20, 1, 999),
        rankUids: String(g.rankUids || ''),
        pokeTimes: clamp(Number(g.pokeTimes) || 3, 1, 9),
      });
    }

    _loadGroups() {
      const raw = safeParse(GM_getValue(STORAGE_KEYS.groups, null), null);
      if (Array.isArray(raw) && raw.length) {
        const groups = raw.map((g, i) => this._normalizeGroup(g, i));
        GM_setValue(STORAGE_KEYS.groups, groups);
        return groups;
      }
      const groups = [this._defaultGroup()];
      GM_setValue(STORAGE_KEYS.groups, groups);
      return groups;
    }

    saveGroups() {
      GM_setValue(STORAGE_KEYS.groups, this.groups);
    }

    saveRoomGroup() {
      GM_setValue(STORAGE_KEYS.roomGroup, this.roomGroup);
    }

    groupFor(ruid) {
      const gid = this.roomGroup[String(ruid)];
      return this.groups.find((g) => g.id === gid) || this.groups[0];
    }

    assignRoomsToGroup(ruids, gid) {
      if (!this.groups.some((g) => g.id === gid)) return 0;
      let n = 0;
      ruids.forEach((r) => {
        const key = String(r);
        if (this.roomGroup[key] !== gid) {
          this.roomGroup[key] = gid;
          n++;
        }
      });
      if (n) this.saveRoomGroup();
      return n;
    }

    addGroup(name) {
      const gid = 'g' + Date.now().toString(36);
      const g = this._defaultGroup();
      g.id = gid;
      g.name = String(name || '新组');
      this.groups.push(g);
      this.saveGroups();
      return g;
    }

    removeGroup(gid) {
      if (this.groups.length <= 1) return false;
      if (gid === this.groups[0].id) return false;
      const idx = this.groups.findIndex((g) => g.id === gid);
      if (idx < 0) return false;
      this.groups.splice(idx, 1);
      Object.keys(this.roomGroup).forEach((ruid) => {
        if (this.roomGroup[ruid] === gid) delete this.roomGroup[ruid];
      });
      this.saveGroups();
      this.saveRoomGroup();
      return true;
    }

    renameGroup(gid, name) {
      const g = this.groups.find((x) => x.id === gid);
      if (!g) return false;
      g.name = String(name || g.name);
      this.saveGroups();
      return true;
    }

    resetAllToDefault() {
      const defaultId = this.groups[0].id;
      let n = 0;
      Object.keys(this.roomGroup).forEach((ruid) => {
        if (this.roomGroup[ruid] !== defaultId) {
          delete this.roomGroup[ruid];
          n++;
        }
      });
      if (n) this.saveRoomGroup();
      return n;
    }

    _loadDaily() {
      const d = GM_getValue(STORAGE_KEYS.daily, null);
      if (d && d.date === today() && d.rooms && typeof d.rooms === 'object') return d;
      const fresh = { date: today(), rooms: {} };
      GM_setValue(STORAGE_KEYS.daily, fresh);
      return fresh;
    }

    _loadStats() {
      const s = GM_getValue(STORAGE_KEYS.stats, null);
      if (s && s.date === today()) return s;
      const fresh = { date: today(), growth: 0, food: 0, pets: 0, gifts: 0 };
      GM_setValue(STORAGE_KEYS.stats, fresh);
      return fresh;
    }

    saveSettings() {
      GM_setValue(STORAGE_KEYS.settings, this.settings);
    }

    saveSelected() {
      GM_setValue(STORAGE_KEYS.selected, this.selected);
    }


    toggleSelected(ruid, force) {
      const key = String(ruid);
      const has = this.selected.includes(key);
      if (force === true && !has) this.selected.push(key);
      else if (force === false && has) this.selected = this.selected.filter((r) => r !== key);
      else if (force === undefined) {
        this.selected = has
          ? this.selected.filter((r) => r !== key)
          : this.selected.concat(key);
      }
      this.saveSelected();
    }

    clearSelected() {
      this.selected = [];
      this.saveSelected();
    }

    stageDone(ruid, stage) {
      const rec = this.daily.rooms[String(ruid)];
      return !!(rec && rec[stage]);
    }

    markStage(ruid, stage) {
      const key = String(ruid);
      if (!this.daily.rooms[key]) this.daily.rooms[key] = {};
      this.daily.rooms[key][stage] = true;
      GM_setValue(STORAGE_KEYS.daily, this.daily);
    }

    enabledStages(ruid) {
      const g = this.groupFor(ruid);
      return STAGES.filter((k) => g[k]);
    }

    roomDone(ruid) {
      const required = this.enabledStages(ruid);
      return required.length > 0 && required.every((k) => this.stageDone(ruid, k));
    }

    resetToday() {
      this.daily = { date: today(), rooms: {} };
      this.stats = { date: today(), growth: 0, food: 0, pets: 0, gifts: 0 };
      GM_setValue(STORAGE_KEYS.daily, this.daily);
      GM_setValue(STORAGE_KEYS.stats, this.stats);
    }

    bumpStats(patch) {
      Object.assign(this.stats, patch);
      GM_setValue(STORAGE_KEYS.stats, this.stats);
    }

    allRooms() {
      const byUid = new Map();
      this.medals.forEach((m) => {
        const ruid = String(m.ruid || m.target_id || '');
        if (!ruid) return;
        byUid.set(ruid, {
          ruid,
          name: (m.target_name || '未知主播'),
          medal: m.medal_name || '',
          source: 'medal',
        });
      });
      return Array.from(byUid.values());
    }

    selectedRooms() {
      const all = this.allRooms();
      return this.selected.map((ruid) => all.find((r) => r.ruid === ruid)).filter(Boolean);
    }

    blacklistKeywords() {
      return String(this.settings.blacklist || '')
        .split(/[,，;；]/)
        .map((k) => k.trim())
        .filter(Boolean);
    }

    pendingRooms(testMode) {
      const keywords = this.blacklistKeywords();
      const picked = this.selectedRooms().filter((r) =>
        !keywords.some((k) => r.name.includes(k) || r.ruid.includes(k))
      );
      if (testMode) return picked.slice(0, 1);
      return picked.filter((r) => !this.roomDone(r.ruid));
    }
  }

  /* ===================== 登录会话 ===================== */
  class Session {
    constructor() {
      this.info = null;
      this.cookieStr = '';
      this.fields = { uid: '', csrf: '', sessdata: '' };
      this._cookieAt = 0;
      this.api = null;
    }

    get csrf() {
      return this.fields.csrf || '';
    }

    get uid() {
      return this.info ? String(this.info.uid) : this.fields.uid;
    }

    _cookieList() {
      return new Promise((resolve) => {
        let settled = false;
        const finish = (list) => {
          if (settled) return;
          settled = true;
          resolve(Array.isArray(list) ? list : []);
        };
        try {
          if (typeof GM_cookie === 'undefined' || !GM_cookie || typeof GM_cookie.list !== 'function') {
            finish([]);
            return;
          }
          let ret;
          try {
            ret = GM_cookie.list({ url: location.href }, (cookies, err) => {
              if (Array.isArray(cookies)) finish(cookies);
              else if (Array.isArray(err)) finish(err);
              else finish([]);
            });
          } catch (e) {
            finish([]);
            return;
          }
          if (ret && typeof ret.then === 'function') {
            ret.then((list) => finish(list), () => finish([]));
          }
          setTimeout(() => finish([]), 4000);
        } catch (e) {
          finish([]);
        }
      });
    }

    async readCookies(force) {
      const now = Date.now();
      if (!force && this.cookieStr && now - this._cookieAt < 5 * 60 * 1000) return this.cookieStr;
      let list = await this._cookieList();
      if (!list.length) {
        list = Object.entries(parseCookies(document.cookie)).map(([name, value]) => ({ name, value }));
      }
      this.cookieStr = list.map((c) => `${c.name}=${c.value}`).join('; ');
      this.fields = cookieFields(this.cookieStr);
      this._cookieAt = now;
      return this.cookieStr;
    }

    async refresh(force) {
      const cookieStr = await this.readCookies(!!force);
      this.info = null;
      this.lastError = null;
      try {
        const res = await withTimeout(this.api.nav(cookieStr), 15000);
        if (res && res.code === 0 && res.data && res.data.isLogin) {
          this.info = {
            uid: String(res.data.mid),
            name: res.data.uname || 'B站用户',
          };
        } else if (res) {
          this.lastError = new Error((res.message || 'nav 返回异常') + `（code=${res.code}）`);
        }
      } catch (e) {
        this.lastError = e;
        console.warn('[猫咪养成助手] 登录态检测请求失败：', e && e.message);
      }
      if (!this.info && this.fields.uid && this.fields.csrf) {
        this.info = { uid: this.fields.uid, name: `用户${this.fields.uid.slice(-4)}`, offline: true };
      }
      return this.info;
    }
  }

  /* ===================== API 客户端 ===================== */
  class ApiClient {
    constructor(session) {
      this.session = session;
    }

    _request(method, url, options) {
      const opt = options || {};
      const host = (() => {
        try {
          return new URL(url).hostname;
        } catch (e) {
          return '';
        }
      })();
      const origin = host === 'api.bilibili.com' ? 'https://www.bilibili.com' : 'https://live.bilibili.com';
      const headers = {
        Accept: 'application/json, text/plain, */*',
        'Content-Type': opt.form ? 'application/x-www-form-urlencoded' : 'application/json',
        Origin: origin,
        Referer: opt.referer || origin + '/',
      };
      Object.assign(headers, opt.headers || {});
      const cookieStr = opt.cookie || this.session.cookieStr;
      if (cookieStr) headers.Cookie = cookieStr;
      const data = opt.form || (opt.json ? JSON.stringify(opt.json) : undefined);

      return new Promise((resolve, reject) => {
        if (typeof GM_xmlhttpRequest !== 'function') {
          reject(new Error('GM_xmlhttpRequest 不可用，请确认在 Tampermonkey 中运行本脚本'));
          return;
        }
        GM_xmlhttpRequest({
          method,
          url,
          headers,
          data,
          timeout: opt.timeout || 20000,
          withCredentials: true,
          onload(res) {
            if (res.status < 200 || res.status >= 300) {
              reject(new Error(`HTTP ${res.status}`));
              return;
            }
            try {
              resolve(JSON.parse(res.responseText));
            } catch (e) {
              reject(new Error('响应解析失败'));
            }
          },
          onerror() {
            reject(new Error('网络错误'));
          },
          ontimeout() {
            reject(new Error('请求超时'));
          },
        });
      });
    }

    nav(cookie) {
      return this._request('GET', API.nav, { referer: 'https://www.bilibili.com/', cookie });
    }

    medals(page) {
      return this._request('GET', `${API.medalPanel}?page=${page}&page_size=50`, {
        referer: 'https://link.bilibili.com/p/center/index',
      });
    }

    async masterRoomId(ruid) {
      try {
        const res = await this._request('GET', `${API.masterInfo}?uid=${encodeURIComponent(ruid)}`);
        if (res && res.code === 0 && res.data && res.data.room_id) return res.data.room_id;
      } catch (e) {
        /* 走备用接口 */
      }
      const res = await this._request('GET', `${API.roomInfo}?mid=${encodeURIComponent(ruid)}`);
      if (res && res.code === 0 && res.data && res.data.roomid) return res.data.roomid;
      throw new Error('未找到该主播的直播间');
    }

    rankCats(ruid, start, end) {
      const dim = encodeURIComponent(JSON.stringify({ ruid: String(ruid) }));
      return this._request(
        'GET',
        `${API.rank}?act_id=${ACTIVITY.id}&rank_id=${ACTIVITY.rankId}&front_rank_type=3&dimension_v2=${dim}&start=${start}&end=${end}`
      );
    }

    _act(action, body, csrf) {
      return this._request('POST', `${API.activity}/${action}?csrf=${encodeURIComponent(csrf)}`, {
        json: body,
      });
    }

    adopt(ruid, csrf) {
      return this._act(ACTIONS.adopt, { act_id: ACTIVITY.id, ruid: String(ruid), cat_type: ACTIVITY.catType }, csrf);
    }

    sign(ruid, csrf) {
      return this._act(ACTIONS.sign, { act_id: ACTIVITY.id, ruid: String(ruid) }, csrf);
    }

    feed(ruid, myUid, csrf) {
      return this._act(ACTIONS.feed, { act_id: ACTIVITY.id, ruid: String(ruid), target_uid: String(myUid) }, csrf);
    }

    pet(ruid, targetUid, csrf) {
      return this._act(ACTIONS.pet, { act_id: ACTIVITY.id, ruid: String(ruid), target_uid: String(targetUid) }, csrf);
    }

    sendBanner(payload) {
      const form = new URLSearchParams({
        uid: String(payload.uid),
        ruid: String(payload.ruid),
        send_ruid: '0',
        gift_id: String(ACTIVITY.bannerGiftId),
        gift_num: String(ACTIVITY.bannerGiftNum),
        price: String(ACTIVITY.bannerPrice),
        biz_id: String(payload.roomId),
        biz_code: 'live',
        storm_beat_id: '0',
        metadata: '',
        coin_type: 'gold',
        platform: 'pc',
        csrf: payload.csrf,
        csrf_token: payload.csrf,
        rnd: String(Math.floor(Date.now() / 1000)),
      }).toString();
      return this._request('POST', API.gift, {
        form,
        referer: `https://live.bilibili.com/${payload.roomId}`,
      });
    }
  }

  /* ===================== 接口返回判定 ===================== */
  function verdict(res) {
    const code = res && res.code;
    const msg = String((res && res.message) || '');
    if (code === -101 || code === -400) return { kind: 'fatal', msg };
    if (/(已签到|今日已签|重复签到|already)/i.test(msg)) return { kind: 'already', msg };
    if (/(猫粮|猫食|食物|口粮)/.test(msg) && /(不足|没有|不够|耗尽|用完|为零|=0)/.test(msg)) {
      return { kind: 'exhausted', msg };
    }
    if (/(上限|已满|次数已满|已达上限|今日已满|不能再|次数用完|已用完)/.test(msg)) return { kind: 'capped', msg };
    if (/(频繁|太快|稍后|冷却|休息|繁忙|限流|风控|操作过快)/.test(msg)) return { kind: 'transient', msg };
    if (code === 0) return { kind: 'ok', msg };
    if (/(次数|上限|已满|达到|冷却|今日|今天|不能|无法)/.test(msg)) return { kind: 'capped', msg };
    return { kind: 'fail', msg: msg || '未知返回' };
  }

  /* ===================== 任务引擎 ===================== */
  class TaskEngine {
    constructor(deps) {
      this.store = deps.store;
      this.api = deps.api;
      this.session = deps.session;
      this.ui = deps.ui;
      this._running = false;
      this._paused = false;
      this._stopping = false;
      this._fatal = null;
      this._roomStates = new Map();
    }

    get running() {
      return this._running;
    }

    get paused() {
      return this._paused;
    }

    roomState(ruid) {
      const key = String(ruid);
      if (this._roomStates.has(key)) return this._roomStates.get(key);
      return this.store.roomDone(key) ? 'done' : 'idle';
    }

    async start(options) {
      const opt = options || {};
      const testMode = !!opt.testMode;
      if (this._running) {
        this.ui.log('warn', '任务已在运行中。');
        return;
      }
      this._running = true;
      this._stopping = false;
      this._paused = false;
      this._fatal = null;
      this.ui.sync();

      try {
        const info = await this.session.refresh();
        if (!info) {
          this.ui.log('err', '未检测到 B 站登录态，请先登录 bilibili.com 再运行。');
          return;
        }
        if (!this.session.csrf) {
          this.ui.log('err', '缺少 CSRF 令牌（bili_jct），请重新登录 B 站后刷新页面。');
          return;
        }
        this.ui.log('ok', `已登录：${info.name}${info.offline ? '（本地 Cookie 判定）' : ''}`);

        for (;;) {
          const roundResult = await this._round(testMode);
          if (testMode || this._stopping || this._fatal) break;
          if (!roundResult.processed) {
            this.ui.log('ok', '所有已选房间今日任务均已完工，巡航自动结束（明天再运行即可）。');
            break;
          }
          if (this.store.settings.mode === 'cruise') {
            const mins = clamp(Number(this.store.settings.cruiseMinutes) || 240, 5, 720);
            this.ui.log('info', `巡航模式：${mins} 分钟后开始下一轮（今日已完成项目会自动跳过）`);
            await this._wait(mins * 60 * 1000);
          } else {
            break;
          }
        }

        if (this._fatal) {
          this.ui.log('err', `⛔ 登录态失效：${this._fatal.message}，任务已停止。`);
          if (this.store.settings.notify) gmNotify('猫咪养成助手', '登录态失效，任务已停止，请重新登录 B 站。');
        } else if (this._stopping) {
          this.ui.log('warn', '已停止，进度已保存在本地。');
        } else {
          const unfinished = this.store.selectedRooms().filter((r) => !this.store.roomDone(r.ruid));
          if (unfinished.length) {
            this.ui.log('warn', `仍有 ${unfinished.length} 个房间有未完成项（多为摸猫被限流或临时失败），巡航/下次运行会自动重试。`);
            if (this.store.settings.notify) gmNotify('猫咪养成助手', `${unfinished.length} 个房间未完成，稍后会自动重试。`);
          } else {
            this.ui.log('ok', '🎉 本轮任务全部结束。');
            if (this.store.settings.notify) gmNotify('猫咪养成助手', '本轮养猫任务完成喵～');
          }
        }
      } catch (e) {
        this.ui.log('err', `任务异常终止：${e.message}`);
        console.error('[猫咪养成助手] 任务异常：', e);
        if (this.store.settings.notify) gmNotify('猫咪养成助手', `任务异常终止：${e.message}`);
      } finally {
        this._running = false;
        this.ui.sync();
      }
    }

    /* 一轮任务：首轮 + 最多 2 次「摸自己」补做（补做轮只摸猫，不重跑手幅等） */
    async _round(testMode) {
      let redoRooms = [];
      let passCount = 0;
      for (;;) {
        const passResult = await this._pass(testMode, redoRooms);
        if (testMode || this._stopping || this._fatal) return { processed: false, petPendingRooms: [] };
        if (!passResult.processed) return passResult;
        passCount++;
        redoRooms = passResult.petPendingRooms || [];
        if (redoRooms.length && passCount < MAX_TASK_PASSES) {
          this.ui.log('warn', `有 ${redoRooms.length} 个房间「摸自己」未完成，等待 ${(REDO_WAIT_RANGE[0] / 1000).toFixed(0)}~${(REDO_WAIT_RANGE[1] / 1000).toFixed(0)} 秒后补做（第 ${passCount + 1} 轮）…`);
          await this._wait(rand(REDO_WAIT_RANGE[0], REDO_WAIT_RANGE[1]));
          continue;
        }
        return passResult;
      }
    }

    async _pass(testMode, onlyRooms) {
      const rooms = onlyRooms && onlyRooms.length ? onlyRooms : this.store.pendingRooms(testMode);
      if (!rooms.length) {
        this.ui.log('info', testMode
          ? '没有可选中的房间，请先在「猫咪」页选择。'
          : '所有已选房间今日任务均已完成 ✓');
        return { processed: false, petPendingRooms: [] };
      }
      this.ui.log('info', `本轮待处理 ${rooms.length} 个房间。`);
      rooms.forEach((r) => this._roomStates.set(r.ruid, 'idle'));
      this.ui.sync();

      const petPendingRooms = [];
      for (let i = 0; i < rooms.length; i++) {
        if (this._stopping || this._fatal) break;
        const room = rooms[i];
        this.ui.log('info', `▶ [${i + 1}/${rooms.length}] ${room.name} (${room.ruid})`);
        const result = await this._runRoom(room, testMode, !!(onlyRooms && onlyRooms.length));
        if (result && result.petSelfPending) petPendingRooms.push(room);
        if (!this._stopping && !this._fatal) await this._wait(rand(2500, 5000));
      }
      const done = rooms.filter((r) => this.store.roomDone(r.ruid)).length;
      this.ui.log('ok', `本轮完成：${done}/${rooms.length}`);
      return { processed: rooms.length > 0, petPendingRooms };
    }

    async _retry(label, fn) {
      let lastErr;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          return await fn();
        } catch (e) {
          lastErr = e;
          if (attempt === 0) {
            this.ui.log('warn', `${label} 失败（${e.message}），稍后重试…`);
            await this._wait(rand(1200, 2400));
          }
        }
      }
      throw lastErr;
    }

    async _attempt(label, fn) {
      try {
        const res = await this._retry(label, fn);
        return { res, v: verdict(res) };
      } catch (e) {
        this.ui.log('err', `[${label}] 异常：${e.message}`);
        return null;
      }
    }

    async _wait(ms) {
      const until = Date.now() + ms;
      for (;;) {
        if (this._stopping || this._fatal) return;
        if (this._paused) {
          await sleep(400);
          continue;
        }
        const remain = until - Date.now();
        if (remain <= 0) return;
        await sleep(Math.min(400, remain));
      }
    }

    async _runRoom(room, force, petSelfOnly) {
      const { store, api } = this;
      const settings = store.settings;
      const ruid = String(room.ruid);
      const g = store.groupFor(ruid);
      const myUid = this.session.uid;
      const csrf = this.session.csrf;
      this._roomStates.set(ruid, 'running');
      this.ui.sync();

      /* 0) 领养：尽力而为，不参与今日进度（补做轮跳过） */
      if (!petSelfOnly) {
        const adoptOut = await this._attempt('领养', () => api.adopt(ruid, csrf));
        if (adoptOut) {
          if (adoptOut.v.kind === 'fatal') {
            this._fatal = new Error(adoptOut.v.msg || '登录态失效');
            this.ui.sync();
            return;
          }
          this.ui.log(adoptOut.v.kind === 'ok' ? 'ok' : 'info', `[领养] ${room.name}：${adoptOut.v.msg || '完成'}`);
        }
        await this._wait(rand(800, 1800));
      }

      /* 1) 签到 */
      if (!petSelfOnly && g.sign && (force || !store.stageDone(ruid, 'sign'))) {
        const out = await this._attempt('签到', () => api.sign(ruid, csrf));
        if (out) {
          if (out.v.kind === 'fatal') {
            this._fatal = new Error(out.v.msg || '登录态失效');
            this.ui.sync();
            return;
          }
          if (out.v.kind === 'ok' || out.v.kind === 'already') {
            const food = out.res && out.res.data && out.res.data.food_balance;
            this.ui.log('ok', `[签到] ${room.name}：${out.v.kind === 'already' ? '今日已签到' : '签到成功'}${food != null ? '，猫粮余额 ' + food : ''}`);
            store.markStage(ruid, 'sign');
          } else {
            this.ui.log('warn', `[签到] ${room.name}：${out.v.msg}（本轮跳过，稍后可重试）`);
          }
        }
        await this._wait(rand(1000, 2000));
      }

      /* 2) 喂食：直到猫粮耗尽或达到安全上限 */
      if (!petSelfOnly && g.feed && (force || !store.stageDone(ruid, 'feed'))) {
        this.ui.log('info', `[喂食] ${room.name}：开始消耗猫粮…`);
        let rounds = 0;
        let reason = 'limit';
        while (rounds < settings.feedLimit && !this._stopping && !this._fatal) {
          rounds++;
          const out = await this._attempt('喂食', () => api.feed(ruid, myUid, csrf));
          if (!out) {
            reason = 'fail';
            break;
          }
          if (out.v.kind === 'fatal') {
            this._fatal = new Error(out.v.msg || '登录态失效');
            break;
          }
          if (out.v.kind === 'ok') {
            const d = out.res.data || {};
            const delta = Number(d.growth_delta) || 0;
            store.bumpStats({ food: (store.stats.food || 0) + 1, growth: (store.stats.growth || 0) + delta });
            this.ui.log('ok', `[喂食] 第 ${rounds} 次：成长 +${delta}，Lv.${d.cat_level != null ? d.cat_level : '?'}，余粮 ${d.food_balance != null ? d.food_balance : '?'}`);
            (d.level_up_list || []).forEach((l) => this.ui.log('star', `🎉 ${l.title || '恭喜升级！'}`));
            if (Number(d.food_balance) <= 0) {
              reason = 'empty';
              break;
            }
            if (delta <= 0 && d.food_balance == null) {
              reason = 'empty';
              break;
            }
          } else if (out.v.kind === 'exhausted') {
            this.ui.log('warn', `[喂食] ${room.name}：${out.v.msg || '猫粮不足'}，停止。`);
            reason = 'empty';
            break;
          } else if (out.v.kind === 'capped') {
            this.ui.log('warn', `[喂食] ${room.name}：${out.v.msg || '今日已达上限'}，停止。`);
            reason = 'capped';
            break;
          } else {
            this.ui.log('warn', `[喂食] ${room.name}：${out.v.msg}，停止本轮。`);
            reason = 'fail';
            break;
          }
          await this._wait(rand(1200, 2400));
        }
        if (reason !== 'fail' && !this._stopping && !this._paused && !this._fatal) {
          store.markStage(ruid, 'feed');
          this.ui.log('info', `[喂食] ${room.name}：本轮结束（${reason === 'empty' ? '猫粮已耗尽' : '达到上限或安全阈值'}）。`);
        }
      }

      /* 3) 摸自己的猫：攒满 50 成长 */
      let petSelfIncomplete = false;
      if (g.petSelf && (force || !store.stageDone(ruid, 'petSelf'))) {
        this.ui.log('info', `[摸自己] ${room.name}：开始…`);
        let gained = 0;
        let rounds = 0;
        let zeroStreak = 0;
        let reason = 'limit';
        while (rounds < settings.selfPetLimit && !this._stopping && !this._fatal) {
          rounds++;
          const out = await this._attempt('摸自己', () => api.pet(ruid, myUid, csrf));
          if (!out) {
            reason = 'fail';
            break;
          }
          if (out.v.kind === 'fatal') {
            this._fatal = new Error(out.v.msg || '登录态失效');
            break;
          }
          if (out.v.kind === 'capped') {
            this.ui.log('info', `[摸自己] ${room.name}：${out.v.msg || '今日已满'}，停止。`);
            reason = 'cap';
            break;
          }
          if (out.v.kind === 'ok') {
            const d = out.res.data || {};
            const delta = Number(d.growth_delta) || 0;
            if (delta <= 0) {
              zeroStreak++;
              if (zeroStreak <= PET_ZERO_LIMIT) {
                const raw = JSON.stringify(d && Object.keys(d).length ? d : out.res).slice(0, 120);
                this.ui.log('warn', `[摸自己] ${room.name}：接口未返回成长（原始：${raw}），${(PET_ZERO_COOLDOWN[0] / 1000).toFixed(0)}~${(PET_ZERO_COOLDOWN[1] / 1000).toFixed(0)} 秒后继续（${zeroStreak}/${PET_ZERO_LIMIT}），可能是频率限制…`);
                await this._wait(rand(PET_ZERO_COOLDOWN[0], PET_ZERO_COOLDOWN[1]));
                rounds--;
                continue;
              }
              this.ui.log('info', `[摸自己] ${room.name}：连续 ${PET_ZERO_LIMIT} 次未返回成长，按“今日已满或暂不可摸”停止（本轮不标记完成）。`);
              reason = 'retry';
              break;
            }
            zeroStreak = 0;
            gained += delta;
            store.bumpStats({ pets: (store.stats.pets || 0) + 1, growth: (store.stats.growth || 0) + delta });
            this.ui.log('ok', `[摸自己] 第 ${rounds} 次：成长 +${delta}（本轮 ${gained}/50）`);
            (d.level_up_list || []).forEach((l) => this.ui.log('star', `🎉 ${l.title || '恭喜升级！'}`));
            if (gained >= 50) {
              reason = 'cap';
              break;
            }
          } else if (out.v.kind === 'transient') {
            zeroStreak++;
            if (zeroStreak <= PET_ZERO_LIMIT) {
              this.ui.log('warn', `[摸自己] ${room.name}：${out.v.msg || '接口繁忙'}，${(PET_ZERO_COOLDOWN[0] / 1000).toFixed(0)}~${(PET_ZERO_COOLDOWN[1] / 1000).toFixed(0)} 秒后继续（${zeroStreak}/${PET_ZERO_LIMIT}）…`);
              await this._wait(rand(PET_ZERO_COOLDOWN[0], PET_ZERO_COOLDOWN[1]));
              rounds--;
              continue;
            }
            this.ui.log('info', `[摸自己] ${room.name}：接口持续繁忙，本轮跳过（不标记完成）。`);
            reason = 'retry';
            break;
          } else {
            this.ui.log('warn', `[摸自己] ${room.name}：${out.v.msg}，停止本轮。`);
            reason = 'fail';
            break;
          }
          await this._wait(rand(2000, 3500));
        }
        if (reason === 'cap' && !this._stopping && !this._paused && !this._fatal) {
          store.markStage(ruid, 'petSelf');
        }
        if ((reason === 'cap' || reason === 'limit') && !this._stopping && !this._paused && !this._fatal) {
          this.ui.log('info', `[摸自己] ${room.name}：本轮共获得 ${gained} 成长。`);
        }
        if (reason !== 'cap') petSelfIncomplete = true;
      }

      /* 4) 摸同担（排行榜 / 指定 UID） */
      if (!petSelfOnly && g.petRank && (force || !store.stageDone(ruid, 'petRank'))) {
        let ok = true;
        try {
          let cats = [];
          let scopeDesc = '';
          if (g.rankMode === 'uid') {
            scopeDesc = '指定 UID';
            const uidTargets = this._uidCatList(g);
            if (!uidTargets.length) {
              this.ui.log('warn', `[摸同担] ${room.name}：尚未导入指定 UID，跳过本阶段。`);
            } else {
              this.ui.log('info', `[摸同担] ${room.name}：拉取房间猫咪列表，核对 ${uidTargets.length} 个指定 UID…`);
              const roomCats = await this._fetchRankCats(ruid, 0);
              const roomUids = new Set(roomCats.map((c) => String(c.uid)));
              const inRoom = uidTargets.filter((c) => roomUids.has(c.uid));
              const notInRoom = uidTargets.filter((c) => !roomUids.has(c.uid));
              cats = inRoom;
              this.ui.log('info', `[摸同担] ${room.name}：本房间有猫 ${inRoom.length} 个，无猫 ${notInRoom.length} 个（已跳过）。`);
              notInRoom.forEach((c) => this.ui.log('info', `  ↳ 不在本房间：${c.uid}`));
            }
          } else {
            const limit = g.rankMode === 'top' ? clamp(Number(g.rankTopN) || 20, 1, 999) : 0;
            scopeDesc = g.rankMode === 'top' ? `前 ${limit}` : '全部';
            this.ui.log('info', `[摸同担] ${room.name}：拉取排行榜（${scopeDesc}）…`);
            cats = await this._fetchRankCats(ruid, limit);
          }
          const others = cats.filter((c) => String(c.uid) !== String(myUid));
          this.ui.log('info', `[摸同担] ${room.name}：${scopeDesc}，目标 ${others.length} 只猫，开始抚摸。`);
          const petOkCats = new Set();
          const petSkipCats = new Set();
          let petOkTimes = 0;
          for (let i = 0; i < others.length; i++) {
            if (this._stopping || this._fatal) break;
            const cat = others[i];
            let zeroStreak = 0;
            for (let p = 0; p < g.pokeTimes; p++) {
              if (this._stopping || this._fatal) break;
              const out = await this._attempt('摸猫', () => api.pet(ruid, cat.uid, csrf));
              if (!out) break;
              if (out.v.kind === 'fatal') {
                this._fatal = new Error(out.v.msg || '登录态失效');
                break;
              }
              const d = out.res && out.res.data;
              const delta = Number(d && d.growth_delta) || 0;
              const realCat = !!(d && (delta > 0 || d.cat_level != null || d.growth != null));
              if (out.v.kind === 'transient' || (out.v.kind === 'ok' && !realCat)) {
                zeroStreak++;
                if (zeroStreak <= 3) {
                  const raw = JSON.stringify(d && Object.keys(d).length ? d : out.res).slice(0, 100);
                  this.ui.log('warn', `[摸同担] ${cat.name}（${cat.uid}）：接口未返回有效成长（原始：${raw}），${(PET_ZERO_COOLDOWN[0] / 1000).toFixed(0)}~${(PET_ZERO_COOLDOWN[1] / 1000).toFixed(0)} 秒后重试（${zeroStreak}/3），可能是频率限制…`);
                  await this._wait(rand(PET_ZERO_COOLDOWN[0], PET_ZERO_COOLDOWN[1]));
                  p--;
                  continue;
                }
                petSkipCats.add(cat.uid);
                this.ui.log('warn', `[摸同担] ${cat.name}（${cat.uid}）：连续 3 次未返回有效成长，跳过。`);
                break;
              }
              if (out.v.kind === 'ok') {
                store.bumpStats({ pets: (store.stats.pets || 0) + 1 });
                petOkCats.add(cat.uid);
                petOkTimes++;
                this.ui.log('ok', `[摸同担] ${cat.name}（${cat.uid}）第 ${p + 1}/${g.pokeTimes} 次 ✓（成长 +${delta}）`);
              } else if (out.v.kind === 'capped') {
                petSkipCats.add(cat.uid);
                this.ui.log('warn', `[摸同担] ${cat.name}：${out.v.msg || '今日不能再摸'}，跳过。`);
                break;
              } else {
                petSkipCats.add(cat.uid);
                this.ui.log('warn', `[摸同担] ${cat.name}（${cat.uid}）：接口 code=${out.res && out.res.code}，${out.v.msg || '不在本房间或无法抚摸'}，跳过。`);
                break;
              }
              await this._wait(rand(1200, 2200));
            }
            await this._wait(rand(1500, 2500));
          }
          this.ui.log('info', `[摸同担] ${room.name}：${scopeDesc}，成功 ${petOkCats.size} 只，跳过 ${petSkipCats.size} 只（共抚摸 ${petOkTimes} 次）。`);
          if (petOkCats.size === 0 && others.length > 0) {
            this.ui.log('warn', `[摸同担] ${room.name}：没有摸到任何一只。若确认指定 UID 已在本房间养猫，可清空今日进度后重试。`);
          }
        } catch (e) {
          ok = false;
          this.ui.log('err', `[摸同担] ${room.name} 异常：${e.message}`);
        }
        if (ok && !this._stopping && !this._paused && !this._fatal) store.markStage(ruid, 'petRank');
      }

      /* 5) 投喂粉丝手幅（消耗 1 电池，默认关闭） */
      if (!petSelfOnly && g.banner && (force || !store.stageDone(ruid, 'banner'))) {
        try {
          const roomId = await this._retry('直播间查询', () => this.api.masterRoomId(ruid));
          const out = await this._attempt('手幅', () => this.api.sendBanner({
            uid: myUid,
            ruid,
            roomId,
            csrf,
          }));
          if (out) {
            if (out.v.kind === 'fatal') {
              this._fatal = new Error(out.v.msg || '登录态失效');
            } else if (out.v.kind === 'ok') {
              store.bumpStats({ gifts: (store.stats.gifts || 0) + 1 });
              store.markStage(ruid, 'banner');
              this.ui.log('ok', `[手幅] ${room.name}：已投喂（消耗 1 电池）`);
            } else {
              this.ui.log('warn', `[手幅] ${room.name}：${out.v.msg || '投喂失败'}。若电池已扣但标记失败，请勿重复勾选重跑。`);
            }
          }
        } catch (e) {
          this.ui.log('err', `[手幅] ${room.name} 失败：${e.message}`);
        }
      }

      const done = store.roomDone(ruid);
      this._roomStates.set(ruid, done ? 'done' : 'failed');
      this.ui.log(done ? 'ok' : 'warn', `[房间] ${room.name}：${done ? '今日任务全部完成 ✓' : '部分阶段未完成，保留待重试'}`);
      this.ui.sync();
      return { petSelfPending: !!(g.petSelf && petSelfIncomplete && !store.stageDone(ruid, 'petSelf') && !this._fatal && !this._stopping) };
    }

    async _fetchRankCats(ruid, limit) {
      const cats = [];
      const seen = new Set();
      const pageSize = 20;
      let start = 0;
      for (let guard = 0; guard < 50 && !this._stopping && !this._fatal; guard++) {
        const end = limit > 0 ? Math.min(limit - 1, start + pageSize - 1) : start + pageSize - 1;
        const out = await this._attempt('排行榜', () => this.api.rankCats(ruid, start, end));
        if (!out) break;
        if (out.v.kind === 'fatal') {
          this._fatal = new Error(out.v.msg || '登录态失效');
          break;
        }
        const list = out.res && out.res.data && Array.isArray(out.res.data.list) ? out.res.data.list : [];
        list.forEach((item) => {
          const uid = String(item.item_id || '');
          if (!uid || seen.has(uid)) return;
          seen.add(uid);
          let name = uid;
          try {
            const extra = JSON.parse(item.extra || '{}');
            name = extra.nick_name || uid;
          } catch (e) {
            /* 保留 uid 作为名字 */
          }
          cats.push({ uid, name });
        });
        if (!list.length || list.length < pageSize) break;
        if (limit > 0 && cats.length >= limit) break;
        start += pageSize;
        await this._wait(rand(400, 900));
      }
      return cats;
    }

    _uidCatList(g) {
      const out = [];
      const seen = new Set();
      String(g.rankUids || '').split(/[\r\n,，;；\s]+/).forEach((raw) => {
        const uid = String(raw || '').replace(/\D/g, '');
        if (!uid || seen.has(uid)) return;
        seen.add(uid);
        out.push({ uid, name: uid });
      });
      return out;
    }

    pause() {
      if (this._running && !this._paused) {
        this._paused = true;
        this.ui.log('warn', '已暂停，将在当前动作结束后停止推进。');
        this.ui.sync();
      }
    }

    resume() {
      if (this._paused) {
        this._paused = false;
        this.ui.log('info', '已继续。');
        this.ui.sync();
      }
    }

    stop() {
      if (!this._running) return;
      this._stopping = true;
      this.ui.log('warn', '正在停止…进度已保存，可在之后继续运行。');
      this.ui.sync();
    }

    resetToday() {
      if (this._running) {
        this.ui.log('warn', '任务运行中不能清空今日进度。');
        return;
      }
      this.store.resetToday();
      this._roomStates.clear();
      this.ui.log('info', '今日进度已清空。');
      this.ui.sync();
    }
  }

  /* ===================== 界面 ===================== */
  const SWITCH_META = [
    { key: 'sign', label: '签到' },
    { key: 'feed', label: '喂食' },
    { key: 'petSelf', label: '摸自己' },
    { key: 'petRank', label: '摸同担' },
    { key: 'banner', label: '手幅·1电池' },
  ];

  const STATE_LABELS = { idle: '待办', running: '进行中', done: '已完成', failed: '未完成' };
  const RING_CIRC = 2 * Math.PI * 34;

  const CSS = `
    #mc-root, #mc-fab, #mc-modal {
      --mc-bg: #15171d;
      --mc-card: #1e212b;
      --mc-card2: #252936;
      --mc-line: #303442;
      --mc-text: #e9ebf2;
      --mc-sub: #9aa0b0;
      --mc-accent: #f6b23b;
      --mc-accent2: #e8942a;
      --mc-mint: #4ade80;
      --mc-rose: #f87171;
      --mc-blue: #7db6ff;
    }
    #mc-root {
      position: fixed;
      left: auto;
      right: 18px;
      top: 90px;
      width: 400px;
      min-width: 320px;
      height: min(640px, calc(100vh - 40px));
      min-height: 320px;
      max-width: calc(100vw - 20px);
      max-height: calc(100vh - 40px);
      resize: both;
      background: var(--mc-bg);
      color: var(--mc-text);
      border: 1px solid var(--mc-line);
      border-radius: 16px;
      box-shadow: 0 12px 40px rgba(0, 0, 0, .45);
      z-index: 2147483647;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      font-size: 13px;
      line-height: 1.55;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    #mc-root * { box-sizing: border-box; }
    #mc-root button { font-family: inherit; }
    #mc-root .mc-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px;
      background: linear-gradient(135deg, #2a2e3d, #1c1f2b);
      border-bottom: 1px solid var(--mc-line);
      cursor: move;
      user-select: none;
      flex-shrink: 0;
    }
    #mc-root .mc-brand {
      flex: 1;
      font-weight: 700;
      font-size: 14px;
      display: flex;
      align-items: baseline;
      gap: 8px;
    }
    #mc-root .mc-brand-sub { font-size: 10px; color: var(--mc-sub); font-weight: 400; }
    #mc-root .mc-icon-btn {
      border: none;
      background: rgba(255, 255, 255, .08);
      color: var(--mc-text);
      width: 24px;
      height: 24px;
      border-radius: 7px;
      cursor: pointer;
      line-height: 1;
      font-size: 14px;
    }
    #mc-root .mc-login-bar {
      padding: 6px 12px;
      font-size: 11px;
      color: var(--mc-sub);
      background: var(--mc-card);
      border-bottom: 1px solid var(--mc-line);
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    #mc-root .mc-login-bar .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--mc-rose);
      flex-shrink: 0;
    }
    #mc-root .mc-login-bar.on .dot { background: var(--mc-mint); }
    #mc-root .mc-tabs {
      display: flex;
      gap: 4px;
      padding: 8px 10px 0;
      background: var(--mc-card);
      flex-shrink: 0;
    }
    #mc-root .mc-tab {
      flex: 1;
      border: none;
      background: transparent;
      color: var(--mc-sub);
      padding: 7px 0;
      border-radius: 10px 10px 0 0;
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
    }
    #mc-root .mc-tab.active { background: var(--mc-bg); color: var(--mc-accent); }
    #mc-root .mc-main {
      flex: 1;
      overflow-y: auto;
      overflow-x: hidden;
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    /* 防御 t.bilibili.com 等页面的全局样式污染 */
    #mc-root .mc-opt-row,
    #mc-root .mc-subrow,
    #mc-root .mc-foot-row,
    #mc-root .mc-list-foot,
    #mc-root .mc-cta-row,
    #mc-root .mc-toolbar {
      display: flex !important;
      flex-wrap: wrap !important;
    }
    #mc-root .mc-switch { flex: 0 0 auto !important; }
    #mc-root .mc-empty {
      white-space: normal !important;
      overflow: visible !important;
      word-break: break-word !important;
    }
    #mc-root .mc-meta,
    #mc-root .mc-subrow,
    #mc-root .mc-foot-row,
    #mc-root .mc-login-bar,
    #mc-root .mc-room-name,
    #mc-root .mc-room-uid,
    #mc-root .mc-room-stages,
    #mc-root .mc-page-info,
    #mc-root .mc-selected-count,
    #mc-root .mc-stats {
      white-space: normal !important;
    }
    #mc-root button,
    #mc-root input,
    #mc-root textarea,
    #mc-root select {
      font-family: inherit !important;
    }
    #mc-root .mc-page { min-width: 0 !important; }
    #mc-root .mc-opt-row > *,
    #mc-root .mc-subrow > *,
    #mc-root .mc-foot-row > *,
    #mc-root .mc-cta-row > *,
    #mc-root .mc-toolbar > * {
      min-width: 0 !important;
      max-width: 100% !important;
    }
    #mc-root .mc-empty {
      max-width: 100% !important;
      min-width: 0 !important;
    }
    /* t.bilibili.com 裸标签规则覆盖：main/section/span/button */
    #mc-root .mc-main {
      width: auto !important;
      margin: 0 !important;
      position: static !important;
    }
    #mc-root .mc-page {
      width: auto !important;
      margin-bottom: 0 !important;
    }
    #mc-root span {
      color: inherit !important;
      font-size: inherit !important;
      font-weight: inherit !important;
      line-height: inherit !important;
      margin: 0 !important;
      padding: 0 !important;
      width: auto !important;
      height: auto !important;
      display: inline !important;
      transform: none !important;
    }
    #mc-root .mc-brand-sub { font-size: 10px !important; color: var(--mc-sub) !important; }
    #mc-root .mc-cat-sub { font-size: 11px !important; color: var(--mc-sub) !important; }
    #mc-root .mc-tag { display: inline-block !important; font-size: 10px !important; color: var(--mc-sub) !important; }
    #mc-root .mc-room-uid { font-size: 10px !important; color: var(--mc-sub) !important; }
    #mc-root .mc-room-stages { font-size: 10px !important; color: var(--mc-sub) !important; }
    #mc-root .mc-page-info { font-size: 11px !important; color: var(--mc-sub) !important; }
    #mc-root .mc-selected-count { font-size: 12px !important; }
    #mc-root .mc-cat-name { display: flex !important; }
    #mc-root .mc-room-name { display: block !important; }
    #mc-root .mc-btn,
    #mc-root .mc-icon-btn,
    #mc-root .mc-chip {
      width: auto !important;
      height: auto !important;
      line-height: inherit !important;
      display: inline-block !important;
    }
    #mc-root .mc-cta-row .mc-btn { display: block !important; }
    #mc-root .mc-page { display: flex; flex-direction: column; gap: 10px; }
    #mc-root .mc-page[hidden] { display: none; }
    #mc-root .mc-toolbar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    #mc-root .mc-btn {
      border: 1px solid var(--mc-line);
      background: var(--mc-card2);
      color: var(--mc-text);
      padding: 6px 10px;
      border-radius: 9px;
      cursor: pointer;
      font-size: 12px;
    }
    #mc-root .mc-btn:hover { border-color: var(--mc-accent); color: var(--mc-accent); }
    #mc-root .mc-btn:disabled { opacity: .45; cursor: not-allowed; }
    #mc-root .mc-btn.primary {
      background: linear-gradient(135deg, var(--mc-accent), var(--mc-accent2));
      border-color: transparent;
      color: #241a05;
      font-weight: 700;
    }
    #mc-root .mc-btn.primary:hover { filter: brightness(1.06); color: #241a05; }
    #mc-root .mc-btn.danger { color: var(--mc-rose); border-color: rgba(248, 113, 113, .4); }
    #mc-root .mc-btn.warn { color: var(--mc-accent); border-color: rgba(246, 178, 59, .4); }
    #mc-root .mc-btn.full { width: 100%; }
    #mc-root .mc-meta { font-size: 11px; color: var(--mc-sub); }
    #mc-root .mc-input {
      width: 100%;
      padding: 7px 10px;
      border: 1px solid var(--mc-line);
      border-radius: 10px;
      background: var(--mc-card);
      color: var(--mc-text);
      font-size: 12px;
    }
    #mc-root .mc-input:focus { outline: none; border-color: var(--mc-accent); }
    #mc-root .mc-group-bar {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }
    #mc-root .mc-group-label { font-size: 12px; color: var(--mc-sub); flex-shrink: 0; }
    #mc-root .mc-group-chips { display: flex; gap: 4px; flex-wrap: wrap; flex: 1; }

    #mc-root .mc-group-tag { border-color: rgba(125, 182, 255, .5); color: var(--mc-blue); }
    #mc-root .mc-assign-row { display: inline-flex !important; gap: 6px; align-items: center; }
    #mc-root .mc-select {
      padding: 5px 8px;
      border: 1px solid var(--mc-line);
      border-radius: 8px;
      background: var(--mc-card2);
      color: var(--mc-text);
      font-size: 12px;
      max-width: 140px;
    }
    #mc-root .mc-chips { display: flex; gap: 6px; }
    #mc-root .mc-chip {
      border: 1px solid var(--mc-line);
      background: transparent;
      color: var(--mc-sub);
      padding: 3px 10px;
      border-radius: 999px;
      cursor: pointer;
      font-size: 11px;
    }
    #mc-root .mc-chip.active {
      border-color: var(--mc-accent);
      color: var(--mc-accent);
      background: rgba(246, 178, 59, .1);
    }
    #mc-root #mc-page-cats { flex: 1; min-height: 0; }
    #mc-root #mc-page-cats .mc-list {
      flex: 1 1 auto;
      min-height: 140px;
      max-height: calc(100vh - 300px);
      border: 1px solid var(--mc-line);
      border-radius: 12px;
      background: var(--mc-card);
      overflow-y: auto;
    }
    #mc-root .mc-cat-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 7px 10px;
      border-bottom: 1px solid var(--mc-line);
      cursor: pointer;
    }
    #mc-root .mc-cat-item:last-child { border-bottom: none; }
    #mc-root .mc-cat-item:hover { background: var(--mc-card2); }
    #mc-root .mc-cat-item input { flex-shrink: 0; accent-color: var(--mc-accent); }
    #mc-root .mc-cat-main { flex: 1; min-width: 0; display: block; }
    #mc-root .mc-cat-name {
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    #mc-root .mc-cat-sub { font-size: 11px; color: var(--mc-sub); }
    #mc-root .mc-tag {
      display: inline-block;
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 999px;
      border: 1px solid var(--mc-line);
      color: var(--mc-sub);
      flex-shrink: 0;
    }
    #mc-root .mc-empty { color: var(--mc-sub); font-size: 12px; text-align: center; padding: 14px 8px; }
    #mc-root .mc-list-foot { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
    #mc-root .mc-page-info { flex: 1; text-align: center; font-size: 11px; color: var(--mc-sub); }
    #mc-root .mc-foot-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; font-size: 12px; }
    #mc-root .mc-opt-row { display: flex; flex-wrap: wrap; gap: 6px; }
    #mc-root .mc-switch {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 5px 10px;
      border: 1px solid var(--mc-line);
      border-radius: 999px;
      cursor: pointer;
      font-size: 12px;
      background: var(--mc-card);
      user-select: none;
    }
    #mc-root .mc-switch input { accent-color: var(--mc-accent); }
    #mc-root .mc-switch.on { border-color: var(--mc-accent); color: var(--mc-accent); background: rgba(246, 178, 59, .08); }
    #mc-root .mc-subrow {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      font-size: 12px;
      color: var(--mc-sub);
    }
    #mc-root .mc-subrow input[type="number"] {
      width: 64px;
      padding: 4px 6px;
      border: 1px solid var(--mc-line);
      border-radius: 8px;
      background: var(--mc-card);
      color: var(--mc-text);
    }
    #mc-root .mc-subrow label { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; }
    #mc-root .mc-rank-panel {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 8px;
      border: 1px solid var(--mc-line);
      border-radius: 10px;
      background: var(--mc-card);
    }
    #mc-root .mc-rank-panel[hidden] { display: none; }
    #mc-root .mc-rank-panel textarea.mc-input {
      min-height: 80px;
      resize: vertical;
    }
    #mc-root .mc-cta-row { display: flex; gap: 8px; }
    #mc-root .mc-cta-row .mc-btn { flex: 1; }
    #mc-root .mc-ring-wrap {
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 10px;
      background: var(--mc-card);
      border: 1px solid var(--mc-line);
      border-radius: 12px;
    }
    #mc-root .mc-ring { width: 72px; height: 72px; transform: rotate(-90deg); flex-shrink: 0; }
    #mc-root .mc-ring circle { fill: none; stroke-width: 7; }
    #mc-root .mc-ring-bg { stroke: var(--mc-line); }
    #mc-root .mc-ring-fg { stroke: var(--mc-accent); stroke-linecap: round; transition: stroke-dashoffset .4s ease; }
    #mc-root .mc-ring-text { display: flex; flex-direction: column; }
    #mc-root .mc-ring-text b { font-size: 20px; color: var(--mc-accent); }
    #mc-root .mc-ring-text span { font-size: 11px; color: var(--mc-sub); }
    #mc-root .mc-room-list { display: flex; flex-direction: column; gap: 6px; max-height: 200px; overflow-y: auto; }
    #mc-root .mc-room {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 7px 10px;
      background: var(--mc-card);
      border: 1px solid var(--mc-line);
      border-radius: 10px;
    }
    #mc-root .mc-room-main { flex: 1; min-width: 0; display: block; }
    #mc-root .mc-room-name {
      font-weight: 600;
      font-size: 12px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      display: block;
    }
    #mc-root .mc-room-uid { font-size: 10px; color: var(--mc-sub); }
    #mc-root .mc-state {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 999px;
      flex-shrink: 0;
      border: 1px solid var(--mc-line);
      color: var(--mc-sub);
    }
    #mc-root .mc-state.running {
      color: var(--mc-accent);
      border-color: var(--mc-accent);
      animation: mc-pulse 1.2s infinite;
    }
    #mc-root .mc-state.done { color: var(--mc-mint); border-color: rgba(74, 222, 128, .5); }
    #mc-root .mc-state.failed { color: var(--mc-rose); border-color: rgba(248, 113, 113, .5); }
    #mc-root .mc-room-stages { font-size: 10px; color: var(--mc-sub); flex-shrink: 0; }
    @keyframes mc-pulse { 50% { opacity: .45; } }
    #mc-root .mc-log {
      height: 300px;
      overflow-y: auto;
      background: #101218;
      border: 1px solid var(--mc-line);
      border-radius: 12px;
      padding: 8px 10px;
      font-family: Consolas, Monaco, "Courier New", monospace;
      font-size: 11px;
      line-height: 1.6;
      white-space: pre-wrap;
      word-break: break-all;
    }
    #mc-root .mc-log-line { margin: 0; }
    #mc-root .mc-log-line .t { color: #565d6e; margin-right: 6px; }
    #mc-root .mc-log-line.info { color: #c9cedb; }
    #mc-root .mc-log-line.ok { color: var(--mc-mint); }
    #mc-root .mc-log-line.warn { color: var(--mc-accent); }
    #mc-root .mc-log-line.err { color: var(--mc-rose); }
    #mc-root .mc-log-line.star { color: #f0a8ff; }
    #mc-root .mc-footer {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      border-top: 1px solid var(--mc-line);
      background: var(--mc-card);
      font-size: 11px;
      color: var(--mc-sub);
      flex-shrink: 0;
    }
    #mc-root .mc-footer a { color: var(--mc-blue); text-decoration: none; margin-left: auto; }
    #mc-fab {
      position: fixed;
      left: auto;
      right: 18px;
      top: 90px;
      z-index: 2147483647;
      width: 46px;
      height: 46px;
      border-radius: 50%;
      border: 1px solid var(--mc-line);
      background: linear-gradient(135deg, #2a2e3d, #1c1f2b);
      color: var(--mc-accent);
      font-size: 20px;
      cursor: pointer;
      box-shadow: 0 8px 24px rgba(0, 0, 0, .4);
      line-height: 1;
    }
    #mc-modal {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      background: rgba(0, 0, 0, .55);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
    }
    #mc-modal[hidden] { display: none; }
    #mc-modal .mc-modal-card {
      width: 400px;
      max-width: 100%;
      background: var(--mc-bg);
      border: 1px solid var(--mc-line);
      border-radius: 14px;
      padding: 14px;
      color: var(--mc-text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      font-size: 13px;
    }
    #mc-modal .mc-modal-title { font-weight: 700; font-size: 14px; margin-bottom: 6px; }
    #mc-modal textarea {
      width: 100%;
      min-height: 140px;
      margin: 8px 0;
      padding: 8px;
      background: var(--mc-card);
      color: var(--mc-text);
      border: 1px solid var(--mc-line);
      border-radius: 10px;
      font-size: 12px;
      resize: vertical;
      font-family: inherit;
    }
    #mc-modal .mc-modal-actions { display: flex; gap: 8px; justify-content: flex-end; }
  `;

  const PANEL_HTML = `
  <div id="mc-root">
    <div class="mc-header" id="mc-header">
      <div class="mc-brand">🐈 猫咪养成助手 <span class="mc-brand-sub">Bili Cat Butler</span></div>
      <button class="mc-icon-btn" id="mc-collapse" title="折叠">—</button>
    </div>
    <div class="mc-login-bar" id="mc-login-bar"><span class="dot"></span><span id="mc-login-text">登录检测中…</span></div>
    <nav class="mc-tabs">
      <button class="mc-tab active" data-tab="cats">🐱 猫咪</button>
      <button class="mc-tab" data-tab="jobs">🎯 任务</button>
      <button class="mc-tab" data-tab="logs">📜 日志</button>
    </nav>
    <main class="mc-main">
      <section class="mc-page" id="mc-page-cats">
        <div class="mc-toolbar">
          <button class="mc-btn primary" id="mc-fetch">拉取粉丝牌</button>
        </div>
        <div class="mc-meta" id="mc-meta">缓存：无</div>
        <input class="mc-input" id="mc-search" placeholder="搜索主播 / 粉丝牌 / UID…" autocomplete="off" />
        <div class="mc-chips">
          <button class="mc-chip active" data-filter="all">全部</button>
          <button class="mc-chip" data-filter="unsel">未选</button>
          <button class="mc-chip" data-filter="sel">已选</button>
        </div>
        <div class="mc-chips" id="mc-group-filter"></div>
        <div class="mc-list" id="mc-cat-list"></div>
        <div class="mc-foot-row">
          <span id="mc-selected-count">已选 0</span>
          <button class="mc-btn" id="mc-select-page">全选</button>
          <button class="mc-btn" id="mc-clear-sel">清空</button>
          <button class="mc-btn" id="mc-reset-group">重置到默认组</button>
          <button class="mc-btn" id="mc-export-sel">导出</button>
          <button class="mc-btn" id="mc-import-sel">导入</button>
          <span class="mc-assign-row">
            <select id="mc-assign-group" class="mc-select"></select>
            <button class="mc-btn" id="mc-assign-btn">分配到组</button>
          </span>
        </div>
      </section>
      <section class="mc-page" id="mc-page-jobs" hidden>
        <div class="mc-group-bar">
          <span class="mc-group-label">任务组</span>
          <div class="mc-group-chips" id="mc-group-chips"></div>
          <button class="mc-icon-btn" id="mc-group-add" title="新建组">＋</button>
          <button class="mc-icon-btn" id="mc-group-rename" title="重命名当前组">✎</button>
          <button class="mc-icon-btn" id="mc-group-del" title="删除当前组">－</button>
        </div>
        <div class="mc-opt-row" id="mc-opt-row"></div>
        <div class="mc-rank-panel" id="mc-rank-panel" hidden>
          <div class="mc-subrow">
            <label><input type="radio" name="mc-rank-mode" value="all" /> 摸全部</label>
            <label><input type="radio" name="mc-rank-mode" value="top" /> 摸前 <input type="number" id="mc-rank-topn" min="1" max="999" /> 只</label>
            <label><input type="radio" name="mc-rank-mode" value="uid" /> 摸指定 UID</label>
            <span>每只摸 <input type="number" id="mc-poke-times" min="1" max="9" /> 次</span>
          </div>
          <textarea id="mc-rank-uids" class="mc-input" placeholder="每行一个 UID，只摸这些用户的小猫"></textarea>
          <div class="mc-meta" id="mc-rank-uid-meta"></div>
        </div>
        <div class="mc-subrow" id="mc-mode-row">
          <label><input type="radio" name="mc-mode" value="once" /> 单次</label>
          <label><input type="radio" name="mc-mode" value="cruise" /> 巡航</label>
          <span>间隔 <input type="number" id="mc-cruise-min" min="5" step="5" /> 分钟</span>
        </div>
        <input class="mc-input" id="mc-blacklist" placeholder="黑名单关键词，逗号分隔（选中的房间仍会跳过）" />
        <div class="mc-cta-row">
          <button class="mc-btn primary" id="mc-start">▶ 开始</button>
          <button class="mc-btn warn" id="mc-pause" disabled>⏸ 暂停</button>
          <button class="mc-btn danger" id="mc-stop" disabled>⏹ 停止</button>
        </div>

        <div class="mc-ring-wrap">
          <svg class="mc-ring" viewBox="0 0 80 80">
            <circle class="mc-ring-bg" cx="40" cy="40" r="34"></circle>
            <circle class="mc-ring-fg" id="mc-ring-fg" cx="40" cy="40" r="34"></circle>
          </svg>
          <div class="mc-ring-text"><b id="mc-ring-pct">0%</b><span id="mc-ring-sub">0 / 0</span></div>
        </div>
        <div class="mc-room-list" id="mc-room-list"></div>
        <div class="mc-foot-row">
          <button class="mc-btn" id="mc-clear-today">🗑 清空今日进度</button>
        </div>
      </section>
      <section class="mc-page" id="mc-page-logs" hidden>
        <div class="mc-toolbar">
          <button class="mc-btn" id="mc-log-clear">清空日志</button>
          <button class="mc-btn" id="mc-log-export">导出日志</button>
        </div>
        <div class="mc-log" id="mc-log"></div>
      </section>
    </main>
    <footer class="mc-footer">
      <span id="mc-stats"></span>
      <a href="https://github.com/coni233/bili-cat-butler" target="_blank" rel="noreferrer">GitHub 源码</a>
    </footer>
  </div>
  <button id="mc-fab" hidden title="展开猫咪养成助手">🐱</button>
  <input type="file" id="mc-file-import" accept=".json,.txt,text/plain" hidden />
  `;

  function downloadFile(filename, content, type) {
    const blob = new Blob([content], { type: type || 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  }

  class Ui {
    constructor(deps) {
      this.store = deps.store;
      this.session = deps.session;
      this.api = deps.api;
      this.engine = null;
      this.el = {};
      this.filter = 'all';
      this.query = '';
      this.activeGroupId = null;
      this.groupFilter = '';
    }

    activeGroup() {
      if (!this.activeGroupId || !this.store.groups.some((g) => g.id === this.activeGroupId)) {
        this.activeGroupId = this.store.groups[0].id;
      }
      return this.store.groups.find((g) => g.id === this.activeGroupId);
    }

    build() {
      GM_addStyle(CSS);
      ['#mc-root', '#mc-fab', '#mc-file-import'].forEach((sel) => {
        const stale = document.querySelector(sel);
        if (stale && stale.parentNode) stale.parentNode.removeChild(stale);
      });
      const host = document.createElement('div');
      host.innerHTML = PANEL_HTML;

      const ids = [
        'root', 'header', 'collapse', 'fab', 'file-import',
        'login-bar', 'login-text', 'fetch', 'meta', 'search',
        'cat-list', 'selected-count',
        'select-page', 'clear-sel', 'reset-group', 'export-sel', 'import-sel',
        'opt-row', 'rank-panel', 'rank-topn', 'rank-uids', 'rank-uid-meta', 'poke-times', 'mode-row', 'cruise-min', 'blacklist',
        'group-chips', 'group-add', 'group-rename', 'group-del', 'group-filter', 'assign-group', 'assign-btn',
        'start', 'pause', 'stop', 'ring-fg', 'ring-pct', 'ring-sub',
        'room-list', 'clear-today', 'log-clear', 'log-export', 'log', 'stats',
      ];
      const toKey = (id) => {
        if (id === 'log') return 'logBox';
        if (id === 'rank-topn') return 'rankTopN';
        return id.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      };
      ids.forEach((id) => {
        this.el[toKey(id)] = host.querySelector(`#mc-${id}`);
      });
      const missingIds = ids.filter((id) => !this.el[toKey(id)]);
      if (missingIds.length) {
        console.warn('[猫咪养成助手] 面板元素缺失：', missingIds.map((x) => `mc-${x}`).join(', '));
      }
      this.el.tabs = Array.from(host.querySelectorAll('.mc-tab'));
      this.el.pages = Array.from(host.querySelectorAll('.mc-page'));
      this.el.chips = Array.from(host.querySelectorAll('.mc-chip'));

      while (host.firstChild) {
        document.body.appendChild(host.firstChild);
      }

      this._bind();
      this._restoreUi();
      this.sync();
    }

    _bind() {
      const els = this.el;
      const bind = (el, type, fn, label) => {
        if (!el) {
          console.warn(`[猫咪养成助手] 缺少元素，跳过绑定：${label || type}`);
          return;
        }
        el.addEventListener(type, fn);
      };
      bind(els.collapse, 'click', () => this.toggleCollapsed(), 'collapse');
      if (els.root && els.root.addEventListener) {
        els.root.addEventListener('resize', () => this._saveUi());
      }
      bind(els.fab, 'click', () => this.toggleCollapsed(), 'fab');
      bind(els.loginBar, 'click', async () => {
        await this.session.refresh(true);
        this.renderLogin();
        this.log(this.session.info ? 'ok' : 'err', this.session.info
          ? `登录态已刷新：${this.session.info.name}`
          : '仍未检测到登录态。');
      }, 'loginBar');

      els.tabs.forEach((btn) => {
        btn.addEventListener('click', () => this.switchTab(btn.dataset.tab));
      });

      bind(els.fetch, 'click', () => this.fetchMedals(), 'fetch');
      const applySearch = () => {
        this.query = els.search.value;
        this.renderCats();
      };
      bind(els.search, 'input', applySearch, 'search');
      bind(els.search, 'compositionend', applySearch, 'search-ime');
      els.chips.forEach((chip) => {
        chip.addEventListener('click', () => {
          this.filter = chip.dataset.filter;
          els.chips.forEach((c) => c.classList.toggle('active', c === chip));
          this.renderCats();
        });
      });

      bind(els.catList, 'change', (e) => {
        const input = e.target;
        if (input && input.dataset.ruid) {
          this.store.toggleSelected(input.dataset.ruid, input.checked);
          this.renderCats();
          this.sync();
        }
      }, 'catList');

      bind(els.selectPage, 'click', () => this.selectAllFiltered(), 'selectPage');
      bind(els.clearSel, 'click', () => {
        this.store.clearSelected();
        this.log('info', '已清空全部选择。');
        this.renderCats();
        this.sync();
      }, 'clearSel');
      bind(els.resetGroup, 'click', () => {
        if (!window.confirm('把所有房间重置回「默认组」？')) return;
        const n = this.store.resetAllToDefault();
        this.log('ok', n > 0 ? `已将 ${n} 个房间重置回默认组。` : '所有房间已在默认组。');
        this.renderCats();
        this.renderJobs();
      }, 'resetGroup');
      bind(els.exportSel, 'click', () => this.exportSelection(), 'exportSel');
      bind(els.importSel, 'click', () => els.fileImport.click(), 'importSel');
      bind(els.fileImport, 'change', () => {
        const file = els.fileImport.files && els.fileImport.files[0];
        if (file) this.importSelectionFile(file);
        els.fileImport.value = '';
      }, 'fileImport');

      bind(els.optRow, 'change', (e) => {
        const input = e.target;
        if (input && input.dataset.key) {
          this.activeGroup()[input.dataset.key] = input.checked;
          this.store.saveGroups();
          this.renderJobs();
        }
      }, 'optRow');
      bind(els.rankPanel, 'change', (e) => {
        if (e.target.name === 'mc-rank-mode') {
          this.activeGroup().rankMode = e.target.value;
          this.store.saveGroups();
          this.renderJobs();
        }
      }, 'rankPanel');
      bind(els.rankTopN, 'change', () => {
        this.activeGroup().rankTopN = clamp(parseInt(els.rankTopN.value, 10) || 20, 1, 999);
        this.store.saveGroups();
        els.rankTopN.value = this.activeGroup().rankTopN;
      }, 'rankTopN');
      bind(els.rankUids, 'change', () => {
        this.activeGroup().rankUids = els.rankUids.value.trim();
        this.store.saveGroups();
        this.renderJobs();
      }, 'rankUids');
      bind(els.pokeTimes, 'change', () => {
        this.activeGroup().pokeTimes = clamp(parseInt(els.pokeTimes.value, 10) || 3, 1, 9);
        this.store.saveGroups();
        els.pokeTimes.value = this.activeGroup().pokeTimes;
      }, 'pokeTimes');
      bind(els.groupChips, 'click', (e) => {
        const btn = e.target.closest('[data-gid]');
        if (btn) {
          this.activeGroupId = btn.dataset.gid;
          this.renderJobs();
        }
      }, 'groupChips');
      bind(els.groupAdd, 'click', () => {
        const g = this.store.addGroup(`组${this.store.groups.length + 1}`);
        this.activeGroupId = g.id;
        this.log('info', `已新建任务组：${g.name}`);
        this.renderJobs();
        this.renderCats();
      }, 'groupAdd');
      bind(els.groupRename, 'click', () => {
        const g = this.activeGroup();
        const name = window.prompt('输入新的组名：', g.name);
        if (name && this.store.renameGroup(g.id, name.trim())) {
          this.log('info', `任务组已重命名为：${g.name}`);
          this.renderJobs();
          this.renderCats();
        }
      }, 'groupRename');
      bind(els.groupDel, 'click', () => {
        const g = this.activeGroup();
        if (g.id === this.store.groups[0].id) {
          this.log('warn', '默认组不能删除。');
          return;
        }
        if (this.store.groups.length <= 1) {
          this.log('warn', '至少保留一个任务组。');
          return;
        }
        if (!window.confirm(`删除任务组「${g.name}」？组内房间将回到默认组。`)) return;
        this.store.removeGroup(g.id);
        this.activeGroupId = this.store.groups[0].id;
        this.log('info', `已删除任务组：${g.name}`);
        this.renderJobs();
        this.renderCats();
      }, 'groupDel');

      bind(els.groupFilter, 'click', (e) => {
        const btn = e.target.closest('[data-gfilter]');
        if (btn) {
          this.groupFilter = btn.dataset.gfilter;
          this.renderCats();
        }
      }, 'groupFilter');
      bind(els.assignBtn, 'click', () => {
        const gid = els.assignGroup.value;
        if (!gid) {
          this.log('warn', '请先选择目标组。');
          return;
        }
        if (!this.store.selected.length) {
          this.log('warn', '请先勾选要分配的房间。');
          return;
        }
        const target = this.store.groups.find((x) => x.id === gid);
        const n = this.store.assignRoomsToGroup(this.store.selected, gid);
        this.log('ok', `已将 ${n} 个房间分配到「${target ? target.name : gid}」。`);
        this.renderCats();
        this.renderJobs();
      }, 'assignBtn');
      bind(els.modeRow, 'change', (e) => {
        if (e.target.name === 'mc-mode') {
          this.store.settings.mode = e.target.value;
          this.store.saveSettings();
        }
      }, 'modeRow');
      bind(els.cruiseMin, 'change', () => {
        this.store.settings.cruiseMinutes = clamp(parseInt(els.cruiseMin.value, 10) || 240, 5, 720);
        this.store.saveSettings();
        els.cruiseMin.value = this.store.settings.cruiseMinutes;
      }, 'cruiseMin');
      bind(els.blacklist, 'change', () => {
        this.store.settings.blacklist = els.blacklist.value.trim();
        this.store.saveSettings();
      }, 'blacklist');

      bind(els.start, 'click', () => this.engine.start(), 'start');
      bind(els.pause, 'click', () => {
        if (this.engine.paused) this.engine.resume();
        else this.engine.pause();
      }, 'pause');
      bind(els.stop, 'click', () => this.engine.stop(), 'stop');

      bind(els.clearToday, 'click', () => this.engine.resetToday(), 'clearToday');
      bind(els.logClear, 'click', () => { els.logBox.innerHTML = ''; }, 'logClear');
      bind(els.logExport, 'click', () => this.exportLog(), 'logExport');



      this._makeDraggable();
    }

    _makeDraggable() {
      const root = this.el.root;
      const header = this.el.header;
      if (!root || !header) {
        console.warn('[猫咪养成助手] 缺少面板元素，拖拽不可用');
        return;
      }
      let drag = null;
      const point = (e) => (e.touches && e.touches[0]) || e;
      const startDrag = (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        if (!e.target || !e.target.closest) return;
        if (!e.target.closest('#mc-header')) return;
        if (e.target.closest('button')) return;
        const p = point(e);
        drag = { dx: p.clientX - root.getBoundingClientRect().left, dy: p.clientY - root.getBoundingClientRect().top };
        e.preventDefault();
      };
      const moveDrag = (e) => {
        if (!drag) return;
        const p = point(e);
        const left = clamp(p.clientX - drag.dx, 8, window.innerWidth - root.offsetWidth - 8);
        const top = clamp(p.clientY - drag.dy, 8, window.innerHeight - root.offsetHeight - 8);
        root.style.left = `${left}px`;
        root.style.top = `${top}px`;
        e.preventDefault();
      };
      const endDrag = () => {
        if (drag) this._saveUi();
        drag = null;
      };
      document.addEventListener('mousedown', startDrag, true);
      document.addEventListener('mousemove', moveDrag, true);
      document.addEventListener('mouseup', endDrag, true);
      document.addEventListener('touchstart', startDrag, { capture: true, passive: false });
      document.addEventListener('touchmove', moveDrag, { capture: true, passive: false });
      document.addEventListener('touchend', endDrag, true);
      document.addEventListener('touchcancel', endDrag, true);
    }

    _saveUi() {
      const root = this.el.root;
      const collapsed = root.style.display === 'none';
      GM_setValue(STORAGE_KEYS.ui, {
        collapsed,
        w: root.offsetWidth,
        h: root.offsetHeight,
        left: parseInt(root.style.left, 10) || null,
        top: parseInt(root.style.top, 10) || null,
      });
    }

    _restoreUi() {
      const saved = safeParse(GM_getValue(STORAGE_KEYS.ui, null), {});
      if (saved.w && saved.h) {
        this.el.root.style.width = `${saved.w}px`;
        this.el.root.style.height = `${saved.h}px`;
      }
      if (saved.collapsed) {
        this.el.root.style.display = 'none';
        this.el.fab.hidden = false;
      }
    }

    toggleCollapsed() {
      const collapsed = this.el.root.style.display !== 'none';
      this.el.root.style.display = collapsed ? 'none' : '';
      this.el.fab.hidden = !collapsed;
      this._saveUi();
    }

    switchTab(tab) {
      this.el.tabs.forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
      this.el.pages.forEach((p) => {
        p.hidden = p.id !== `mc-page-${tab}`;
      });
      if (tab === 'jobs') this.renderJobs();
    }

    async fetchMedals() {
      const btn = this.el.fetch;
      btn.disabled = true;
      btn.textContent = '拉取中…';
      this.log('info', '开始拉取粉丝牌…');
      try {
        const info = await this.session.refresh();
        if (!info) {
          this.log('err', '未登录，无法拉取粉丝牌。');
          return;
        }
        const medals = [];
        const seen = new Set();
        let page = 1;
        for (;;) {
          let res = null;
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              res = await this.api.medals(page);
              break;
            } catch (e) {
              if (attempt === 0) await sleep(rand(800, 1600));
            }
          }
          if (!res || res.code !== 0) {
            this.log('err', `拉取粉丝牌失败：${res && res.message ? res.message : '未知错误'}`);
            break;
          }
          const panel = res.data || {};
          const items = [];
          if (page === 1 && Array.isArray(panel.special_list)) items.push(...panel.special_list);
          if (Array.isArray(panel.list)) items.push(...panel.list);
          items.forEach((item) => {
            const medal = item.medal || {};
            const ruid = String(medal.target_id || '');
            if (!ruid || seen.has(ruid)) return;
            seen.add(ruid);
            medals.push({
              ruid,
              target_name: (item.anchor_info && item.anchor_info.nick_name) || ruid,
              medal_name: medal.medal_name || '',
            });
          });
          this.log('info', `第 ${page} 页完成，累计 ${medals.length} 个粉丝牌。`);
          const hasMore = panel.page_info && panel.page_info.has_more;
          if (!hasMore || !items.length) break;
          page++;
          await sleep(rand(600, 1200));
        }
        if (medals.length) {
          this.store.medals = medals;
          GM_setValue(STORAGE_KEYS.medals, medals);
          const known = new Set(medals.map((m) => String(m.ruid)));
          this.store.selected = this.store.selected.filter((r) => known.has(r));
          this.store.saveSelected();
          this.log('ok', `粉丝牌拉取完成，共 ${medals.length} 个。`);
        } else {
          this.log('warn', '未拉取到粉丝牌。若没有粉丝牌，可使用「输入无牌 UID」直接添加主播。');
        }
      } catch (e) {
        this.log('err', `拉取粉丝牌异常：${e.message}`);
      } finally {
        btn.disabled = false;
        btn.textContent = '拉取粉丝牌';
        this.renderCats();
        this.sync();
      }
    }









    selectAllFiltered() {
      const list = this.filteredRooms();
      if (!list.length) return;
      const allChecked = list.every((r) => this.store.selected.includes(r.ruid));
      list.forEach((r) => this.store.toggleSelected(r.ruid, !allChecked));
      this.renderCats();
      this.sync();
    }

    filteredRooms() {
      const all = this.store.allRooms();
      const q = this.query.trim().toLowerCase();
      let list = all;
      if (q) {
        const terms = q.split(/\s+/).filter(Boolean);
        list = list.filter((r) => {
          const hay = `${r.name} ${r.medal} ${r.ruid}`.toLowerCase();
          return terms.every((t) => hay.includes(t));
        });
      }
      if (this.filter === 'sel') list = list.filter((r) => this.store.selected.includes(r.ruid));
      if (this.filter === 'unsel') list = list.filter((r) => !this.store.selected.includes(r.ruid));
      if (this.groupFilter) list = list.filter((r) => this.store.groupFor(r.ruid).id === this.groupFilter);
      return list;
    }

    exportSelection() {
      const data = this.store.selectedRooms().map((r) => ({ ruid: r.ruid, name: r.name }));
      if (!data.length) {
        this.log('warn', '当前没有已选房间可导出。');
        return;
      }
      downloadFile(`cat-butler-selection-${today()}.json`, JSON.stringify(data, null, 2));
      this.log('ok', `已导出 ${data.length} 个房间的选择配置。`);
    }

    importSelectionFile(file) {
      const reader = new FileReader();
      reader.onload = () => {
        const text = String(reader.result || '');
        let list = [];
        try {
          const arr = JSON.parse(text);
          if (Array.isArray(arr)) {
            list = arr.map((x) => ({ ruid: toUid(x.ruid), name: String(x.name || x.ruid) })).filter((x) => x.ruid);
          }
        } catch (e) {
          /* 格式无法识别 */
        }
        if (!list.length) {
          this.log('err', '导入内容为空或格式无法识别（请使用导出的 JSON 文件）。');
          return;
        }
        const known = new Set(this.store.allRooms().map((r) => r.ruid));
        const applied = list.filter((r) => known.has(r.ruid));
        const skipped = list.length - applied.length;
        applied.forEach((r) => this.store.toggleSelected(r.ruid, true));
        if (skipped > 0) this.log('warn', `${skipped} 个 UID 不在粉丝牌列表中，已跳过。`);
        this.log('ok', `已选中 ${applied.length} 个房间。`);
        this.sync();
      };
      reader.readAsText(file);
    }

    exportLog() {
      const lines = Array.from(this.el.logBox.children).map((d) => d.textContent).join('\n');
      if (!lines) {
        this.log('warn', '日志为空。');
        return;
      }
      downloadFile(`cat-butler-log-${today()}.txt`, lines, 'text/plain');
    }

    renderLogin() {
      const info = this.session.info;
      this.el.loginBar.classList.toggle('on', !!info);
      this.el.loginText.textContent = info
        ? `已登录：${info.name}${info.offline ? '（本地判定）' : ''}（点击刷新）`
        : '未登录（点击刷新检测）';
    }

    renderCats() {
      const all = this.store.allRooms();
      const list = this.filteredRooms();
      this.el.catList.innerHTML = list.map((r) => {
        const checked = this.store.selected.includes(r.ruid) ? 'checked' : '';
        const grp = this.store.groupFor(r.ruid);
        return `<label class="mc-cat-item">
          <input type="checkbox" data-ruid="${escapeHtml(r.ruid)}" ${checked} />
          <span class="mc-cat-main">
            <span class="mc-cat-name">${escapeHtml(r.name)}<span class="mc-tag">${escapeHtml(r.medal || r.source)}</span><span class="mc-tag mc-group-tag">${escapeHtml(grp.name)}</span></span>
            <span class="mc-cat-sub">${escapeHtml(r.ruid)}</span>
          </span>
        </label>`;
      }).join('') || (all.length
        ? '<div class="mc-empty">没有匹配结果，换个关键词试试</div>'
        : '<div class="mc-empty">暂无粉丝牌缓存：请先点击「拉取粉丝牌」</div>');
      this.el.meta.textContent = this.store.medals.length
        ? `粉丝牌缓存 ${this.store.medals.length} 个 · 共 ${all.length} 个房间`
        : '粉丝牌缓存：无（先点「拉取粉丝牌」）';
      this.el.selectedCount.textContent = `已选 ${this.store.selected.length}`;
      this.el.groupFilter.innerHTML = `<button class="mc-chip${!this.groupFilter ? ' active' : ''}" data-gfilter="">全部组</button>` +
        this.store.groups.map((grp) => `<button class="mc-chip${this.groupFilter === grp.id ? ' active' : ''}" data-gfilter="${escapeHtml(grp.id)}">${escapeHtml(grp.name)}</button>`).join('');
      this.el.assignGroup.innerHTML = this.store.groups.map((grp) => `<option value="${escapeHtml(grp.id)}">${escapeHtml(grp.name)}</option>`).join('');
    }

    _countUids(text) {
      const seen = new Set();
      String(text || '').split(/[\r\n,，;；\s]+/).forEach((raw) => {
        const uid = String(raw || '').replace(/\D/g, '');
        if (uid) seen.add(uid);
      });
      return seen.size;
    }

    renderJobs() {
      const s = this.store.settings;
      const g = this.activeGroup();
      this.el.groupChips.innerHTML = this.store.groups.map((grp) =>
        `<button class="mc-chip${grp.id === g.id ? ' active' : ''}" data-gid="${escapeHtml(grp.id)}">${escapeHtml(grp.name)}</button>`
      ).join('');
      this.el.optRow.innerHTML = SWITCH_META.map((m) => {
        const on = g[m.key] ? ' on' : '';
        return `<label class="mc-switch${on}"><input type="checkbox" data-key="${m.key}" ${g[m.key] ? 'checked' : ''} /><span>${m.label}</span></label>`;
      }).join('');
      const rankOn = !!g.petRank;
      this.el.rankPanel.hidden = !rankOn;
      if (rankOn) {
        this.el.rankPanel.querySelectorAll('input[name="mc-rank-mode"]').forEach((r) => {
          r.checked = r.value === g.rankMode;
        });
        this.el.rankTopN.value = g.rankTopN;
        this.el.pokeTimes.value = g.pokeTimes;
        this.el.rankUids.value = g.rankUids;
        const uidCount = this._countUids(g.rankUids);
        this.el.rankUidMeta.textContent = uidCount ? `已导入 ${uidCount} 个 UID` : '';
      }
      this.el.modeRow.querySelectorAll('input[name="mc-mode"]').forEach((r) => {
        r.checked = r.value === s.mode;
      });
      this.el.cruiseMin.value = s.cruiseMinutes;
      this.el.blacklist.value = s.blacklist;

      const rooms = this.store.selectedRooms();
      this.el.roomList.innerHTML = rooms.map((r) => {
        const state = this.engine ? this.engine.roomState(r.ruid) : 'idle';
        const grp = this.store.groupFor(r.ruid);
        const stages = this.store.enabledStages(r.ruid).filter((k) => this.store.stageDone(r.ruid, k)).length;
        const total = Math.max(1, this.store.enabledStages(r.ruid).length);
        return `<div class="mc-room">
          <span class="mc-room-main">
            <span class="mc-room-name">${escapeHtml(r.name)}<span class="mc-tag mc-group-tag">${escapeHtml(grp.name)}</span></span>
            <span class="mc-room-uid">${escapeHtml(r.ruid)}</span>
          </span>
          <span class="mc-state ${state}">${STATE_LABELS[state] || state}</span>
          <span class="mc-room-stages">${stages}/${total}</span>
        </div>`;
      }).join('') || '<div class="mc-empty">尚未选择房间，去「猫咪」页挑选</div>';

      const done = rooms.filter((r) => this.store.roomDone(r.ruid)).length;
      const total = rooms.length || 1;
      this.el.ringPct.textContent = `${Math.round((done / total) * 100)}%`;
      this.el.ringSub.textContent = `${done} / ${rooms.length}`;
      this.el.ringFg.style.strokeDasharray = String(RING_CIRC);
      this.el.ringFg.style.strokeDashoffset = String(RING_CIRC * (1 - done / total));

      const running = !!(this.engine && this.engine.running);
      const paused = !!(this.engine && this.engine.paused);
      this.el.start.disabled = running;
      this.el.pause.disabled = !running;
      this.el.stop.disabled = !running;
      this.el.pause.textContent = paused ? '▶ 继续' : '⏸ 暂停';
    }

    renderStats() {
      const st = this.store.stats;
      this.el.stats.textContent = `今日 +${st.growth} 成长 · 猫粮 ${st.food} · 摸 ${st.pets} 次${st.gifts ? ` · 手幅 ${st.gifts}` : ''}`;
    }

    sync() {
      this.renderLogin();
      this.renderCats();
      this.renderJobs();
      this.renderStats();
    }

    log(level, text) {
      const box = this.el.logBox;
      if (!box) {
        console.log(`[猫咪养成助手][${level}]`, text);
        return;
      }
      const line = document.createElement('div');
      line.className = `mc-log-line ${level}`;
      const t = document.createElement('span');
      t.className = 't';
      t.textContent = new Date().toLocaleTimeString();
      line.appendChild(t);
      line.appendChild(document.createTextNode(text));
      box.appendChild(line);
      box.scrollTop = box.scrollHeight;
      while (box.children.length > 400) box.removeChild(box.firstChild);
    }
  }

  /* ===================== 菜单与启动 ===================== */
  function registerMenu(engine, ui) {
    try {
      if (typeof GM_registerMenuCommand !== 'function') return;
      GM_registerMenuCommand('▶ 开始养猫任务', () => engine.start());
      GM_registerMenuCommand('⏸ 暂停 / ▶ 继续', () => {
        if (engine.paused) engine.resume();
        else if (engine.running) engine.pause();
        else engine.start();
      });
      GM_registerMenuCommand('⏹ 停止任务', () => engine.stop());
      GM_registerMenuCommand('🗑 清空今日进度', () => engine.resetToday());
      GM_registerMenuCommand('🪟 折叠 / 展开面板', () => ui.toggleCollapsed());
    } catch (e) {
      /* 菜单注册失败不影响主功能 */
    }
  }

  function init() {
    if (window.__MIAO_BUTLER_ACTIVE__) {
      console.warn('[猫咪养成助手] 检测到脚本重复执行，跳过本次初始化。');
      return;
    }
    window.__MIAO_BUTLER_ACTIVE__ = true;
    console.log(`[猫咪养成助手] v${SCRIPT_VERSION} 初始化开始`);
    try {
      const store = new Store();
      const session = new Session();
      const api = new ApiClient(session);
      session.api = api;
      const ui = new Ui({ store, session, api });
      const engine = new TaskEngine({ store, api, session, ui });
      ui.engine = engine;
      ui.build();
      ui.log('info', `猫咪养成助手 v${SCRIPT_VERSION} 已加载。`);
      session.refresh().then(() => {
        ui.renderLogin();
        if (session.info) {
          ui.log('ok', `已登录：${session.info.name}`);
          setTimeout(() => {
            ui.log('info', '自动拉取粉丝牌…');
            ui.fetchMedals();
          }, 800);
        } else {
          ui.log('err', `登录检测失败：${(session.lastError && session.lastError.message) || '未检测到登录态（点击顶栏可重试）'}`);
        }
      }).catch((e) => {
        ui.renderLogin();
        ui.log('err', `登录检测异常：${e.message}`);
      });
      registerMenu(engine, ui);
    } catch (e) {
      console.error('[猫咪养成助手] 初始化失败：', e);
    }
  }

  if (document.body) {
    init();
  } else {
    window.addEventListener('DOMContentLoaded', init, { once: true });
  }
})();
