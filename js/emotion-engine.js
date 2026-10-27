/**
 * emotion-engine.js —— 本地人脸情绪识别引擎
 * ============================================================
 * 双通道情绪识别算法（全部在浏览器本地完成，不上传任何画面）
 *
 *   通道 A：CNN 表情分类
 *     使用 face-api.js 的 FaceExpressionNet（基于 ResNet 的表情分类网络），
 *     对对齐后的人脸区域输出 7 类情绪的 softmax 概率。
 *
 *   通道 B：面部几何特征分析
 *     使用 68 点人脸关键点，测量「嘴角曲率、嘴巴张开度、眉毛倾斜、
 *     眉毛高度、眼睛纵横比(EAR)」等客观几何量，再按情绪学规则映射为
 *     7 类情绪的几何证据分数。
 *
 *   融合：P = w_cnn * P_cnn + w_geo * P_geo
 *     权重随 CNN 置信度自适应：CNN 越不确定，几何证据权重越高。
 *
 *   时间平滑：对最近 N 帧的概率向量做指数加权平均，并用迟滞锁
 *     (hysteresis) 防止主情绪在相邻帧之间来回抖动。
 *
 *   输出：7 类概率 + 主情绪 + 置信度 + 二维情感坐标 (valence, arousal)
 * ============================================================
 */
