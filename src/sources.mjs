/**
 * 线路源定义。BASE_LINES / SEARCH_PAGES / extractUrls 从 reference/apk/assets/index.html 原样移植。
 * 可选覆盖文件 config/sources.json：存在则整体替换内置值；文件损坏时回退内置并打日志。
 */
import fs from 'node:fs';
import path from 'node:path';

const SEARCH_PAGES = [
  // 软件下载站聚合页（页面内含影视仓 App/接口下载链接）
  'https://m.7xz.com/softs/43518.html',
  'https://www.9k9k.com/app/52116.html',
  'https://m.52pk.com/soft/37066zmfvyf.html',
  'https://m.niucoo.cn/app/14651.html',
  'https://shouyou.3dmgame.com/ios/532920.html',
  'https://m.7po.com/rj/11305.html',
  'https://flowus.cn/ahuage/share/0cee252a-9d5e-44bf-9603-67844b5dda2b',
  'https://flowus.cn/share/1f2076ff-183f-4263-a0a2-6234fb89dcf1',
  // 多仓聚合 JSON（抓取后 extractUrls 提取其中大量子仓 URL）
  'https://jihulab.com/ygbh1/box/-/raw/main/dcang/dc2.json',
  'https://jihulab.com/ygbh1/box/-/raw/main/dcang/ygbh.json',
  'https://gitlab.com/ygbh1/666/-/raw/main/dcang/ygbh.json',
  'https://yydsys.top/duo',
  'https://xhdwc.tk/0',
  'https://pastebin.com/raw/5NHaxyGR',
  'https://agit.ai/Yoursmile7/TVBox/raw/branch/master/XC.json',
  'https://agit.ai/relax/adcc/raw/branch/master/tvbox.json',
  'https://codeberg.org/AK47/drpy-js/raw/branch/main/js.json',
  'https://raw.githubusercontent.com/FongMi/CatVodSpider/main/json/config.json'
];

const BASE_LINES = [
  ['饭太硬', 'http://www.饭太硬.com/tv'], ['摸鱼儿', 'http://我不是.摸鱼儿.com'],
  ['肥猫', 'http://肥猫.com'], ['肥猫live', 'http://肥猫.live'],
  ['神秘哥哥备用', 'http://fty.xxooo.cf/tv'], ['毒盒', 'https://毒盒.com/tv/'],
  ['动漫城', 'https://www.yingm.cc/dm/dm.json'], ['俊佬', 'http://home.jundie.top:81/top98.json'],
  ['欧歌', 'https://play.iptv365.org/欧歌/api.json'], ['小米', 'https://play.iptv365.org/小米/api.json'],
  ['4K云盘', 'https://9xi4o.tk/0725.json'], ['巧儿', 'http://pandown.pro/tvbox/tvbox.json'],
  ['胖虎', 'https://notabug.org/imbig66/tv-spider-man/raw/master/配置/0801.json'],
  ['传说', 'https://chuanshuo.77blog.cn/tv.json'], ['宝盒接口', 'http://宝盒接口.top'],
  ['高天流云', 'https://raw.githubusercontent.com/gaotianliuyun/gao/master/js.json'],
  ['影视仓聚合', 'https://raw.githubusercontent.com/wxrjck/-YSC-/refs/heads/main/wx.json'],
  ['多多聚合', 'https://raw.liucn.cc/box/dm.txt'], ['liucn-m', 'https://raw.liucn.cc/box/m.json'],
  ['gitee自建', 'https://gitee.com/lukei7/lib/raw/Luck/自建.json'],
  ['gitee-bls', 'https://gitee.com/blssss/jk/raw/api/bls.json'],
  ['gitee青龙', 'https://gitee.com/yiwu369/6758/raw/master/青龙/1.json'],
  ['dxawi', 'https://dxawi.github.io/0/0.json'], ['kjsc0310', 'https://kjsc0310.github.io/tvy/jk9.json'],
  ['猫技多仓', 'https://agit.ai/ddx/TVBox/raw/branch/master/d.json'],
  ['影视仓多仓-gitlab', 'https://gitlab.com/ygbh1/666/-/raw/main/dcang/ygbh.json'],
  ['月光宝盒多仓', 'https://jihulab.com/ygbh1/box/-/raw/main/dcang/dc.json'],
  ['月光影视仓', 'https://jihulab.com/ygbh1/box/-/raw/main/dcang/ygbh.json'],
  ['宝盒多仓2', 'https://jihulab.com/ygbh1/box/-/raw/main/dcang/dc2.json'],
  ['宝盒max多仓', 'https://agit.ai/butterfly/md/raw/branch/master/zYGBHmax'],
  ['多多接口多仓', 'https://jihulab.com/duomv/apps/-/raw/main/fast.json'],
  ['多多多仓', 'https://jihulab.com/duomv/apps/-/raw/main/duo.json'],
  ['影视仓多仓-52bsj', 'http://52bsj.vip:98/xiaohu'], ['吾爱仓库', 'http://52bsj.vip:98/wuaihosue'],
  ['小胡软件多仓', 'https://agit.ai/xiaohu/tvbox/raw/branch/main/duocang'],
  ['云星日记仓库', 'https://itvbox.cc/可视TV/云星日记/仓库.json'],
  ['猎狼多仓', 'http://tvbox.lltv8.top'], ['多仓-134', 'http://134.122.170.64/dc.json'],
  ['春风影视', 'https://369936.xyz/web119'], ['欧哥仓', 'http://tv.nxog.top'],
  ['日后仓', 'http://rihou.cc:66/'], ['奇奇多仓', 'https://cn.kstore.space/download/2904/123.txt'],
  ['D佬魔改线路', 'https://download.kstore.space/download/2883/nzk/nzk0722.json'],
  ['蚂蚁线路', 'https://cn.kstore.space/download/2883/0110.txt'],
  ['青龙线路', 'https://6758.kstore.space/1.json'],
  ['fmys', 'http://fmys.top/fmys.json'], ['奇奇', 'http://z.qiqiv.cn/123'],
  ['kstore-wex', 'https://9280.kstore.space/wex.json'],
  ['qxys', 'https://7337.kstore.space/qxys/禁止传播.json'],
  ['weixine', 'https://weixine.net/ysc.json'], ['zzzzz-tv', 'https://zzzzz.tv/tv/ys.json'],
  ['zzzzz-svip', 'https://zzzzz.tv/tv/svip.json'], ['qiaoji8', 'http://cdn.qiaoji8.com/tvbox.json'],
  ['meowcf', 'https://freed.yuanhsing.cf/TVBox/meowcf.json'],
  ['hcr-MMM', 'https://agit.ai/hu/hcr/raw/branch/master/MMM.txt'],
  ['wds-223843', 'https://wds.ecsxs.com/223843.txt']
];

