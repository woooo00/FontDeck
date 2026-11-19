"""常驻 OCR 进程。

为什么不做成「一行命令识别一张图」：
RapidOCR 加载模型要 0.3 秒，逐字调用的话 20 个字就是 6 秒，全是重复加载。
这里做成常驻子进程，stdin 读请求、stdout 写响应，模型只加载一次，
之后每个字约 6ms。

协议（一行一个 JSON）：

    1) 就绪握手（启动时主动输出一行）
       {"id": 0, "ready": true, "engine": "rapidocr"}

    2) 直接识别一堆 base64 图
       请求 {"id": 1, "items": ["<base64 png>", ...]}
       响应 {"id": 1, "results": [{"text": "永", "score": 0.46}, ...]}

    3) 从一张大图里按框裁剪再逐字识别（转曲恢复走这条）
       请求 {"id": 2, "png": "C:/.../scan.png",
             "boxes": [[l,t,r,b], ...], "pad": 3}
       响应 {"id": 2, "results": [{"text": "永", "score": 0.46,
                                   "box": [l,t,r,b], "polarity": "dark"}, ...]}

    4) 按路径几何渲染位图（转曲恢复的主通道）
       请求 {"id": 5, "cmd": "render", "out": "C:/.../geom.png",
             "w": 1200, "h": 420, "ss": 3,
             "shapes": [{"c": 1, "p": [[ax,ay,ix,iy,ox,oy, ...]]}, ...]}
       响应 {"id": 5, "results": [{"png": "...", "w": 1200, "h": 420,
                                   "shapes": [[l,t,r,b], ...]}]}

    5) 探活
       {"id": 0, "cmd": "ping"}

关键设计：**不走检测模块**。
转曲文字每个字都是独立轮廓，位置已知，不需要自动检测。
实测 PaddleOCR 的 DB 检测器会把「单行无上下文的长文本」切碎并重叠
（「永和九年」+「L年岁在癸丑」拼成「永和九年九年岁在癸丑」），
调 unclip_ratio 只会更糟。关掉检测逐字识别反而到 97.7%。
"""

import base64
import json
import math
import os
import sys

import cv2
import numpy as np

# 东斯拉夫语（俄语 / 乌克兰语 / 白俄 / 保加利亚）识别模型。
# 默认的 ch_PP-OCRv3_rec 字典只有中文 + 拉丁，遇到西里尔字母只能按字形
# 凑成 "nPEAynPEAEHE" 这种拉丁+数字串，而且置信度还不低（0.72~0.84）。
# 这个模型来自 monkt/paddleocr-onnx 的 eslav 分组（PP-OCRv5），
# 字典含 76 个西里尔字符。整篇分数偏低时才懒加载，中英文稿零开销。
MODEL_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models")
RU_REC = os.path.join(MODEL_DIR, "eslav_rec.onnx")
RU_DICT = os.path.join(MODEL_DIR, "eslav_dict.txt")


def ru_available() -> bool:
    return os.path.exists(RU_REC) and os.path.exists(RU_DICT)


def build_engine(lang="zh"):
    from rapidocr_onnxruntime import RapidOCR

    engine = RapidOCR()
    # 这两行是整个方案的关键：关掉检测与方向分类，只留识别
    engine.use_text_det = False
    engine.use_angle_cls = False

    if lang == "ru":
        # rapidocr_onnxruntime 1.2.3 的 UpdateParameters 只把 rec_model_path
        # 映射成 model_path，rec_keys_path 不会变成识别器读的 keys_path，
        # 直接传会报 character_dict_path should not be None。
        # 所以构造好默认引擎后，直接替换它的识别器。
        from rapidocr_onnxruntime.ch_ppocr_v3_rec import TextRecognizer

        engine.text_recognizer = TextRecognizer({
            "model_path": RU_REC,
            "keys_path": RU_DICT,
            "rec_img_shape": [3, 48, 320],
            "rec_batch_num": 6,
            "use_cuda": False,
        })
    return engine


_ENGINES = {}


def get_engine(lang="zh"):
    if lang not in _ENGINES:
        _ENGINES[lang] = build_engine(lang)
    return _ENGINES[lang]


def avg_score(items) -> float:
    s = [float(x.get("score") or 0) for x in items if x.get("text")]
    return sum(s) / len(s) if s else 0.0


def cyrillic_ratio(items) -> float:
    """结果里西里尔字母的占比，用来防止中文稿被俄语引擎误接管。"""
    s = "".join(str(x.get("text") or "") for x in items)
    if not s:
        return 0.0
    return sum(1 for c in s if "\u0400" <= c <= "\u04FF") / len(s)


def decode_png(b64: str):
    """base64 → BGR ndarray。失败返回 None。"""
    try:
        raw = base64.b64decode(b64)
    except Exception:  # noqa: BLE001
        return None
    arr = np.frombuffer(raw, dtype=np.uint8)
    if arr.size == 0:
        return None
    return cv2.imdecode(arr, cv2.IMREAD_COLOR)


def is_dark_background(gray) -> bool:
    """判断是不是深底白字。

    不能用「边缘像素中位数」：转曲文字的裁剪框就是墨迹包围盒，
    四条边必然压在笔画上，中位数会被笔画带成深色，于是每个字都被误判成
    深底白字而反相 —— 表现是识别结果大面积为空。

    改用 Otsu 把像素分成两类，比为「背景」的那一类更多就是背景。
    再加一道保险：只有暗像素占绝对多数（>62%）才认定深底。
    黑体加粗的密字笔画占比能到 50% 上下，留出余量才不会误反相。
    """
    h, w = gray.shape[:2]
    if h < 4 or w < 4:
        return False

    try:
        th, _ = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    except Exception:  # noqa: BLE001
        return False

    dark_ratio = float((gray < th).sum()) / float(gray.size)
    return dark_ratio > 0.62


def prepare_crop(crop, pad_ratio: float = 0.18):
    """把一个字的裁剪图整理成识别器喜欢的样子。

    三件事：
      1. 深底白字反相 —— OCR 模型只认得白底深字
      2. 补白边 —— 字形贴边会让边缘特征丢失
      3. 长宽比过分的字（如「一」「丨」）补到接近方形，
         否则识别器 resize 到固定高度后宽度几乎没信息
    """
    if crop is None or crop.size == 0:
        return None, "empty"

    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY) if crop.ndim == 3 else crop
    polarity = "dark"
    if is_dark_background(gray):
        crop = 255 - crop
        polarity = "light"

    h, w = crop.shape[:2]

    # 补到接近方形：太扁的补上下，太瘦的补左右
    target = max(h, w)
    if target > 0:
        square = np.full((target, target, 3), 255, dtype=np.uint8)
        y0 = (target - h) // 2
        x0 = (target - w) // 2
        square[y0 : y0 + h, x0 : x0 + w] = crop
        crop = square

    # 再留一圈白边
    h, w = crop.shape[:2]
    pad = max(2, int(round(max(h, w) * pad_ratio)))
    crop = cv2.copyMakeBorder(
        crop, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=(255, 255, 255)
    )

    return crop, polarity


def recognize_array(engine, img) -> dict:
    try:
        result, _ = engine.text_recognizer([img])
    except Exception as e:  # noqa: BLE001
        return {"text": "", "score": 0.0, "error": "recognize_failed: %s" % e}

    if not result:
        return {"text": "", "score": 0.0}

    return {"text": str(result[0][0]), "score": round(float(result[0][1]), 4)}


def pick_best(cands: list) -> dict:
    """从多个预处理变体的识别结果里挑一个最可信的。

    两个规则，都是实测逼出来的：

    1) **单字优先**。一个框就是一个字，返回「唱喝」「:喝」「i爱·」这种
       多字符结果一定是识别器把笔画拆错了。而且它对多字符往往更「自信」
       （实测 ':喝' 0.59 > '喝' 0.42），单纯取最高分会主动把错字选进来。
       只要有单字候选，多字符候选一律不参与竞争。

    2) **按字投票，而不是比单次分数**。同一张字的四个视图常常给出不同答案
       （「喝」框实测：standard=喝 / pad55=唱 / scale=喝 / raw=喝）。
       多数决比「谁分数高听谁的」稳得多；票数相同再比分数总和。
    """
    def text(c):
        return str(c.get("text") or "")

    def key_char(t):
        """取串里第一个汉字。':喝' / 'i爱·' 这类误识要归到「喝」「爱」，
        而不是把标点当成一个字；纯拉丁/数字串没有汉字就原样保留。"""
        if len(t) == 1:
            return t
        for ch in t:
            if "\u3400" <= ch <= "\u9fff":
                return ch
        return t

    singles = [c for c in cands if len(text(c)) == 1]
    pool = singles or [c for c in cands if text(c)]
    if not pool:
        return cands[0] if cands else {"text": "", "score": 0.0}

    votes = {}
    for c in pool:
        key = key_char(text(c))
        if not key:
            continue
        v = votes.setdefault(key, {"n": 0, "sum": 0.0, "best": c})
        v["n"] += 1
        v["sum"] += float(c.get("score") or 0)
        if (c.get("score") or 0) > (v["best"].get("score") or 0):
            v["best"] = c

    if not votes:
        return cands[0] if cands else {"text": "", "score": 0.0}

    best_key = sorted(
        votes, key=lambda k: (votes[k]["n"], votes[k]["sum"]), reverse=True
    )[0]
    chosen = votes[best_key]["best"]
    out = dict(chosen)
    out["variant"] = chosen.get("variant", "standard")
    out["votes"] = votes[best_key]["n"]

    # 所有变体都给了多字符：多半是框把两个字并进来了。能提出单个汉字就
    # 用它，避免凭空多字；纯拉丁串保留原样，前端标黄交给用户处理。
    if len(text(out)) > 1:
        k = key_char(text(out))
        if len(k) == 1:
            out["text"] = k
            out["truncated"] = True
        else:
            out["multi"] = True
    return out


def recognize_b64(engine, b64: str) -> dict:
    img = decode_png(b64)
    if img is None:
        return {"text": "", "score": 0.0, "error": "decode_failed"}
    return recognize_array(engine, img)