(function (global) {
  'use strict';

  /** 7 类情绪的元数据：中文名 / 颜色 / 图标 / 情感二维坐标 */
  const EMOTION_META = {
    neutral:   { cn: '平静', color: '#38BDF8', icon: '😐', valence: 0.50, arousal: 0.35 },
    happy:     { cn: '开心', color: '#FBBF24', icon: '😄', valence: 0.92, arousal: 0.76 },
    sad:       { cn: '悲伤', color: '#60A5FA', icon: '😢', valence: 0.14, arousal: 0.28 },
    angry:     { cn: '愤怒', color: '#F43F5E', icon: '😠', valence: 0.22, arousal: 0.94 },
    fearful:   { cn: '恐惧', color: '#A78BFA', icon: '😨', valence: 0.16, arousal: 0.72 },
    disgusted: { cn: '厌恶', color: '#84CC16', icon: '🤢', valence: 0.20, arousal: 0.60 },
    surprised: { cn: '惊讶', color: '#FB923C', icon: '😲', valence: 0.66, arousal: 0.90 },
  };
  const EMOTIONS = Object.keys(EMOTION_META);

  /** 把数值 x 从区间 [lo, hi] 线性归一化到 [0, 1]（超出则截断） */
  function ramp(x, lo, hi) {
    if (hi === lo) return 0;
    const v = (x - lo) / (hi - lo);
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }
  const lerp = (a, b, t) => a + (b - a) * t;

  class EmotionEngine {
    /**
     * @param {string} modelBase 模型目录（默认 'models'）
     */
    constructor(modelBase) {
      this.modelBase = modelBase || 'models';
      this.ready = false;
      this.loading = false;

      // ---- 时间平滑参数 ----
      this.windowSize = 14;      // 参与平滑的帧数
      this.decay = 5.0;          // 指数衰减系数（越小越看重历史）
      this.buffer = [];          // [{ probs: Float32Array, t: number }]

      // ---- 迟滞锁定参数 ----
      this.stableEmotion = null; // 当前锁定的主情绪
      this.pendingEmotion = null;
      this.pendingCount = 0;
      this.switchRatio = 1.18;   // 新手必须比当前主情绪高 18% 才切换
      this.switchFrames = 3;     // 且需连续 3 帧成立

      this.lastResult = null;
    }

    /** 加载三个本地模型（检测 / 关键点 / 表情） */
    async load(onProgress) {
      if (this.ready || this.loading) return this.ready;
      if (!global.faceapi) throw new Error('face-api.js 未加载');
      this.loading = true;
      const fa = global.faceapi;
      const steps = [
        ['加载人脸检测模型 TinyFaceDetector', () => fa.nets.tinyFaceDetector.loadFromUri(this.modelBase)],
        ['加载 68 点关键点模型', () => fa.nets.faceLandmark68Net.loadFromUri(this.modelBase)],
        ['加载表情分类模型 FaceExpressionNet', () => fa.nets.faceExpressionNet.loadFromUri(this.modelBase)],
      ];
      for (let i = 0; i < steps.length; i++) {
        if (onProgress) onProgress({ step: i, total: steps.length, text: steps[i][0] });
        await steps[i][1]();
      }
      this.ready = true;
      this.loading = false;
      return true;
    }

    /**
     * 对一帧画面做一次识别
     * @param {HTMLVideoElement|HTMLImageElement|HTMLCanvasElement} input
     * @param {object} opts { detectEvery: 是否只检测不识别? , inputSize }
     * @returns {Promise<object|null>}
     */
    async detect(input, opts) {
      if (!this.ready) throw new Error('模型尚未加载完成');
      opts = opts || {};
      const fa = global.faceapi;
      const options = new fa.TinyFaceDetectorOptions({
        inputSize: opts.inputSize || 320,
        scoreThreshold: 0.35,
      });

      // 用 detectAllFaces 而不是 detectSingleFace：
      // 多人画面里 detectSingleFace 只取置信度最高的一张，容易选到画面边缘
      // 被裁掉半张的脸。这里按「面积大 + 靠近画面中心」重新挑主角。
      const faces = await fa
        .detectAllFaces(input, options)
        .withFaceLandmarks()
        .withFaceExpressions();

      if (!faces || !faces.length) {
        // 没检测到人脸：衰减历史缓冲，避免旧情绪一直挂着
        this._decayBuffer();
        return null;
      }
      const result = this._pickMainFace(faces, input);

      const cnnProbs = result.expressions;                 // 通道 A
      const geoProbs = this._geometryScores(result.landmarks); // 通道 B
      const fused = this._fuse(cnnProbs, geoProbs);        // 融合

      const raw = this._toObject(fused);
      const useSmooth = opts.smooth !== false;
      const smoothed = useSmooth ? this._smooth(fused) : fused;

      // 连续识别（摄像头/视频）走迟滞，避免主情绪抖动；
      // 单帧识别（图片/拍照）直接取最大概率，否则会被上一次的锁定值拖住
      let stable;
      if (useSmooth) {
        stable = this._hysteresis(smoothed);
      } else {
        let best = 0;
        for (let i = 1; i < smoothed.length; i++) if (smoothed[i] > smoothed[best]) best = i;
        stable = EMOTIONS[best];
      }

      const out = {
        probs: this._toObject(smoothed),
        rawProbs: raw,
        emotion: stable,
        confidence: smoothed[EMOTIONS.indexOf(stable)],
        valence: 0,
        arousal: 0,
        box: result.detection.box,
        landmarks: result.landmarks.positions,
        score: result.detection.score,
        features: this._lastFeatures,
        weights: this._lastWeights,
      };
      for (const k of EMOTIONS) {
        out.valence += smoothed[EMOTIONS.indexOf(k)] * EMOTION_META[k].valence;
        out.arousal += smoothed[EMOTIONS.indexOf(k)] * EMOTION_META[k].arousal;
      }
      this.lastResult = out;
      return out;
    }

    /** 重置所有时序状态（切换输入源时调用） */
    reset() {
      this.buffer.length = 0;
      this.stableEmotion = null;
      this.pendingEmotion = null;
      this.pendingCount = 0;
      this.lastResult = null;
    }

    /**
     * 从多张人脸中挑选「主角」：
     *   得分 = 归一化面积 × (0.55 + 0.45 × 中心贴近度) × 检测置信度
     * 这样既偏向大脸（离镜头近、像素多、识别更准），
     * 又不会把画面边缘被裁掉半张的脸当成主角。
     */
    _pickMainFace(faces, input) {
      if (faces.length === 1) return faces[0];
      const W = input.videoWidth || input.naturalWidth || input.clientWidth || 1;
      const H = input.videoHeight || input.naturalHeight || input.clientHeight || 1;
      const cx = W / 2, cy = H / 2;
      const halfDiag = Math.hypot(cx, cy) || 1;

      let best = faces[0];
      let bestScore = -Infinity;
      for (const f of faces) {
        const b = f.detection.box;
        const areaRatio = (b.width * b.height) / (W * H);
        const dist = Math.hypot(b.x + b.width / 2 - cx, b.y + b.height / 2 - cy) / halfDiag;
        const centerScore = Math.max(0, 1 - dist);
        const score = areaRatio * (0.55 + 0.45 * centerScore) * (f.detection.score || 0.5);
        if (score > bestScore) { bestScore = score; best = f; }
      }
      return best;
    }

    // ========================================================
    // 通道 B：几何特征 → 情绪证据
    // ========================================================
    /**
     * 68 点索引（iBUG 300-W 标准）：
     *   0-16 轮廓 | 17-21 右眉 | 22-26 左眉 | 27-35 鼻子
     *   36-41 右眼 | 42-47 左眼 | 48-59 外唇 | 60-67 内唇
     */
    _geometryScores(landmarks) {
      const p = landmarks.positions;
      const pt = (i) => p[i];

      // --- 人脸尺度基准：用两眼中心距离 + 脸高，做尺度归一化 ---
      const eyeCenterY = (pt(36).y + pt(45).y) / 2;
      const eyeDist = Math.hypot(pt(45).x - pt(36).x, pt(45).y - pt(36).y) || 1;
      const faceH = Math.abs(pt(8).y - pt(27).y) || eyeDist * 2.2;

      // --- 1) 嘴角曲率：嘴角比唇中点高 = 上扬（y 轴向下）---
      const mouthCornerY = (pt(48).y + pt(54).y) / 2;
      const lipMidY = (pt(51).y + pt(57).y) / 2;
      const mouthCurve = (lipMidY - mouthCornerY) / faceH;   // >0 上扬

      // --- 2) 嘴巴张开度：内唇上下间距 ---
      const mouthOpen = Math.abs(pt(66).y - pt(62).y) / faceH;

      // --- 3) 嘴巴横向拉伸 ---
      const mouthWide = Math.abs(pt(54).x - pt(48).x) / eyeDist;

      // --- 4) 眉毛倾斜：内眉端相对外眉端的高度差 ---
      const browInnerY = (pt(21).y + pt(22).y) / 2;
      const browOuterY = (pt(17).y + pt(26).y) / 2;
      const browSlant = (browInnerY - browOuterY) / faceH;   // >0 内端更低 = 皱眉

      // --- 5) 眉毛高度：眉到眼中心的距离（惊讶时抬高）---
      const browRaise = (eyeCenterY - browInnerY) / faceH;

      // --- 6) 眼睛纵横比 EAR：眼睛睁大的程度 ---
      const earR = (Math.hypot(pt(37).x - pt(41).x, pt(37).y - pt(41).y) +
                    Math.hypot(pt(38).x - pt(40).x, pt(38).y - pt(40).y)) /
                   (2 * (Math.hypot(pt(36).x - pt(39).x, pt(36).y - pt(39).y) || 1));
      const earL = (Math.hypot(pt(43).x - pt(47).x, pt(43).y - pt(47).y) +
                    Math.hypot(pt(44).x - pt(46).x, pt(44).y - pt(46).y)) /
                   (2 * (Math.hypot(pt(42).x - pt(45).x, pt(42).y - pt(45).y) || 1));
      const ear = (earR + earL) / 2;

      // --- 7) 上唇上提（厌恶时上唇向上扯）---
      const upperLipRaise = (pt(51).y - pt(62).y) / faceH;

      const f = { mouthCurve, mouthOpen, mouthWide, browSlant, browRaise, ear, upperLipRaise };
      this._lastFeatures = f;

      // --- 规则映射：几何量 → 各情绪的证据分（0~1）---
      const g = {};
      // 开心：嘴角明显上扬，嘴巴轻张
      g.happy = 0.62 * ramp(mouthCurve, 0.002, 0.016) +
                0.24 * ramp(mouthOpen, 0.004, 0.05) +
                0.14 * ramp(mouthWide, 0.42, 0.62);
      // 悲伤：嘴角下垂，内眉上扬（八字眉），眼睛略闭
      g.sad = 0.52 * ramp(-mouthCurve, 0.001, 0.012) +
              0.30 * ramp(-browSlant, 0.004, 0.02) +
              0.18 * ramp(0.30 - ear, 0.0, 0.10);
      // 愤怒：皱眉（内端下压）+ 眼裂变窄 + 嘴角下拉
      g.angry = 0.46 * ramp(browSlant, 0.003, 0.018) +
                0.30 * ramp(0.30 - ear, 0.0, 0.09) +
                0.24 * ramp(-mouthCurve, 0.0005, 0.008);
      // 惊讶：嘴大张 + 眉毛抬高 + 眼睛睁大
      g.surprised = 0.42 * ramp(mouthOpen, 0.028, 0.075) +
                    0.30 * ramp(browRaise, 0.055, 0.085) +
                    0.28 * ramp(ear, 0.29, 0.42);
      // 恐惧：眼大 + 眉高 + 嘴角后扯（介于惊讶与悲伤之间）
      g.fearful = 0.36 * ramp(ear, 0.28, 0.40) +
                  0.32 * ramp(browRaise, 0.052, 0.080) +
                  0.18 * ramp(mouthWide, 0.44, 0.62) +
                  0.14 * ramp(-mouthCurve, 0.0, 0.006);
      // 厌恶：上唇上提 + 皱眉，嘴张开度小
      g.disgusted = 0.50 * ramp(upperLipRaise, 0.006, 0.022) +
                    0.30 * ramp(browSlant, 0.002, 0.014) +
                    0.20 * (1 - ramp(mouthOpen, 0.01, 0.06));
      // 平静：所有强特征都不明显
      const peak = Math.max(g.happy, g.sad, g.angry, g.surprised, g.fearful, g.disgusted);
      g.neutral = 0.55 + 0.45 * (1 - Math.min(1, peak * 2.2));

      // 归一化为概率向量
      let sum = 0;
      for (const k of EMOTIONS) { g[k] = Math.max(1e-4, g[k]); sum += g[k]; }
      const vec = new Float32Array(EMOTIONS.length);
      EMOTIONS.forEach((k, i) => { vec[i] = g[k] / sum; });
      return vec;
    }

    // ========================================================
    // 融合通道 A + B
    // ========================================================
    _fuse(expressions, geoProbs) {
      const cnn = new Float32Array(EMOTIONS.length);
      let maxCnn = 0;
      EMOTIONS.forEach((k, i) => {
        // face-api 的 key 与我们的 key 完全一致
        cnn[i] = expressions[k] || 0;
        if (cnn[i] > maxCnn) maxCnn = cnn[i];
      });
      // 自适应权重：CNN 越自信越信 CNN；CNN 模糊时几何证据补位
      const wGeo = lerp(0.42, 0.18, ramp(maxCnn, 0.35, 0.85));
      const wCnn = 1 - wGeo;

      const fused = new Float32Array(EMOTIONS.length);
      let sum = 0;
      for (let i = 0; i < EMOTIONS.length; i++) {
        fused[i] = wCnn * cnn[i] + wGeo * geoProbs[i];
        sum += fused[i];
      }
      for (let i = 0; i < fused.length; i++) fused[i] /= sum || 1;
      this._lastWeights = { cnn: wCnn, geo: wGeo };
      return fused;
    }

    // ========================================================
    // 时间平滑：指数加权滑动窗口
    // ========================================================
    _smooth(vec) {
      const now = performance.now();
      this.buffer.push({ probs: vec, t: now });
      while (this.buffer.length > this.windowSize) this.buffer.shift();

      const acc = new Float32Array(EMOTIONS.length);
      let wsum = 0;
      for (let i = 0; i < this.buffer.length; i++) {
        const age = this.buffer.length - 1 - i;             // 0 = 最新
        const w = Math.exp(-age / this.decay);              // 指数衰减
        wsum += w;
        for (let k = 0; k < acc.length; k++) acc[k] += this.buffer[i].probs[k] * w;
      }
      if (wsum > 0) for (let k = 0; k < acc.length; k++) acc[k] /= wsum;
      return acc;
    }

    _decayBuffer() {
      if (this.buffer.length) this.buffer.pop();
    }

    // ========================================================
    // 迟滞锁定：避免主情绪在阈值附近疯狂抖动
    // ========================================================
    _hysteresis(vec) {
      let best = 0;
      for (let i = 1; i < vec.length; i++) if (vec[i] > vec[best]) best = i;
      const bestKey = EMOTIONS[best];
      const bestP = vec[best];

      if (!this.stableEmotion) {
        this.stableEmotion = bestKey;
        return bestKey;
      }
      if (bestKey === this.stableEmotion) {
        this.pendingEmotion = null;
        this.pendingCount = 0;
        return this.stableEmotion;
      }

      const stableP = vec[EMOTIONS.indexOf(this.stableEmotion)];
      const strongEnough = bestP > stableP * this.switchRatio && bestP > 0.30;

      if (strongEnough && bestKey === this.pendingEmotion) {
        this.pendingCount++;
      } else if (strongEnough) {
        this.pendingEmotion = bestKey;
        this.pendingCount = 1;
      } else {
        this.pendingEmotion = null;
        this.pendingCount = 0;
      }

      if (this.pendingCount >= this.switchFrames) {
        this.stableEmotion = bestKey;
        this.pendingEmotion = null;
        this.pendingCount = 0;
      }
      return this.stableEmotion;
    }

    _toObject(vec) {
      const o = {};
      EMOTIONS.forEach((k, i) => { o[k] = vec[i]; });
      return o;
    }
  }

  global.EmotionEngine = EmotionEngine;
  global.EMOTION_META = EMOTION_META;
  global.EMOTION_KEYS = EMOTIONS;
})(window);