/** 从页面/JSON 文本里提取疑似线路地址（APK 原语义：白名单关键词 + 黑名单过滤，最多 60 条） */
export function extractUrls(html) {
  const re = /https?:\/\/[^\s"'<>()\[\]]+/g;
  const skipSuffix = /\.(png|jpe?g|gif|webp|svg|ico|css|js|woff2?|ttf|eot|mp4|mp3|zip)$/i;
  const skipKw = ['github.com/', 'gitlab.com/', 'gitee.com/', 'zhihu.com', 'bilibili', 'baidu.com', 'google.com',
    'bing.com', 'youtube', 'douyin', 'weibo', 'taobao', 'jd.com', 'xiaomi.com', '360.cn', 'sohu', '163.com', 'sina.com',
    'cloudflare', 'jsdelivr.net', 'unpkg.com', 'gravatar', 'w3.org', 'mozilla.org', 'jquery', 'bootstrap',
    'miit.gov.cn', 'flowus.cn', 'allflow.cn', 'staticfile.org', 'cdn.staticfile'];
  const lineKw = ['/tv', '/box', '/api', '.json', '.txt', '/dc', 'kstore', 'jundie', 'catvod', 'tvbox', 'yingm',
    'liucn', 'nxog', 'tspider', '/dm/', 'dcang', '仓库', '线路', '接口', '配置'];
  const out = [];
  const m = String(html == null ? '' : html).match(re) || [];
  for (let u of m) {
    u = u.replace(/[.,;:，。；：、\)\]"}>]+$/, '');
    const low = u.toLowerCase();
    if (skipSuffix.test(low) || skipKw.some(k => low.includes(k)) || !u.startsWith('http')) continue;
    if (low.includes('.html') || low.includes('/app/') || low.includes('/soft') || low.includes('/zt')) continue;
    if (!lineKw.some(k => low.includes(k))) continue;
    if (!out.includes(u)) out.push(u);
    if (out.length >= 60) break;
  }
  return out;
}

/**
 * 读取生效的线路源定义。
 * @param {{ rootDir?: string, configDir?: string, logger?: Console }} [opts]
 * @returns {{ baseLines: string[][], searchPages: string[], effectiveFrom: 'builtin'|'file', configPath: string }}
 */
export function loadSources(opts) {
  const o = opts || {};
  const rootDir = o.rootDir || process.cwd();
  const configDir = o.configDir || path.join(rootDir, 'config');
  const configPath = path.join(configDir, 'sources.json');
  const log = o.logger || console;
  const builtin = { baseLines: BASE_LINES.map(([n, u]) => [n, u]), searchPages: SEARCH_PAGES.slice(), effectiveFrom: 'builtin', configPath };
  try {
    if (!fs.existsSync(configPath)) return builtin;
    const raw = fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '');
    const obj = JSON.parse(raw);
    const rawLines = Array.isArray(obj && obj.baseLines) ? obj.baseLines : [];
    const rawPages = Array.isArray(obj && obj.searchPages) ? obj.searchPages : [];
    const baseLines = rawLines
      .filter(x => Array.isArray(x) && x.length >= 2 && typeof x[1] === 'string' && x[1].trim())
      .map(x => [String(x[0] == null ? '' : x[0]), String(x[1]).trim()]);
    const searchPages = rawPages.filter(x => typeof x === 'string' && /^https?:\/\//i.test(x.trim())).map(x => x.trim());
    if (!baseLines.length && !searchPages.length) throw new Error('baseLines 与 searchPages 均为空');
    log.log('[sources] 使用 config/sources.json 覆盖：baseLines=' + baseLines.length + ' searchPages=' + searchPages.length);
    return { baseLines, searchPages, effectiveFrom: 'file', configPath };
  } catch (e) {
    log.warn('[sources] config/sources.json 无效，回退内置线路：' + (e && e.message ? e.message : String(e)));
    return builtin;
  }
}

export { BASE_LINES, SEARCH_PAGES };