def recognize_crops(engine, png_path: str, boxes, pad: int, dump_dir: str = "") -> list:
    """从一张大图里按包围盒逐字裁剪识别。

    dump_dir 非空时把每张预处理后的图存下来 —— 识别结果不对时，
    光看原图看不出「裁剪+增强」这一步做了什么，必须能直接看图。
    """
    img = cv2.imread(png_path)
    if img is None:
        return [
            {"text": "", "score": 0.0, "error": "cannot_read_image", "box": b}
            for b in boxes
        ]

    dump = ""
    if dump_dir:
        try:
            import os

            if not os.path.isdir(dump_dir):
                os.makedirs(dump_dir)
            dump = dump_dir
        except Exception:  # noqa: BLE001
            dump = ""

    h, w = img.shape[:2]
    out = []

    for idx, box in enumerate(boxes):
        try:
            l, t, r, b = [int(round(v)) for v in box]
        except Exception:  # noqa: BLE001
            out.append({"text": "", "score": 0.0, "error": "bad_box", "box": box})
            continue

        l2 = max(0, l - pad)
        t2 = max(0, t - pad)
        r2 = min(w, r + pad)
        b2 = min(h, b + pad)
        if r2 <= l2 or b2 <= t2:
            out.append({"text": "", "score": 0.0, "error": "empty_box", "box": box})
            continue

        crop = img[t2:b2, l2:r2]
        prepared, polarity = prepare_crop(crop)
        if prepared is None:
            out.append({"text": "", "score": 0.0, "error": "empty_crop", "box": box})
            continue

        if dump:
            try:
                cv2.imwrite("%s/%03d.png" % (dump, idx), prepared)
            except Exception:  # noqa: BLE001
                pass

        # ——— 多视图识别 + 投票 ———
        # 每个字固定跑四种视图，交给 pick_best 裁决。
        # 不再用「分数低才重试」的短路：实测转曲字分数普遍 0.4~0.5，
        # 短路会让首诊的错字直接定案；四个视图加起来也只有几十毫秒。
        cands = [recognize_array(engine, prepared)]
        try:
            base_pad = max(2, int(round(max(crop.shape[:2]) * 0.18)))
            raw_border = cv2.copyMakeBorder(
                crop, base_pad, base_pad, base_pad, base_pad,
                cv2.BORDER_CONSTANT, value=(255, 255, 255),
            )
            p55, _ = prepare_crop(crop, pad_ratio=0.55)
            big = cv2.resize(
                prepared, None, fx=2.0, fy=2.0, interpolation=cv2.INTER_CUBIC
            )
            for name, variant in (
                ("pad", p55), ("scale", big), ("raw", raw_border)
            ):
                if variant is None:
                    continue
                r2 = recognize_array(engine, variant)
                r2["variant"] = name
                cands.append(r2)
        except Exception:  # noqa: BLE001
            pass

        res = pick_best(cands)

        res["box"] = [l, t, r, b]
        res["polarity"] = polarity
        out.append(res)

    return out


def recognize_lines(engine, png_path, boxes, pad: int = 3) -> list:
    """整行识别：把一整行的图直接交给行识别器，而不是切成一个个「字」。

    为什么必须有这条通道：
      汉字是等宽网格，按字宽切框成立；西文完全不是 —— i/l/./空格 极窄，
      W/M 极宽，而且**空格转曲后没有任何轮廓**。按字宽分组必然把 2~3 个
      字母并进一个框，逐字识别只能得到乱码，空格更是全部丢失。
      实测把整行图直接给行识别器：英文整句 0.93、中文 0.90，
      逐字只有 0.4~0.5。

    关键：**不要**用 prepare_crop 把长条图补成方形。宽高比一被破坏，
    识别器 resize 到固定高度后字符挤成一团 —— 实测补白边后掉到 0.645
    且输出乱码。只做必要的深底反相，再按高度缩放两个版本取最高分。
    """
    img = cv2.imread(png_path)
    if img is None:
        return [
            {"text": "", "score": 0.0, "error": "cannot_read_image", "box": b}
            for b in boxes
        ]

    h, w = img.shape[:2]
    out = []
    for box in boxes:
        try:
            l, t, r, b = [int(round(v)) for v in box]
        except Exception:  # noqa: BLE001
            out.append({"text": "", "score": 0.0, "error": "bad_box", "box": box})
            continue

        l2, t2 = max(0, l - pad), max(0, t - pad)
        r2, b2 = min(w, r + pad), min(h, b + pad)
        crop = img[t2:b2, l2:r2]
        if crop.size == 0:
            out.append({"text": "", "score": 0.0, "error": "empty_box", "box": box})
            continue

        gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
        if float((gray < 128).mean()) > 0.5:
            crop = cv2.bitwise_not(crop)

        views = [crop]
        ch = crop.shape[0]
        for th in (48, 64):
            if ch > 0 and abs(ch - th) > 4:
                s = th / float(ch)
                views.append(
                    cv2.resize(crop, None, fx=s, fy=s, interpolation=cv2.INTER_CUBIC)
                )

        cands = [recognize_array(engine, v) for v in views]
        best = max(
            cands,
            key=lambda x: (
                x.get("score") or 0,
                len(str(x.get("text") or "")),
            ),
        )
        best = dict(best)
        best["box"] = [l, t, r, b]
        # 行级几何统计：字宽比 / 墨迹密度 / 倾角。
        # 「字体不对」类问题靠这三个量一眼定位 —— 字宽差太多是选错字族，
        # 密度差太多是选错字重，倾角差太多是选错斜体。
        try:
            g2 = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
            dark = float((g2 < 128).mean())
            ink = (g2 < 128) if dark <= 0.5 else (g2 >= 128)
            best["stats"] = line_stats(ink.astype(np.uint8))
        except Exception:  # noqa: BLE001
            pass
        out.append(best)
    return out


LINE_W, LINE_H = 1024, 96

# 字重比对要跨尺度可比：原稿是 AI 文档坐标按倍数放大渲染的，
# 候选是 PIL 按 64px 渲染的，两者像素尺度差好几倍。
NORM_H = 96


def stroke_weight(tight):
    """墨迹面积 ÷ 归一化字高 = 正比于「笔画宽 ÷ 字高」，就是字重本身。

    为什么要归一化：面积随尺度平方变化，直接比面积毫无意义。
    归一化后（图像放大 s 倍，area→s²area、h→sh）这个值不变。

    这里用「按比例缩放到 NORM_H 高，再取面积 / NORM_H」。
    试过用 `area × NORM_H / h²` 的 O(1) 近似来省一次 resize，但两者
    **并不等价**：插值加阈值化会让缩放后的面积非线性变化，而原稿（4 倍
    几何渲染）和候选（PIL 64px）的缩放方向还相反，于是字重误差被系统性
    带偏，字体排名跟着乱掉。实测三行英文稿 HarmonyOS Sans 被顶掉。
    渲染次数才是性能瓶颈（漏斗已解决），不差这一次 resize。

    为什么不用 line_stats 里的 density：density = 面积/(宽×高)，而同一段
    文字在不同字体下总宽不同（宽体的密度天然更低），它把「字宽」和「字重」
    混在一起了。实测一份细体稿：density 排名把粗体顶到前面，
    而 stroke_weight 能干净分开 Regular 235 / Light 189 / Bold 283。
    """
    h, w = tight.shape
    if h <= 0:
        return 0.0
    nw = max(1, int(round(w * NORM_H / float(h))))
    small = cv2.resize(tight.astype(np.float32), (nw, NORM_H), interpolation=cv2.INTER_AREA)
    return float((small > 0.5).sum()) / float(NORM_H)


def split_units(mask):
    """按列投影的零间隙把一行切成若干墨迹段（≈字符，可能粘连）"""
    col = mask.sum(axis=0)
    nz = np.flatnonzero(col > 0)
    if len(nz) == 0:
        return []
    breaks = np.flatnonzero(np.diff(nz) > 1)
    starts = np.concatenate(([nz[0]], nz[breaks + 1]))
    ends = np.concatenate((nz[breaks], [nz[-1]]))
    return list(zip(starts.tolist(), (ends + 1).tolist()))


