/**
 * 家族归键。
 *
 * 为什么需要它：字体文件里 family 字段的写法极不统一。
 *   "NimbusSans"  / "Nimbus Sans"        —— 同一款，只差空格
 *   "Source Han Serif CN"（英） / "思源宋体 CN"（本地面）—— 同一款，语言不同
 *   "Source Han Sans CN Bold"            —— 带进了字重后缀，但 subfamily 还是「常规」
 *
 * 设计原则：只合并「确定是同一款」的，宁可多留一张卡，也不把 Wingdings 1/2/3
 * 或 YaHei / YaHei UI 这种本来就该分开的家族硬塞到一起。
 * Illustrator 自己的字体菜单就是分开列的，我们的分组必须跟它一致，
 * 否则用户在面板里找到的家族，在 AI 里又是另一个名字。
 */

/** 款式后缀：出现在 family 名末尾基本就是被误带进来的字重 */
const STYLE_TOKENS = new Set([
  "regular", "bold", "light", "medium", "italic", "oblique", "book", "heavy",
  "black", "thin", "semibold", "extrabold", "ultralight", "ultrabold",
  "extralight", "demibold", "normal", "roman", "plain",
]);

/**
 * 切成 token。分隔符和驼峰边界都切，这样 "NimbusSans" 与 "Nimbus Sans"
 * 都得到 ["Nimbus","Sans"]，而 "Arimo" 保持单个 token 不被误切。
 */
export function tokenizeFamily(name: string): string[] {
  const s = (name || "")
    // 小写→大写：NimbusSans → Nimbus Sans
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    // 缩写紧跟驼峰：SCRegular → SC Regular
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[\s_\-.·]+/g, " ")
    .trim();
  return s ? s.split(" ") : [];
}

/**
 * 去掉末尾的款式 token。只在「还剩至少两个 token」时动手，
 * 避免把 "Book" 这种本身就是家族名的单 token 抹成空。
 *
 * 末尾纯数字的处理分两种：
 *   "Avenir 45 Book" → 先去掉 Book（款式），45 属于款式编号，一起走
 *   "Wingdings 2"    → 没去过款式，2 是家族序号，必须留着（否则 1/2/3 会被合并）
 *   "Avenir 65"      → 两位数，是 Avenir 的字重编号，去掉
 */
export function stripStyleTokens(tokens: string[]): string[] {
  const out = [...tokens];
  let strippedStyle = false;
  while (out.length > 1) {
    const last = out[out.length - 1];
    const low = last.toLowerCase();

    if (STYLE_TOKENS.has(low)) {
      out.pop();
      strippedStyle = true;
      continue;
    }
    if (/^\d+$/.test(low)) {
      if (strippedStyle || low.length >= 2) {
        out.pop();
        continue;
      }
    }
    break;
  }
  return out;
}

/**
 * 家族归键。英文名优先 —— 同一款字体的各 face 英文名是一致的，
 * 而本地面名可能有的有、有的没有，用它归键会把同一款拆开。
 */
export function familyKeyOf(family: string, postScriptName?: string): string {
  const base = (family || "").trim() || (postScriptName || "").trim();
  if (!base) return "";
  const tokens = stripStyleTokens(tokenizeFamily(base));
  const key = tokens.join("").toLowerCase();
  return key || base.toLowerCase().replace(/[\s_\-.·]+/g, "");
}