def _block_slant(mask, units):
    """整行的斜体度（逐字符上下重心偏移的中位数），全向量化。

    对每个字符块，取该块所跨列在「上 1/3 行」和「下 1/3 行」的墨迹重心 x，
    两者之差除以行高。正体 ≈ 0，斜体 ≈ tan(倾斜角)。

    为什么必须向量化：俄语长文是 18 行 × 776 个候选 = 1.4 万次调用，
    逐块跑 Python 循环会直接超过接口 30 秒超时（实测 500）。
    bincount 按「列属于哪个块」一次分组求和，O(宽) 完成。
    """
    h, w = mask.shape
    if not units or h < 3:
        return 0.0
    t = max(1, h // 3)
    top = mask[:t].astype(np.float64)
    bot = mask[h - t:].astype(np.float64)

    ids = np.zeros(w, dtype=np.int64)
    for k, (a, b) in enumerate(units):
        ids[a:b] = k + 1
    xs = np.arange(w, dtype=np.float64)

    cnt_t = np.bincount(ids, weights=top.sum(axis=0), minlength=len(units) + 1)
    sum_t = np.bincount(ids, weights=(top * xs).sum(axis=0), minlength=len(units) + 1)
    cnt_b = np.bincount(ids, weights=bot.sum(axis=0), minlength=len(units) + 1)
    sum_b = np.bincount(ids, weights=(bot * xs).sum(axis=0), minlength=len(units) + 1)

    ok = (cnt_t > 0) & (cnt_b > 0)
    if not ok.any():
        return 0.0
    # 只统计真正属于某个块的桶（0 号桶是列间空隙）
    ok[0] = False
    vals = ((sum_t[ok] / cnt_t[ok]) - (sum_b[ok] / cnt_b[ok])) / float(h)
    vals.sort()
    return float(vals[len(vals) // 2])


def line_stats(mask):
    """行级统计：字宽（字符紧致宽高比中位数）、墨迹密度、倾斜角、斜体度。

    字宽必须用「字符紧致 bbox」的宽高比，不能用「切段宽度 / 行高」：
    切出来的是列区间，高度仍是整行高，直接拿来算等于「段宽/行高」，
    精度全废（实测每段高度都等于行高）。

    slant（斜体度）= 每个字符「上半部重心 x − 下半部重心 x」除以块高，
    取中位数。正体 ≈ 0，斜体 ≈ tan(倾斜角)（12° 斜体约 0.2）。
    为什么不用整行重心的线性拟合：斜体是**逐字符**倾斜的，不沿行累积，
    整行拟合出来还是 0（实测 PT Sans Italic 的整行斜角只有 0.2°）。
    """
    h, w = mask.shape
    units = split_units(mask)
    ratios = []
    for a, b in units:
        piece = mask[:, a:b]
        ys, xs = piece.nonzero()
        if len(xs) == 0:
            continue
        pw = xs.max() - xs.min() + 1
        ph = ys.max() - ys.min() + 1
        if ph > 0:
            ratios.append(pw / float(ph))
    ratios.sort()
    med = ratios[len(ratios) // 2] if ratios else 1.0
    slant = _block_slant(mask, units)

    density = float(mask.sum()) / float(max(1, h * w))

    prof = mask.sum(axis=0)
    idx = np.nonzero(prof)[0]
    angle = 0.0
    if len(idx) > 3:
        rows = np.arange(h)[:, None]
        centers = (mask[:, idx] * rows).sum(axis=0) / (prof[idx] + 1e-9)
        x = idx.astype(np.float64)
        xm = x - x.mean()
        denom = float((xm * xm).sum())
        if denom > 1e-9:
            slope = float((xm * (centers - centers.mean())).sum() / denom)
            angle = math.degrees(math.atan(slope))
    return {"width": med, "density": density, "angle": angle, "slant": slant}


def line_feature(gray, want_stats=True):
    """把一行图的墨迹框裁出来，归一化后算 64×12 分块密度向量。

    按墨迹包围盒归一化是关键：这样字号、导出缩放都被消掉，
    只剩下「这一行字长什么样」—— 字母宽度分布、词间距、笔画粗细全在里面。

    返回 (vec, stats, cheap)：
      vec   密度向量
      stats 完整行级统计（**贵**：要切字符块算字宽和斜体度），
            只有精排阶段才需要
      cheap 便宜几何量（整行宽高比 + 字重），粗筛阶段用

    want_stats=False 时不算行级统计：粗筛阶段用不到，
    779 个候选 × 每行都算一遍纯属浪费（实测占字体比对耗时的大头，
    俄语长文会直接顶爆接口的 30 秒超时）。
    """
    ink = gray < 128
    ys, xs = ink.nonzero()
    if len(xs) == 0:
        return None, None, None
    tight = ink[ys.min() : ys.max() + 1, xs.min() : xs.max() + 1]
    small = cv2.resize(tight.astype(np.float32), (LINE_W, LINE_H), interpolation=cv2.INTER_AREA)
    vec = small.reshape(12, LINE_H // 12, 64, LINE_W // 64).mean(axis=(1, 3)).ravel()
    th, tw = tight.shape
    cheap = {
        "aspect": tw / float(th) if th else 1.0,
        "weight": stroke_weight(tight),
    }
    stats = line_stats(tight.astype(np.uint8)) if want_stats else None
    return vec, stats, cheap


_FONT_OBJ_CACHE = {}


def _pil_font(path, size, index=0):
    """缓存 PIL 字体对象。

    原先每次渲染都 ImageFont.truetype 一次，等于把整个字体文件重新读一遍
    （中文字体常见 10~30MB），单次实测 8~10ms。整行比对时 180 个候选
    × 每行一次还勉强能忍；切片比对要把渲染次数再放大 5 倍，不缓存会
    直接干到 10 秒以上。实测缓存后单次渲染降到 1ms 以下。
    """
    key = (str(path), int(size), int(index or 0))
    f = _FONT_OBJ_CACHE.get(key)
    if f is not None:
        return f
    from PIL import ImageFont

    f = ImageFont.truetype(str(path), int(size), index=int(index or 0))
    # 上限 600：一套字体十来个字重 × 几十个候选就到顶。
    # 超了整体清空而不是做 LRU —— 重建一次只有几百毫秒，
    # 维护链表反而更容易出 bug。
    if len(_FONT_OBJ_CACHE) >= 600:
        _FONT_OBJ_CACHE.clear()
    _FONT_OBJ_CACHE[key] = f
    return f


def render_line(path, text, index=0):
    """渲染一整行，给 line_feature 用。

    字号 96 是被字重测量逼出来的，不是随手取的：
    stroke_weight 会把墨迹缩放到 NORM_H=96 再数面积，所以候选渲染在
    96px 时**几乎不缩放**（1:1），插值不会改变笔画粗细；渲染在 64px 时
    要先放大到 96，插值 + 阈值化会让笔画系统性变细。

    实测 FD-20261118-145147（一行 19 字符的 URL），原稿 stroke_weight=228.9：
        渲染尺寸   64px    96px   200px
        HarmonyOS Medium   211.4   229.5   228.7
        JhengHei Bold      228.2   222.5   223.5
    64px 下真身被算成「比原稿细 7.6%」（wfit 0.923），而 Bold 恰好落在
    228（wfit 0.997）—— 于是字重这一路把 Bold 判成更吻合，翻转了形状
    证据已经判对的排序。换成 96px 后真身 229.5 几乎完全命中。
    """
    from PIL import Image, ImageDraw

    try:
        f = _pil_font(path, 96, index)
        bb = f.getbbox(text)
        if not bb:
            return None
        w, h = int(bb[2] - bb[0] + 24), int(bb[3] - bb[1] + 24)
        if w <= 0 or h <= 0:
            return None
        im = Image.new("L", (w, h), 255)
        ImageDraw.Draw(im).text((12 - bb[0], 12 - bb[1]), text, font=f, fill=0)
        return np.array(im)
    except Exception:  # noqa: BLE001
        return None


def render_slice(path, text, index=0, size=160):
    """渲染一小段文本（1~4 个字符），给切片级比对用。

    字号取 160：转曲切片在原图里字高 60~190px，渲染得比 64 大一些，
    缩小到 64×64 时抗锯齿损失更小。比 render_line 的 64 大一倍多，
    是为了让「两个字母之间那点空隙」在归一化后还能留住。
    """
    from PIL import Image, ImageDraw

    text = (text or "").strip()
    if not text:
        return None
    try:
        f = _pil_font(path, size, index)
        bb = f.getbbox(text)
        if not bb:
            return None
        w, h = int(bb[2] - bb[0]) + 40, int(bb[3] - bb[1]) + 40
        if w <= 0 or h <= 0 or w > 4000 or h > 2000:
            return None
        im = Image.new("L", (w, h), 255)
        ImageDraw.Draw(im).text((20 - bb[0], 20 - bb[1]), text, font=f, fill=0)
        return np.array(im)
    except Exception:  # noqa: BLE001
        return None


_METRICS_CACHE = {}


def font_metrics(path, index=0):
    """字体的垂直度量（按 em 归一化）：descent 与 ink_bottom。

    为什么恢复时需要它：Illustrator 的 textFrame.visibleBounds 下边是**行框底**
    （= 基线 − descent×字号），不是字形墨迹的底。直接拿它对齐原稿墨迹底，
    整行就会按该字体的 descender 高度上移 —— 于是「换一个字体，偏移量就变」。
    实测 FD-20261118-102207：华文琥珀 11.9pt，整体偏高约 1~3pt。

    这里返回两个比例（都是正数）：
      descent    行框底比基线低多少（em）
      ink_bottom 实际墨迹底比基线低多少（em），由该字体渲染这行字实测得出
    真正的墨迹底 = 行框底 + (descent − ink_bottom) × 字号。
    """
    key = (str(path), int(index or 0))
    if key in _METRICS_CACHE:
        return _METRICS_CACHE[key]
    out = {"descent": 0.0, "ink_bottom": 0.0}
    try:
        from fontTools.ttLib import TTFont

        tt = TTFont(str(path), fontNumber=int(index or 0), lazy=True)
        upem = float(getattr(tt["head"], "unitsPerEm", 1000) or 1000)
        d = 0.0
        try:
            d = abs(float(tt["OS/2"].sTypoDescender or 0))
        except Exception:  # noqa: BLE001
            d = 0.0
        if d <= 0:
            try:
                d = abs(float(tt["hhea"].descender or 0))
            except Exception:  # noqa: BLE001
                d = 0.0
        out["descent"] = d / upem if upem > 0 else 0.0
        try:
            tt.close()
        except Exception:  # noqa: BLE001
            pass
    except Exception:  # noqa: BLE001
        out["descent"] = 0.0
    _METRICS_CACHE[key] = out
    return out


_INK_CACHE = {}


def measure_ink_bottom(path, text, index=0):
    """用该字体渲染一行，量出墨迹底相对基线的偏移（em，负数=墨迹在基线下方）。

    基线的位置：PIL 的 ImageDraw.text 以「字顶（ascent 起点）」为 y 坐标，
    所以基线 = y + ascent。渲染时 y 是有意选在 pad - bb[1] 处，
    这里用同一套算法反推即可，不必再猜。
    """
    key = (str(path), int(index or 0), text)
    if key in _INK_CACHE:
        return _INK_CACHE[key]
    try:
        from PIL import Image, ImageDraw, ImageFont

        size = 96
        f = ImageFont.truetype(str(path), size, index=int(index or 0))
        bb = f.getbbox(text)
        pad = 40
        w = int(bb[2] - bb[0]) + pad * 2
        h = int(bb[3] - bb[1]) + pad * 2
        im = Image.new("L", (w, h), 255)
        draw = ImageDraw.Draw(im)
        x0, y0 = pad - bb[0], pad - bb[1]
        draw.text((x0, y0), text, font=f, fill=0)
        arr = np.array(im)
        rows = np.flatnonzero((arr < 128).any(axis=1))
        if rows.size == 0:
            _INK_CACHE[key] = 0.0
            return 0.0
        ink_bottom_px = float(rows.max() + 1)
        try:
            ascent, _ = f.getmetrics()
        except Exception:  # noqa: BLE001
            ascent = float(bb[3])
        baseline_px = y0 + ascent
        # 图像坐标向下为正：基线以上为负偏移
        val = float(baseline_px - ink_bottom_px) / float(size)
        _INK_CACHE[key] = val
        return val
    except Exception:  # noqa: BLE001
        _INK_CACHE[key] = 0.0
        return 0.0


# 行首常见的装饰符（项目符号、破折号、间隔点）。
# 它们在文稿里是「图形」而不是字，字宽/字重与正文字体无关，
# 却会被整行归一化放大成一行里最显眼的元素。
LEAD_SYMBOLS = "•·∙⋅‧-–—*◦▪▫●○■□◆◇★☆"


def _lead_symbol_cut(mask, line_h=None):
    """返回行首装饰符该裁掉的宽度（像素），0 表示没有。

    判定保守：只有「首块明显比行矮」+「比行窄」+「与后续有明显空白」三条
    同时成立才裁，避免把真正的连字符文字（"-20℃"）或字母 i 的竖笔吃掉。
    """
    if mask.sum() == 0:
        return 0
    units = split_units(mask)
    if len(units) < 3:
        return 0
    if line_h is None:
        rows = np.flatnonzero(mask.sum(axis=1) > 0)
        if not rows.size:
            return 0
        line_h = int(rows.max() - rows.min() + 1)
    if line_h <= 0:
        return 0

    x0, x1 = units[0]
    blk = mask[:, x0:x1]
    brows = np.flatnonzero(blk.sum(axis=1) > 0)
    if not brows.size:
        return 0
    blk_h = int(brows.max() - brows.min() + 1)
    blk_w = x1 - x0
    gap = units[1][0] - x1

    # 空白阈值取 0.16 行高：实测本地那行圆点后只有 39px 空白（行高 185 的
    # 21%），用 0.22 刚好卡住不触发，等于没修。
    if blk_h > 0.62 * line_h or blk_w > 0.9 * line_h or gap < 0.16 * line_h:
        return 0
    return int(x1 + gap // 2)


def trim_lead_symbol(gray, text):
    """把行首装饰符从「比对图」和「比对文本」里一起去掉。

    为什么必须做：整行比对是按墨迹包围盒归一化到 64×12 网格的，
    行首一个圆点会把整个网格的宽度分配挤歪，所有字符都被压缩。
    实测 FD-20261117-142243（`• WARNING: Do not ...`）：
      带圆点整行 0.4805（Gabriola，装饰体，完全错）
      同段去掉圆点 0.8594（微软雅黑族）
    一个 30px 的点让字体推荐整个跑偏，用户看到的就是「字体不对」。
    """
    if not text:
        return gray, text
    mask = (gray < 128).astype(np.uint8)
    cut = _lead_symbol_cut(mask)
    if cut <= 0:
        return gray, text
    # 图上那头是符号，文本那头不一定也有（分段后 OCR 常常只吐出正文，
    # 而框是按最宽空白切的、把圆点留在里面）—— 这时只裁图，别动文本。
    trimmed = text[1:].lstrip() if text[0] in LEAD_SYMBOLS else text
    if not trimmed:
        return gray, text
    return gray[:, cut:], trimmed


def consistency_penalty(src, cand, k_width=2.0, k_weight=2.0, k_slant=3.0):
    """原稿与候选的「字宽 / 字重 / 倾斜」三项一致性因子（都落在 0~1）。

    为什么必须有它：整行密度向量比的是「墨迹分布」，它对**整体缩放不敏感**
    —— 粗体、斜体、窄体全被拉成同一团，分数挤在 0.84 附近（实测 Top1 与
    Top2 只差 0.4%，等于随机）。这三条是把「像不像」拆成可核对的几何量：
      字宽  字符紧致宽高比之比（窄体稿会被宽体字体顶掉）
      字重  笔画宽÷字高之比（细体稿会被粗体字体顶掉）
      倾斜  墨迹重心的倾角之差（正体稿会被斜体字体顶掉）

    字重这一项用 stroke_weight（面积÷归一化字高）而不是 density：
    density 把字宽和字重混在一起，会把粗体误判成"字重接近"。
    """
    r_w = math.log(max(1e-6, src["width"] / max(1e-6, cand["width"])))
    sw = src.get("weight") or 0.0
    cw = cand.get("weight") or 0.0
    r_d = math.log(max(1e-6, sw / max(1e-6, cw))) if sw > 0 and cw > 0 else 0.0
    da = src["angle"] - cand["angle"]
    return (math.exp(-k_width * abs(r_w))
            * math.exp(-k_weight * abs(r_d))
            * math.exp(-k_slant * abs(da)))


def compare_line_fonts(png_path, targets, candidates, slices=None):
    """用整行形状比对候选字体，支持多行加权。

    targets: [{"box": [l,t,r,b] | None, "text": str, "weight": float}]
    slices:  [{"box": [l,t,r,b], "text": str}] —— 逐字/粘连切片，
             有就先按切片比（分辨率高得多），整行只在切片不可用时兜底

    比「挑几个单字算密度向量」准得多：单字样本对西文根本不成立（切框里
    是两三个字母），而整行渲染把字宽、词距、字形全带进来了。
    实测英文稿 MiSans 系列 0.94~0.96 包揽前五，Gilroy 掉出前十五；
    中文稿 STXinwei 0.99 对第二名 0.90。

    多行必须每行单独比再加权，不能把几行拼成一句话渲染：
    实测两行英文稿，只比第一行（且文本带 OCR 幻觉的 "..."）时
    Baloo 2 / Wide Latin / DIN Bold 混作一团，全挤在 0.82~0.84；
    两行加权后 MiSans 包揽前六（0.94+）。某一行文字有小错时，
    其他行会把它压下去，比单行稳得多。

    排序分两段（2026-11-11 加）：
      1) 先按老余弦分排序，取前 40 个进入精排 —— 老分虽然分不开
         字宽字重，但「字体族对不对」它判得准；
      2) 精排用「余弦 × 三项一致性惩罚」，它能把同族里字重/倾斜不对的
         剔掉。只在这一段里重排，是为了不破坏老分已经判对的字体族。
    实测：两行英文稿仍由 MiSans 夺冠、三行英文稿仍由 HarmonyOS Sans 夺冠、
    装饰字稿由华文琥珀夺冠且与第二名差距从 3.6% 拉到 36%；
    一份细体窄身英文稿则从「Heavy Italic」纠正成细体西文。

    切片比对（2026-11-18 加）：
    整行向量把 1024 列压进一整句，19 个字符每个只摊到 3 个网格列，
    「这个 a 的碗是圆是方」「s 的收笔往哪弯」这类细节全被抹平，于是
    前几名挤在 2% 的窄带里，排序基本靠笔画粗细 —— 谁的笔画黑谁赢。
    实测 FD-20261118-145147（一行 URL）：整行前三名 0.888/0.8796/0.8676，
    JhengHei Bold 靠粗笔画压住真身 HarmonyOS Sans Medium。

    改成拿 OCR 的「粘连切片」当样本（ht / tp / uk / lis / co），
    每片 2~3 个字符铺满 64 列，每个字母 5~7 个网格列，信号完全换了一个量级：
    真身 0.989 且五片全部落在 0.987~0.992（极差 0.005），第二名 0.967。
    注意不是「拿切片当单字比」—— 切片框里本来就是两三个字母，
    必须**整体渲染同一串文本**再比，否则是拿「ht」比对「h」。

    整行不是没用：它带字距、词距、整行宽高比，切片这些都丢了。
    所以是加权合并（切片 0.8 / 整行 0.2），不是替换。
    """
    gray_full = cv2.imread(png_path, cv2.IMREAD_GRAYSCALE)
    if gray_full is None:
        return []

    feats = []
    for t in targets:
        g = gray_full
        box = t.get("box")
        if box:
            l, top, r, b = [int(round(v)) for v in box]
            g = g[
                max(0, top) : min(gray_full.shape[0], b),
                max(0, l) : min(gray_full.shape[1], r),
            ]
        text = str(t.get("text") or "")
        g, text = trim_lead_symbol(g, text)
        vec, stats, cheap = line_feature(g)
        if vec is None:
            continue
        v = vec.ravel()
        feats.append((
            v,
            float(np.linalg.norm(v)) + 1e-9,
            max(0.0001, float(t.get("weight") or 1.0)),
            text,
            stats,
            cheap,
        ))
    if not feats:
        return []

    # ---------- 切片特征（只算一次，所有候选共用） ----------
    # 图像侧的切片向量在这里算好；字体侧留到精排阶段再渲染，
    # 因为粗筛已经用整行把 700 多个候选砍到一百来个，没必要为
    # 注定被淘汰的候选去渲染短文本。
    slice_feats = []
    if slices:
        _H, _W = gray_full.shape[:2]
        for sl in slices[:8]:
            try:
                box = sl.get("box")
                stext = str(sl.get("text") or "").strip()
                if not box or not stext or len(stext) > 4:
                    continue
                sl_, st_, sr_, sb_ = [int(round(v)) for v in box]
                sub = gray_full[max(0, st_): min(_H, sb_), max(0, sl_): min(_W, sr_)]
                if sub.size == 0:
                    continue
                sv = vectorize_crop(sub)
                if sv is None:
                    continue
                sv = np.asarray(sv, dtype=np.float32)
                slice_feats.append((stext, sv, float(np.linalg.norm(sv)) + 1e-9))
            except Exception:  # noqa: BLE001
                continue

    # 粗筛：只算密度向量 + 便宜几何量。
    #
    # 完整的行级统计（切字符块算字宽、斜体度）**贵**（约 1.7ms/行），
    # 776 个候选 × 18 行就是 24 秒 —— 俄语长文会直接顶爆 30 秒超时。
    # 所以昂贵的统计全部推迟到精排阶段，只对入围的一百来��候选算。
    # 粗筛：只算密度向量 + 便宜几何量，且**只用最长的两行**。
    #
    # 完整的行级统计（切字符块算字宽、斜体度）**贵**（约 1.7ms/行），
    # 776 个候选 × 18 行就是 24 秒 —— 俄语长文会直接顶爆接口超时。
    # 而且渲染本身也贵：776 × 18 = 1.4 万次 PIL 渲染就要十几秒。
    #
    # 所以做成漏斗：
    #   第一级 776 候选 × 最长 3 行 → 约 180 个入围
    #   第二级 180 候选 × 全部行 → 最终排名
    # 代价是 10 秒量级，收益是俄语长文从 24 秒降到 9 秒。
    # 取 3 行而不是 2 行：实测只看 2 行会把三行英文稿的正确答案
    # （HarmonyOS Sans）在粗筛里筛掉，叠加图核对确认它是真身。
    # targets 在服务端已按文本长度降序排过，feats 前几行就是最长的行。
    probe = feats[:3] if len(feats) > 3 else feats

    cache = {}
    records = []
    for c in candidates:
        try:
            path = c["path"]
            index = int(c.get("index") or 0)
            acc, used = 0.0, 0.0
            pairs = []
            for v, n, w, text, stats, cheap in probe:
                key = (path, index, text)
                got = cache.get(key)
                if got is None:
                    rimg = render_line(path, text, index)
                    if rimg is None:
                        continue
                    cv, _, ccheap = line_feature(rimg, want_stats=False)
                    if cv is None:
                        continue
                    got = (
                        cv.ravel(),
                        float(np.linalg.norm(cv.ravel())) + 1e-9,
                        ccheap,
                    )
                    cache[key] = got
                vv, vn, ccheap = got
                cos = float(v @ vv / (n * vn))
                acc += w * cos
                used += w
                pairs.append((w, cos, stats, ccheap, text))
            if used > 0:
                records.append({
                    "id": c["id"],
                    "path": path,
                    "index": index,
                    "old": acc / used,
                    "pairs": pairs,
                })
        except Exception:  # noqa: BLE001
            continue
    if not records:
        return []

    # 粗筛：三路并集，谁都可能藏着正确答案
    #   1) 老分前 60 —— 老分判「字体族」很准，只是分不清字宽字重
    #   2) 整行宽高比最接近的 60 —— 老分会把窄体压到几十名开外
    #   3) 字重最接近的 60 —— 老分偏爱粗体
    # 早先只用老分前 24，正确答案（Arial，字宽与原稿几乎一致）被直接
    # 滤掉了 —— 用户在前六个里根本看不到它。
    src_w = sum(f[4]["width"] for f in feats) / len(feats)
    src_aspect = sum(f[5]["aspect"] for f in feats) / len(feats)
    src_weight = sum(f[5]["weight"] for f in feats) / len(feats)

    def cand_aspect(rec):
        return sum(p[3]["aspect"] for p in rec["pairs"]) / len(rec["pairs"])

    def cand_weight(rec):
        return sum(p[3]["weight"] for p in rec["pairs"]) / len(rec["pairs"])

    by_old = sorted(records, key=lambda x: -x["old"])[:60]
    by_aspect = sorted(records, key=lambda x: abs(cand_aspect(x) - src_aspect))[:60]
    # 字重最接近的 60：老分偏爱粗体，字重单独再拉一路
    by_weight = (
        sorted(records, key=lambda x: abs(cand_weight(x) - src_weight))[:60]
        if src_weight > 0
        else []
    )
    seen = set()
    short = []
    for rec in by_old + by_aspect + by_weight:
        if rec["id"] in seen:
            continue
        seen.add(rec["id"])
        short.append(rec)

    # 精排：逐行「余弦 × 一致性修正」再加权平均
    #
    # 一致性只做**小幅修正**（0.85 + 0.15 × 惩罚），绝不能让它主导排序。
    # 试过纯乘积和 50% 权重，两次都把形状明显不对的候选顶上来
    # （衬线斜体顶掉 MiSans、Sans Serif Collection 顶掉 HarmonyOS Sans，
    # 叠图核对后确认原稿确实是 HarmonyOS Sans / MiSans）。
    # 形状证据（余弦）必须是主项，一致性只用来在分数接近时区分字宽字重。
    # 源端 slant 是「逐字符」统计，长行里混进括号、破折号、装饰符号就会被拉偏。
    # 一旦源值超出「正体 / 斜体」两个已知区间，这个量就不可信，必须停用硬门槛 ——
    # 否则它会一刀切掉整个字体库。
    # 实测 FD-20261119-092620：一行 71 字符的说明文字，slant 被测成 0.173
    # （正体 -0.013~0、斜体 0.062~0.090 都够不到这个值），729 个候选全部被
    # 「slant 差 > 0.035」这条硬门槛淘汰 → 返回空数组 → 面板显示
    # 「字体识别没成功」，用户只能看到「字体：未执行或失败」。
    src_slants = [float(f[4].get("slant", 0.0)) for f in feats if f[4]]
    slant_reliable = bool(src_slants) and all(-0.05 <= s <= 0.12 for s in src_slants)

    refined = []
    for rec in short:
        acc, used = 0.0, 0.0
        keep = True
        cstats_list = []
        # 精排：这里才渲染**全部行**并补算昂贵的行级统计（字宽、斜体度、倾角）
        for v, n, w, text, stats, cheap in feats:
            img = render_line(rec["path"], text, rec["index"])
            if img is None:
                keep = False
                break
            cv, cstats, ccheap = line_feature(img, want_stats=True)
            if cv is None or cstats is None:
                keep = False
                break
            cos = float(v @ cv.ravel() / (n * (float(np.linalg.norm(cv.ravel())) + 1e-9)))
            cstats_list.append((w, cos, stats, cstats))
            # 斜体是**硬门槛**，不是软修正：原稿正体时，斜体字体的字宽和
            # 字重可能恰好吻合，一加分就能把正体顶掉（实测两行英文稿
            # MiSans Normal 被 PT Sans Italic 顶掉）。稿子是斜的就只留斜体。
            #
            # 用「逐字符斜度 slant」判定，不用整行倾角：斜体是每个字符
            # 各斜一点、不沿行累积，整行重心拟合出来还是 0°（实测 PT Sans
            # Italic 的整行斜角只有 0.2°）。实测 slant：正体 -0.013~0，
            # 斜体 0.062~0.090，阈值 0.035 分得很开。
            if slant_reliable and abs(stats.get("slant", 0.0) - cstats.get("slant", 0.0)) > 0.035:
                keep = False
                break
            # 整行整体倾斜（转曲前被旋转过）同样排除
            if abs(stats["angle"] - cstats["angle"]) > 6.0:
                keep = False
                break
            acc += w * cos * (0.85 + 0.15 * consistency_penalty(stats, cstats))
            used += w
        if not keep or used <= 0:
            continue

        # ---------- 切片级余弦 ----------
        # 这里才是真正分得开字体的那一路。整行余弦在长文本上被压到
        # 2% 的窄带里（见函数文档），切片铺满 64 列，每个字母有 5~7 个网格列。
        sfit = None
        if slice_feats:
            css = []
            for stext, sv, sn in slice_feats:
                simg = render_slice(rec["path"], stext, rec["index"])
                if simg is None:
                    continue
                scv = vectorize_crop(simg)
                if scv is None:
                    continue
                scv = np.asarray(scv, dtype=np.float32)
                scn = float(np.linalg.norm(scv)) + 1e-9
                css.append(float(sv @ scv / (sn * scn)))
            # 低于 0.5 基本是「切片文本被认错」而不是「这个字体不像」：
            # 实测正确字体落在 0.94~0.99，文本认错时掉到 0.3 上下。
            # 至少剩 2 片才可信，只剩 1 片宁可退回整行分。
            good = [c for c in css if c >= 0.5]
            if len(good) >= 2:
                sfit = float(sum(good) / len(good))

        cw = cand_weight(rec)
        # 字重吻合度：1 = 完全一致，越小越不像
        wfit = 1.0
        if src_weight > 0 and cw > 0:
            wfit = max(0.0, 1.0 - abs(cw - src_weight) / src_weight)
        # 字宽吻合度：整行宽高比之比，1 = 完全一致
        ca = cand_aspect(rec)
        dfit = 1.0
        if src_aspect > 0 and ca > 0:
            dfit = max(0.0, 1.0 - abs(ca / src_aspect - 1.0))
        # 几何吻合度 = 字重 × 字宽
        geo = wfit * dfit
        base = acc / used
        if sfit is not None:
            # 切片 0.8 / 整行 0.2：切片分辨率高、逐片一致性强，是主证据；
            # 整行补的是切片丢掉的字距/词距/整行宽高比。
            # 实测这组权重下真身（切片 0.989 / 整行 0.888）能把靠粗笔画
            # 取胜的 JhengHei Bold（0.963 / 0.902）压下去。
            base = 0.8 * sfit + 0.2 * base
        refined.append({
            "id": rec["id"],
            # 老分区分度极低（Top1 与 Top2 常只差 0.1%，等于噪声），
            # 所以让它做主项、把**可测量的**几何量做修正：
            # 实测一份细体英文稿，JhengHei Bold 靠老分微弱领先，
            # 但它的字重差 9%、字宽差 5%；Open Sans Medium 字重吻合
            # 99.6%、字宽比 0.9988 —— 真身显然是后者。
            "score": base * (0.5 + 0.5 * geo),
            "base": base,
            "sliceFit": round(sfit, 4) if sfit is not None else None,
            "weightFit": round(wfit, 4),
            "widthFit": round(dfit, 4),
            "geoFit": round(geo, 4),
            "widthRatio": round(ca / src_aspect, 4) if src_aspect > 0 else 0.0,
        })
    if not refined:
        # 最后一道兜底：门槛组合仍有办法把全库淘汰（例如源端 angle 异常）。
        # 面板宁可显示「相似度低」也不能显示「识别失败」—— 用户拿到一份
        # 60 分的候选列表还能自己挑，拿到空列表就什么也做不了。
        # 这里退回粗筛的老分（整行余弦），它是原始形状证据，不含任何门槛。
        return [
            {
                "id": r["id"],
                "score": round(float(r["old"]), 4),
                "base": round(float(r["old"]), 4),
                "sliceFit": None,
                "weightFit": 1.0,
                "widthFit": 1.0,
                "geoFit": 1.0,
                "widthRatio": 1.0,
                "fallback": True,
            }
            for r in sorted(records, key=lambda x: -x["old"])[:12]
        ]

    refined.sort(key=lambda x: -x["score"])
    return refined


def encode_vector(vec) -> str:
    """把 0–1 的密度向量编码成 256 字节的 base64。

    这里必须先 ×255 再转 uint8。直接 `astype(np.uint8)` 会把所有
    小于 1 的小数截断成 0 —— 一块 4×4 里墨迹占比 0.8、0.5、0.25
    全都变成 0，整个向量退化成全零。Node 侧算出 cosine(0, x) = 0，
    字体匹配的分数就全是 0%，UI 上显示一排 0%。

    这个 bug 之前没暴露，是因为小字图（字高 40px 左右）缩小到 60px 后
    笔画很粗，个别块的占比刚好等于 1.0，截断后还剩几个 1，
    侥幸能算出一点分数。换成真实转曲图（字高 120px+）就彻底归零了。
    """
    q = np.clip(np.round(np.asarray(vec, dtype=np.float32) * 255.0), 0, 255)
    return base64.b64encode(q.astype(np.uint8).tobytes()).decode("ascii")


def vectorize_crop(crop):
    """把一个字的图转成 256 维密度向量（16×16 分块墨迹占比）。

    和 Node 侧 packages/font-core/src/similarity.ts 的 glyphMask + densityVector
    产出同样形状的向量，这样才能和「渲染候选字体得到的向量」直接算余弦。

    关键：两边都必须按**墨迹包围盒**归一化到 64×64，否则字号不同就没法比。
    这里先紧裁掉白边再缩放，不用 prepare_crop 的结果（那个带白边）。
    """
    if crop is None or crop.size == 0:
        return None

    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY) if crop.ndim == 3 else crop

    # 深底白字先反相，否则整张全黑
    if is_dark_background(gray):
        gray = 255 - gray

    mask = (gray < 128).astype(np.uint8)
    ys, xs = np.where(mask > 0)
    if len(ys) < 12 or len(xs) < 12:
        return None

    sub = gray[ys.min() : ys.max() + 1, xs.min() : xs.max() + 1]
    # 等比放进 64×64 的居中方框，保持长宽比
    h, w = sub.shape[:2]
    side = max(h, w)
    square = np.full((side, side), 255, dtype=np.uint8)
    y0 = (side - h) // 2
    x0 = (side - w) // 2
    square[y0 : y0 + h, x0 : x0 + w] = sub

    small = cv2.resize(square, (60, 60), interpolation=cv2.INTER_AREA)
    # 居中留 2px 边距再放进 64×64。
    # 必须和 Node 侧 glyphMask 的归一化完全一致 —— 那边是
    #   scale = (GRID - pad*2) / max(bw, bh)，pad=2
    # 即字形占 60×60、四周各留 2px。之前这边直接铺满 64×64，
    # 两边内容位置差 2px，余弦分数被系统性压低，排序还可能被噪声带偏。
    canvas = np.full((64, 64), 255, dtype=np.uint8)
    canvas[2:62, 2:62] = small

    binary = (canvas < 128).astype(np.float32)
    # 64×64 切成 16×16 个格子，每格 4×4，取墨迹占比
    blocks = binary.reshape(16, 4, 16, 4).mean(axis=(1, 3))
    return blocks.flatten()


def vectors_for(engine, png_path: str, boxes, pad: int) -> list:
    """按框取图并转成密度向量，返回 base64 字符串数组。"""
    img = cv2.imread(png_path)
    if img is None:
        return [None] * len(boxes)

    h, w = img.shape[:2]
    out = []

    for box in boxes:
        try:
            l, t, r, b = [int(round(v)) for v in box]
        except Exception:  # noqa: BLE001
            out.append(None)
            continue

        l2, t2 = max(0, l - pad), max(0, t - pad)
        r2, b2 = min(w, r + pad), min(h, b + pad)
        if r2 <= l2 or b2 <= t2:
            out.append(None)
            continue

        vec = vectorize_crop(img[t2:b2, l2:r2])
        if vec is None:
            out.append(None)
            continue
        out.append(encode_vector(vec))

    return out


def flatten_shape(flat, ss: int, closed: bool):
    """把 Illustrator 回传的扁平点串摊平成像素多边形。

    点串编码（每个点 6 个数，单位已是像素，y 向下）：
        ax, ay   锚点
        ix, iy   leftDirection（进入本点的控制点）
        ox, oy   rightDirection（离开本点的控制点）

    段 i → i+1 的三次贝塞尔控制点就是 (out_i, in_{i+1})。
    控制点与锚点重合说明是直线段，直接取锚点，省掉一次细分。
    """
    n = len(flat) // 6
    if n < 2:
        return None

    def px(k, o):
        return float(flat[k * 6 + o])

    pts = []
    segs = n if closed else n - 1
    for i in range(segs):
        j = (i + 1) % n
        x0, y0 = px(i, 0), px(i, 1)
        c1x, c1y = px(i, 4), px(i, 5)
        c2x, c2y = px(j, 2), px(j, 3)
        x1, y1 = px(j, 0), px(j, 1)

        if c1x == x0 and c1y == y0 and c2x == x1 and c2y == y1:
            pts.append((x0, y0))
            continue

        # 8 段固定细分。字形曲线的单段跨度通常小于字号的 1/3，
        # 8 段在这个尺度下误差远小于 1 像素。
        for k in range(1, 9):
            t = k / 8.0
            mt = 1.0 - t
            a = mt * mt * mt
            b = 3 * mt * mt * t
            c = 3 * mt * t * t
            d = t * t * t
            pts.append(
                (a * x0 + b * c1x + c * c2x + d * x1, a * y0 + b * c1y + c * c2y + d * y1)
            )

    if len(pts) < 3:
        return None

    arr = np.array(pts, dtype=np.float32) * float(ss)
    return np.round(arr).astype(np.int32).reshape(-1, 1, 2)


def _bands_by_cores(proj):
    """核心带兜底：行距紧到墨迹在 y 投影上粘连时，用 15% 峰值找每行最饱满的一段，
    再按相邻中点切出行分界。只在 find_row_bands 第一级「只切出一段」时调用。

    不能简单地找连续墨迹段：英文行距紧时，上一行的下伸字母（g/p/y）和下一行的
    上伸字母会在投影上接起来，全零间隙只有 2~3px，直接找零带会把三行并成一行 ——
    实测用户那张说明书稿就是这样，聚类切出 10 条贯穿上下的竖条，整行识别器读
    三行叠图直接返回空。

    改用「核心墨迹带 + 相邻中点」：
      1. 阈值取峰值 15%，滤掉零星下伸/抗锯齿，得到每行最饱满的核心带
      2. 把靠得太近的核心带合并（单行英文的大写上伸部会单独成一矮带，
         不合并就会把一行误切成两段）；矮带也必须够近才并
      2b. 但两段都像完整一行、中间又有 >=4px 全白时，禁止合并 ——
          这是「真的有行界」的硬证据
      3. 相邻核心带的中点即行分界，首尾补到画布边界

    ⚠ 这个算法对「各行墨量差异大」不成立（15% 阈值是全局唯一的），
    所以它只能当兜底，不能当主策略，见 find_row_bands 的说明。
    """
    strong = proj >= max(1.0, float(proj.max()) * 0.15)
    cores = []
    st = None
    gap = 0
    for y, v in enumerate(strong):
        if v:
            if st is None:
                st = y
            gap = 0
        elif st is not None:
            gap += 1
            if gap > 2:
                cores.append([st, y - gap + 1])
                st = None
                gap = 0
    if st is not None:
        cores.append([st, len(strong) - 1])
    # 碎片 core 不参与分行：15% 阈值会把「大写上伸部」单独切出一条 3~5px 的
    # 窄带，如果拿它当一行，就会把正常的一行从腰上劈开。
    # 实测 FD-20261119-092620：整张图只有一行文字（y 32~133 投影连续无空白），
    # 但 y=41~43 的 proj 是 201~224（全局峰值 1189 的 15% = 178，刚好过线），
    # 于是 cores=[[40,43],[60,...]]，med 被 4px 的碎片拉到 31、min_gap=15.5，
    # 而两段间距 17px > 15.5 → 不合并 → 分界落在 55，把一行劈成两段：
    # 上段只剩字的顶部弧线（OCR 读成 ".........oooo."），下段少了一截。
    # 阈值和第一级一致：4x 渲染下 8px = 2pt，真实文字连上伸下伸也不会这么矮。
    frag_h = max(4.0, min(8.0, len(proj) * 0.03))
    cores = [c for c in cores if (c[1] - c[0] + 1) >= frag_h]
    if len(cores) <= 1:
        return [[0, len(proj)]]

    med = float(np.median([b - a for a, b in cores]))
    min_gap = max(5.0, med * 0.5)

    def longest_zero(a, b):
        """[a, b) 里最长连续 proj==0 的像素行数。"""
        if b <= a:
            return 0
        best = run = 0
        for v in proj[a:b]:
            run = run + 1 if v == 0 else 0
            if run > best:
                best = run
        return best

    merged = [list(cores[0])]
    for a, b in cores[1:]:
        # 只按「离当前行有多近」合并。
        # 早期还有一条 `(b-a) < med*0.4` 的矮带无条件合并，不看间距：
        # 短行的核心带会被 15% 阈值切成 1~2px 碎片（俄语说明书里
        # 只有「распыления.」那一行就是），隔着一整行也会被并进上一行，
        # 两行合成一个 64px 带，整行 OCR 只能读出两行叠字。
        # 实测去掉这条：俄语稿 16 段→18 段（全 29~37px），
        # 三行英文 / 单行英文 / 中文 / 两行英文等 6 张历史图分段完全不变。
        prev = merged[-1]

        # 硬证据优先：两段都够高（像完整的一行），中间又有 >=4px 全白，
        # 就绝不能合并。超粗综艺体（墨迹占比 0.41、字高 47px）行距极小，
        # 核心带间距只有 13px，而 min_gap = med*0.5 高达 22.5px，
        # 旧逻辑把两行粘成 119px 一段 → 整行 OCR 读两行叠字只给 0.503
        # 的乱码 → 字体比对拿乱码渲染，推成 Gabriola/Javanese 一堆噪声。
        # 实测加这条：超粗稿 1 段→2 段（0.883 / 0.894 两行全对，
        # 字体归位到华文琥珀 0.9911），其余 23 张历史图分段完全不变。
        both_tall = (prev[1] - prev[0]) >= med * 0.6 and (b - a) >= med * 0.6
        hard_split = both_tall and longest_zero(prev[1], a) >= 4

        if (not hard_split) and (a - prev[1]) < min_gap:
            prev[1] = b
        else:
            merged.append([a, b])
    if len(merged) <= 1:
        return [[0, len(proj)]]

    out = []
    prev = 0
    for i in range(len(merged) - 1):
        mid = int((merged[i][1] + merged[i + 1][0]) // 2)
        out.append([prev, mid])
        prev = mid
    out.append([prev, len(proj)])
    return out


def find_row_bands(small):
    """从渲染位图的 y 投影里找出「行分界」，返回 [[t, b], ...]。

    两级策略：第一级按「严格连续墨迹段」切，第二级才回到核心带阈值。

    **为什么第一级优先**：行与行之间哪怕行距再紧，y 投影上也总有一段近乎全白的
    间隔；而一行内部从大写上伸 → x-height 主体 → 下伸，投影始终 > 0。
    所以 proj > 0 的连续段天然就是行，且**不受各行墨量差异影响**。

    **第二级为什么必须退居兜底**：核心带的 15% 阈值是全局唯一的，隐含假设
    「所有行的墨量在同一量级」。用户 FD-20261118-174711 的稿子直接推翻了它 ——
      第一行 40+ 字符、投影峰值 1337
      第二行只有 "210±10°C."、峰值 133（= 10%）
    15% 阈值 = 200.5，第二行**整行一个像素都没进 strong**；同时第一行内部被切成
    [41,45][48,50][60,112] 三片碎片，median 被拉到 4、min_gap 只剩 5，于是 9px
    的间隔就过了关 → 分界落在 55，把第一行从腰上劈开。后果是连锁的：
      上带只剩字的顶部弧线 → OCR 读成 "....oo.oooo...."
      下带是「第一行下半截 + 第二行」叠字 → 读成 "2mPature ... 15UCto 210C"，
        第一行被认错、第二行整行丢失
      垃圾文本再进字体比对 → 余弦 0.2276，字体全错

    所以核心带只在「第一级只切出一段」时启用 —— 那代表行距紧到墨迹真的粘连
    （超粗字 / 紧行距），此时才需要阈值去猜行界。历史稿走的正是这条路径，
    行为保持原样。
    """
    proj = (small > 127).astype(np.uint8).sum(axis=1)
    if proj.size == 0 or int(proj.max()) == 0:
        return []

    # ---- 第一级：严格连续墨迹段 ----
    runs = []
    st = None
    for y, v in enumerate(proj):
        if v > 0:
            if st is None:
                st = y
        elif st is not None:
            runs.append([st, y - 1])
            st = None
    if st is not None:
        runs.append([st, len(proj) - 1])
    if not runs:
        return []

    # 抗锯齿常常在笔画之间留下 1~2px 的近零投影，并回去再判定
    joined = [runs[0][:]]
    for a, b in runs[1:]:
        if a - joined[-1][1] <= 2:
            joined[-1][1] = b
        else:
            joined.append([a, b])
    runs = joined

    # 碎片段（选区外框残留 / 孤立标点 / 装饰线）不单独成行。
    # 判据用「远矮于正常行」的绝对尺度：正常渲染是 4x（0.5pt = 2px），
    # 真实文字连上伸下伸也不会低于 8px；小画布按高度 3% 收缩，避免误伤。
    # 不用「相对最高段的比例」，否则矮行遇到超大字会被误并。
    # 误差方向是安全的 —— 误判只会把两段并成一条更宽的带，不会把一行劈开。
    frag_h = max(4.0, min(8.0, len(proj) * 0.03))
    if len(runs) >= 2:
        kept = []
        carry = None
        for a, b in runs:
            if (b - a + 1) < frag_h:
                if kept:
                    kept[-1][1] = b
                else:
                    carry = a
                continue
            if carry is not None:
                a = carry
                carry = None
            if kept and a - kept[-1][1] <= 2:
                kept[-1][1] = b
            else:
                kept.append([a, b])
        if kept:
            runs = kept

    if len(runs) <= 1:
        return _bands_by_cores(proj)

    out = []
    prev = 0
    for i in range(len(runs) - 1):
        mid = int((runs[i][1] + runs[i + 1][0]) // 2)
        out.append([prev, mid])
        prev = mid
    out.append([prev, len(proj)])
    return out


def estimate_skew(shapes):
    """从锚点的 PCA 主方向估整体倾斜角（度，-45~45），返回 (角度, 主轴轴比)。

    只用锚点、不用控制柄：控制柄会按单个笔画的方向拉偏协方差。
    守卫必须严 —— 实测一份斜体稿基线微斜 -2.2°（轴比 347），
    18 行俄语长文主轴 7.7° 但轴比只有 2.3，两者都不是整体旋转，
    误摆正反而会破坏已验证的结果。只有「|角| >= 5° 且轴比 >= 4」
    且轮廓数 >= 8 才启用摆正，其余完全走原路径（历史稿零影响）。
    """
    pts = []
    for sh in shapes or []:
        for flat in sh.get("p") or []:
            for k in range(len(flat) // 6):
                pts.append((flat[k * 6], flat[k * 6 + 1]))
    if len(pts) < 12:
        return 0.0, 0.0
    P = np.asarray(pts, dtype=np.float64)
    C = np.cov(P.T)
    vals, vecs = np.linalg.eigh(C)
    v = vecs[:, int(np.argmax(vals))]
    a = math.degrees(math.atan2(v[1], v[0]))
    while a > 45:
        a -= 90
    while a <= -45:
        a += 90
    ratio = float(vals.max() / max(vals.min(), 1e-9))
    return a, ratio


def rotate_geometry(shapes, w, h, deg, pad=10):
    """绕原始画布中心把几何点旋转 -deg（摆正），重算画布并平移到正坐标。

    锚点和 in/out 控制柄一起转，贝塞尔形状才不会变形。
    返回 (新 shapes, W2, H2, inv)。inv 给 Node 侧把摆正画布的像素框
    逆变换回原始画布坐标：
        p_orig = R(deg) @ (p_straight - D - C) + C
    """
    cx, cy = w / 2.0, h / 2.0
    th = math.radians(-deg)
    co, si = math.cos(th), math.sin(th)
    out, xs, ys = [], [], []
    for sh in shapes or []:
        pp = []
        for flat in sh.get("p") or []:
            nf = []
            for k in range(0, len(flat) - 5, 6):
                for o in (0, 2, 4):  # ax,ay / ix,iy / ox,oy
                    x, y = flat[k + o] - cx, flat[k + o + 1] - cy
                    nf.extend([co * x - si * y + cx, si * x + co * y + cy])
            for k in range(0, len(nf), 2):
                xs.append(nf[k])
                ys.append(nf[k + 1])
            pp.append(nf)
        out.append({"c": sh.get("c", 1), "p": pp})

    if not xs:
        return shapes, w, h, None
    dx, dy = pad - min(xs), pad - min(ys)
    for sh in out:
        for flat in sh["p"]:
            for k in range(0, len(flat), 2):
                flat[k] += dx
                flat[k + 1] += dy
    W2 = int(math.ceil(max(xs) + dx + pad))
    H2 = int(math.ceil(max(ys) + dy + pad))
    inv = {
        "angle": round(float(deg), 3),
        "cx": cx,
        "cy": cy,
        "dx": dx,
        "dy": dy,
        "w0": int(w),
        "h0": int(h),
    }
    return out, W2, H2, inv


def split_line_gaps(png_path, box, n, pad=2):
    """把一行按**墨迹空隙**切成 n 段。

    为什么不让算法自己判断「哪里换了字体/字号」：
    实测这批转曲稿做不到。单一样式稿的笔画宽度只有 2px，字重差异就是
    ±1px，跟栅格化噪声同量级；同一行字框高度波动可达 ±40%（大小写、
    标点主导）；整行渲染比对又会因字距漂移整体对不齐。三条路都验证过，
    区分度不够，硬切必然误伤（详见 docs/engineering-review-2026-11-17.md）。

    所以做成**可控拆分**：用户说「这行有 2 套样式」，系统在接近 1/2 处
    找**真实的空白列**切开。空白列一定存在（词间、标点旁），因此切出来
    的每一段都是完整字形，绝不会切断笔画 —— 这比任何自动检测都可靠。

    返回绝对像素框列表，每段的上下界取该段自身的墨迹范围（字号不同时
    段高自然不同，恢复时字号才准）。
    """
    img = cv2.imread(png_path, cv2.IMREAD_GRAYSCALE)
    if img is None:
        return []

    H, W = img.shape[:2]
    try:
        l, t, r, b = [int(round(float(v))) for v in box[:4]]
    except Exception:  # noqa: BLE001
        return []
    l, t = max(0, l), max(0, t)
    r, b = min(W, r), min(H, b)
    if r - l < 4 or b - t < 4:
        return []

    crop = img[t:b, l:r]
    ink = crop < 128
    # 反相稿（白字黑底）也要能切
    if float(ink.mean()) > 0.5:
        ink = ~ink

    col = ink.sum(axis=0)
    width = int(col.size)
    n = max(2, min(8, int(n)))

    # 所有「全零列」区间，行首行尾的空白不算可用切点
    gaps = []
    st = None
    for x in range(width):
        if col[x] == 0:
            if st is None:
                st = x
        elif st is not None:
            gaps.append((st, x))
            st = None
    if st is not None:
        gaps.append((st, width))
    usable = [(a, z) for a, z in gaps if a > 0 and z < width]

    cuts = []
    used: list = []
    for i in range(1, n):
        target = width * i / float(n)
        if usable:
            # 只认「离目标不远」的空白，然后在里面挑**最宽**的。
            # 必须挑最宽：字母之间也是全零列，按"离目标最近"会切进单词里
            # （实测把 Welltop 切成 Wellt|op）。词距一定宽于字母距，所以
            # 「窗口内最宽空白」永远落在词界/标点旁。
            near = [
                g for g in usable
                if abs((g[0] + g[1]) / 2.0 - target) <= max(12.0, width * 0.40)
            ]
            pool = near if near else usable
            # 多刀时避免两刀落进同一处空白
            pool = [
                g for g in pool
                if all(
                    abs((g[0] + g[1]) / 2.0 - (u[0] + u[1]) / 2.0)
                    > max(6.0, width * 0.03)
                    for u in used
                )
            ]
            if not pool:
                continue
            # 宽度主导、距离为辅：只按距离会切进单词（字母间也是空白），
            # 只按宽度会切到离目标很远的大空档。两项加权既保证落在词界，
            # 又保证位置大致居中。
            widest = max(g[1] - g[0] for g in pool) or 1.0
            a, z = max(
                pool,
                key=lambda g: (g[1] - g[0]) / widest
                - 0.6 * abs((g[0] + g[1]) / 2.0 - target) / float(width),
            )
            used.append((a, z))
            cuts.append((a, z))
        else:
            # 没有空隙（整行粘连）：退到「墨迹最少的那一列」硬切，
            # 并在返回值里标 degraded，让面板知道这次切得不准
            lo = max(1, int(target) - 4)
            hi = min(width - 1, int(target) + 5)
            if hi <= lo:
                lo, hi = 1, width - 1
            x = lo + int(np.argmin(col[lo:hi])) if hi > lo else int(target)
            x = max(1, min(width - 1, x))
            cuts.append((x, x))

    cuts.sort()
    # 去掉重叠切点（同一处空白被选中两次）
    uniq = []
    for a, z in cuts:
        if uniq and a < uniq[-1][1]:
            continue
        uniq.append((a, z))
    cuts = uniq
    if not cuts:
        return []

    bounds = [0]
    for a, z in cuts:
        bounds.append(int((a + z) // 2))
    bounds.append(width)

    out = []
    rows_all = np.nonzero(ink.any(axis=1))[0]
    line_h = int(rows_all.max() - rows_all.min() + 1) if len(rows_all) else 0
    for i in range(len(bounds) - 1):
        x0, x1 = bounds[i], bounds[i + 1]
        if x1 - x0 < 2:
            continue
        sub = ink[:, x0:x1]
        # 段首若挂着圆点/项目符号，先把图裁掉：否则这一段恢复出来的文字
        # 会从符号位置起排，整段左移一个符号宽（实测约 2pt）
        dx = _lead_symbol_cut(sub, line_h)
        if dx > 0:
            sub = sub[:, dx:]
            x0 += dx
        ys = np.nonzero(sub.any(axis=1))[0]
        if len(ys) == 0:
            continue
        out.append({
            "l": l + x0,
            "t": t + int(ys.min()),
            "r": l + x1,
            "b": t + int(ys.max()) + 1,
        })
    return out


def render_geometry(shapes, w: int, h: int, out_path: str, ss: int = 3) -> dict:
    """按 Illustrator 回传的路径几何自己画一张位图。

    这一步替代了原先「让 AI 导出 PNG」的做法。那个做法在真实文档上会卡死：
    doc.exportFile 配临时画板，导出期间 UI 线程被占住，evalScript 的回调
    永远不回来（面板停在「正在读取选区」）。自己画没有这个风险，也不会改
    用户文档（不用增删画板）。

    填充规则用 even-odd（子路径累加按位异或）：转曲文字的「口」「日」这类
    内外轮廓天然是奇偶关系，实测与 Illustrator 显示一致。
    先按 ss 倍超采样再缩回，得到接近真实渲染的抗锯齿边缘，OCR 更稳。
    """
    W, H = int(w), int(h)
    if W <= 0 or H <= 0:
        raise ValueError("画布尺寸非法")

    # 倾斜稿摆正。旋转的是几何点而不是位图：没有插值损失，控制柄也一起转，
    # 贝塞尔形状不变形。小角度/主轴不可靠时 skew 保持 None，走原路径。
    angle, ratio = estimate_skew(shapes)
    skew = None
    if abs(angle) >= 5.0 and ratio >= 4.0 and len(shapes) >= 8:
        shapes, W, H, skew = rotate_geometry(shapes, W, H, angle)

    ss = max(1, min(4, int(ss)))
    bw, bh = W * ss, H * ss
    canvas = np.zeros((bh, bw), dtype=np.uint8)
    boxes = []

    for sh in shapes or []:
        subs = sh.get("p") or []
        closed = bool(sh.get("c", 1))
        polys = []
        for flat in subs:
            poly = flatten_shape(flat, ss, closed)
            if poly is not None:
                polys.append(poly)

        if not polys:
            boxes.append([0, 0, 0, 0])
            continue

        # 只在自己的包围盒里画。
        # 早先每条轮廓都分配整幅画布大小的缓冲（4 倍分辨率下，
        # 18 行俄语稿会累计分配几十 GB），大稿直接跑不出来。
        xs_all = [float(p[0][0]) for poly in polys for p in poly]
        ys_all = [float(p[0][1]) for poly in polys for p in poly]
        x0 = max(0, int(min(xs_all)))
        x1 = min(bw, int(max(xs_all)) + 1)
        y0 = max(0, int(min(ys_all)))
        y1 = min(bh, int(max(ys_all)) + 1)
        if x1 <= x0 or y1 <= y0:
            boxes.append([0, 0, 0, 0])
            continue

        acc = np.zeros((y1 - y0, x1 - x0), dtype=np.uint8)
        for poly in polys:
            local = poly.copy()
            local[:, 0, 0] -= x0
            local[:, 0, 1] -= y0
            mask = np.zeros_like(acc)
            cv2.fillPoly(mask, [local], 1)
            acc ^= mask

        canvas[y0:y1, x0:x1] |= acc

        ys, xs = np.nonzero(acc)
        if len(ys) == 0:
            boxes.append([0, 0, 0, 0])
        else:
            boxes.append(
                [
                    (x0 + int(xs.min())) // ss,
                    (y0 + int(ys.min())) // ss,
                    (x0 + int(xs.max())) // ss + 1,
                    (y0 + int(ys.max())) // ss + 1,
                ]
            )

    small = cv2.resize(canvas * 255, (W, H), interpolation=cv2.INTER_AREA)
    img = 255 - small  # 白底黑字：OCR 与向量化都按这个口径
    if not cv2.imwrite(out_path, img):
        raise RuntimeError("位图写入失败：%s" % out_path)

    ink = int((small > 127).sum())
    return {
        "png": out_path,
        "w": W,
        "h": H,
        "ss": ss,
        "shapes": boxes,
        "bands": find_row_bands(small),
        "skew": skew,
        "inkRatio": round(ink / float(W * H), 4) if W * H else 0.0,
    }


def main() -> int:
    out = sys.stdout
    # Windows 下不显式指定编码，中文会按 GBK 输出，Node 侧读成乱码
    try:
        sys.stdin.reconfigure(encoding="utf-8")
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass

    try:
        engine = get_engine("zh")
    except Exception as e:  # noqa: BLE001
        out.write(json.dumps({"id": 0, "error": "engine_init_failed: %s" % e}) + "\n")
        out.flush()
        return 1

    out.write(
        json.dumps(
            {
                "id": 0,
                "ready": True,
                "engine": "rapidocr",
                "lang": "zh+en",
                "ruModel": ru_available(),
            },
            ensure_ascii=False,
        )
        + "\n"
    )
    out.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            req = json.loads(line)
        except Exception:  # noqa: BLE001
            out.write(
                json.dumps({"id": None, "error": "bad_json"}, ensure_ascii=False)
                + "\n"
            )
            out.flush()
            continue

        rid = req.get("id")

        if req.get("cmd") == "ping":
            out.write(json.dumps({"id": rid, "ok": True, "ready": True}) + "\n")
            out.flush()
            continue

        try:
            if req.get("cmd") == "render":
                info = render_geometry(
                    req.get("shapes") or [],
                    int(req.get("w", 0)),
                    int(req.get("h", 0)),
                    req["out"],
                    int(req.get("ss", 3)),
                )
                results = [info]
            elif req.get("cmd") == "flipcheck":
                # 低置信度自检：整块文字可能被旋转了 180°（印刷拼版 / 反面
                # 印刷稿常见）。这里只做**检测**，不自动摆正、不改主链路的
                # 任何识别结果 —— 任意角度的旋转摆正是冻结项，不在此列。
                #
                # 180° 是精确的中心对称，框的逆变换 [W-r, H-b, W-l, H-t]
                # 没有浮点误差；实测一份倒转说明书稿：原图 OCR 平均 0.176
                # （"areeaase"），翻正后 0.933（完整两句英文）。
                img = cv2.imread(req["png"], cv2.IMREAD_GRAYSCALE)
                if img is None:
                    results = [{"lines": [], "avg": 0.0, "png": ""}]
                else:
                    H, W = img.shape[:2]
                    out_png = req["out"]
                    cv2.imwrite(out_png, cv2.rotate(img, cv2.ROTATE_180))
                    boxes = []
                    for b in (req.get("boxes") or []):
                        try:
                            l, t, r, bo = [float(v) for v in b[:4]]
                        except Exception:  # noqa: BLE001
                            continue
                        boxes.append([W - r, H - bo, W - l, H - t])
                    # 翻正后上下行互换，按 y 重排，文本顺序才跟视觉一致
                    boxes.sort(key=lambda x: x[1])
                    res = recognize_lines(engine, out_png, boxes, 3)
                    results = [{
                        "lines": res,
                        "avg": avg_score(res),
                        "png": out_png,
                        "w": W,
                        "h": H,
                    }]
            elif req.get("cmd") == "splitline":
                # 按墨迹空隙把一行拆成 n 段（用户指定段数，系统只负责找
                # 真实空白处下刀）。不改动任何识别逻辑，纯几何。
                results = [{
                    "segments": split_line_gaps(
                        req["png"],
                        req.get("box") or [0, 0, 0, 0],
                        int(req.get("n") or 2),
                    )
                }]
            elif req.get("cmd") == "metrics":
                # 字体垂直度量 + 这行字在该字体下的实际墨迹底。
                # 恢复时用来把 AI 的「行框底」换算成「墨迹底」，
                # 否则整行会按 descender 的高度上移（换字体偏移量就变）。
                text = req.get("text") or ""
                out_items = []
                for it in req.get("fonts") or []:
                    fp = str(it[0])
                    fi = int(it[1] or 0)
                    m = font_metrics(fp, fi)
                    out_items.append({
                        "path": fp,
                        "index": fi,
                        "descent": m["descent"],
                        "inkBottom": measure_ink_bottom(fp, text, fi),
                    })
                results = [{"metrics": out_items}]
            elif req.get("cmd") == "linefont":
                # 新版面板传 targets（多行）；旧版只传 box/text，这里包成单目标
                targets = req.get("targets")
                if not targets:
                    targets = [{
                        "box": req.get("box"),
                        "text": str(req.get("text") or ""),
                        "weight": 1.0,
                    }]
                scores = compare_line_fonts(
                    req["png"],
                    targets,
                    req.get("candidates") or [],
                    req.get("slices"),
                )
                results = [{"scores": scores}]
            elif req.get("cmd") == "line":
                boxes = req.get("boxes") or []
                pad = int(req.get("pad", 3))
                results = recognize_lines(engine, req["png"], boxes, pad)

                # 自动语种切换：中英模型不认西里尔字母，会把俄语按字形凑成
                # 拉丁+数字。整篇平均分偏低时用东斯拉夫模型重跑一遍，
                # 按「整篇」投票而不是逐行挑最高分，避免把两种语种的结果
                # 混进同一段文字。中文稿不会被接管（西里尔占比门槛）。
                try:
                    if ru_available() and avg_score(results) < 0.86:
                        alt = recognize_lines(get_engine("ru"), req["png"], boxes, pad)
                        if (
                            avg_score(alt) > avg_score(results) + 0.05
                            and cyrillic_ratio(alt) > 0.12
                        ):
                            for item in alt:
                                item["engine"] = "ru"
                            results = alt
                except Exception:  # noqa: BLE001
                    # 俄语模型损坏 / 加载失败时静默退回中英结果，别让整条链路失败
                    pass
            elif req.get("cmd") == "vector":
                vecs = vectors_for(
                    engine, req["png"], req.get("boxes") or [], int(req.get("pad", 3))
                )
                results = [{"vector": v} for v in vecs]
            elif "png" in req:
                results = recognize_crops(
                    engine,
                    req["png"],
                    req.get("boxes") or [],
                    int(req.get("pad", 3)),
                    req.get("dump", ""),
                )
            else:
                results = [
                    recognize_b64(engine, b64) for b64 in (req.get("items") or [])
                ]
        except Exception as e:  # noqa: BLE001
            out.write(
                json.dumps(
                    {"id": rid, "error": "batch_failed: %s" % e}, ensure_ascii=False
                )
                + "\n"
            )
            out.flush()
            continue

        out.write(
            json.dumps({"id": rid, "results": results}, ensure_ascii=False) + "\n"
        )
        out.flush()

    return 0


if __name__ == "__main__":
    sys.exit(main())
